// Read-only migration of the fixed-width OptMem store. Preserve the exact
// bytes as well as parsed notes: provenance and verification survive refits.
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { Archive, digest } from "./archive.ts"
import { LOG_REC, SCOPE_REC, TREE_REC } from "./store.ts"

export interface MigrationReport {
  store: string
  notes: number
  summaries: number
  records: number
  verified: boolean
}

export function migrateOptMem(archive: Archive, directory: string): MigrationReport {
  const store = digest(resolve(directory)).slice(0, 24)
  const log = readFileSync(join(directory, "LOG.txt"))
  if (log.length % LOG_REC !== 0) throw new Error("OptMem log contains an incomplete record; migration refused")

  const scopeFile = join(directory, "SCOPE.txt")
  const scopes = existsSync(scopeFile) ? readFileSync(scopeFile) : Buffer.alloc(0)
  if (scopes.length % SCOPE_REC !== 0) throw new Error("OptMem scopes contain an incomplete record; migration refused")
  const count = log.length / LOG_REC
  const records: Array<{kind: string; id: string; bytes: Buffer}> = []
  records.push({kind: "sidecar", id: "LOG.txt", bytes: log})
  let summaries = 0

  for (let id = 0; id < count; id++) {
    const bytes = log.subarray(id * LOG_REC, (id + 1) * LOG_REC)
    const match = /^#(\d+) (\d{4}-\d{2}-\d{2}) (.*)$/s.exec(bytes.toString("utf8").trimEnd())
    if (!match || Number(match[1]) !== id) throw new Error(`Invalid OptMem note #${id}`)

    records.push({ kind: "note", id: String(id), bytes })
  }
  // Preserve the original sidecars verbatim, including unclassified records.
  for (const name of ["SCOPE.txt", "scopes.json", "config"]) {
    const file = join(directory, name)
    if (existsSync(file)) records.push({ kind: "sidecar", id: name, bytes: readFileSync(file) })
  }
  const tree = join(directory, "TREE")
  if (existsSync(tree)) {
    for (const name of readdirSync(tree).sort()) {
      const size = Number(name)
      if (!Number.isSafeInteger(size) || size < 2 || (size & (size - 1)) !== 0) continue

      const bytes = readFileSync(join(tree, name))
      if (bytes.length % TREE_REC !== 0) throw new Error(`Incomplete TREE/${name}; migration refused`)

      for (let index = 0; index < bytes.length / TREE_REC; index++) {
        records.push({ kind: "summary", id: `${index * size}-${(index + 1) * size - 1}`, bytes: bytes.subarray(index * TREE_REC, (index + 1) * TREE_REC) })
        summaries++
      }
    }
  }

  archive.db.transaction(() => {
    const registryBytes = records.find(record => record.id === "scopes.json")?.bytes
    if (registryBytes) {
      const registry: unknown = JSON.parse(registryBytes.toString("utf8"))
      if (!registry || typeof registry !== "object" || Array.isArray(registry)) throw new Error("Invalid scope registry")

      for (const [scope, canonical] of Object.entries(registry)) {
        if (typeof canonical !== "string" || !canonical.startsWith("/") || scope === "global" || scope === "all") throw new Error("Invalid project scope mapping")

        archive.db.query("INSERT OR IGNORE INTO projects VALUES(?,?)").run(scope, canonical)
        const saved = archive.db.query<{canonical: string}, [string]>("SELECT canonical FROM projects WHERE scope=?").get(scope)
        if (saved?.canonical !== canonical) throw new Error(`Conflicting project scope ${scope}`)
      }
    }
    for (const record of records) {
      const hash = digest(record.bytes.toString("base64"))
      const previous = archive.db.query<{hash: string}, [string,string,string]>(
        "SELECT hash FROM legacy WHERE store=? AND kind=? AND id=?",
      ).get(store, record.kind, record.id)
      // Notes are immutable. Scopes, summaries, and config are mutable caches.
      if (previous && previous.hash !== hash && record.kind === "note") throw new Error(`Migrated note #${record.id} changed`)

      archive.db.query("INSERT INTO legacy VALUES(?,?,?,?,?) ON CONFLICT(store,kind,id) DO UPDATE SET bytes=excluded.bytes,hash=excluded.hash")
        .run(store, record.kind, record.id, record.bytes, hash)
      archive.db.query("INSERT OR IGNORE INTO legacy_versions VALUES(?,?,?,?,?)")
        .run(store, record.kind, record.id, hash, record.bytes)
      if (record.kind !== "note") continue

      const id = Number(record.id)
      const match = /^#\d+ (\d{4}-\d{2}-\d{2}) (.*)$/s.exec(record.bytes.toString("utf8").trimEnd())!
      const text = match[2]!
      const scopeBytes = scopes.subarray(id * SCOPE_REC, (id + 1) * SCOPE_REC)
      const keys = scopeBytes.toString("utf8").trim().split(",").map(k => k.trim()).filter(Boolean)
      const source = `optmem:${store}:${id}`
      const at = Date.parse(`${match[1]}T00:00:00Z`)
      if (!Number.isFinite(at)) throw new Error(`Invalid date on note #${id}`)

      archive.capture({ id: source, project: "", session: `optmem:${store}`, message: String(id), kind: "legacy_note", at, text, payload: JSON.stringify({ id, date: match[1], text }) }, false)
      // An imported explicit note is already selected; no judge/model needed.
      archive.db.query("UPDATE jobs SET state='done',token=NULL,lease=0 WHERE evidence=? AND phase='select'").run(source)
      archive.remember({ id: source, text, at, status: "legacy", scopes: keys, sources: [source] })
      // Empty scopes remain unclassified and searchable through explicit global lookup.
      // Scope corrections are mirrored on subsequent migration runs.
      archive.db.query("DELETE FROM scopes WHERE memory=?").run(source)
      for (const scope of keys) archive.db.query("INSERT INTO scopes VALUES(?,?)").run(source, scope)
    }
    for (const record of records) {
      const saved = archive.db.query<{bytes: Uint8Array}, [string,string,string]>(
        "SELECT bytes FROM legacy WHERE store=? AND kind=? AND id=?",
      ).get(store, record.kind, record.id)
      if (!saved || !Buffer.from(saved.bytes).equals(record.bytes)) throw new Error(`Migration verification failed: ${record.kind}/${record.id}`)
    }
    // Writers can append a note or correct a scope during reads. Retry rather
    // than committing a snapshot that never existed as a whole.
    if (!readFileSync(join(directory, "LOG.txt")).equals(log) ||
        (existsSync(scopeFile) && !readFileSync(scopeFile).equals(scopes))) throw new Error("OptMem changed during migration; retry")
    archive.db.query("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(`migration:${store}`, JSON.stringify({ notes: count, summaries, records: records.length, verified: true }))
  }).immediate()

  return { store, notes: count, summaries, records: records.length, verified: true }
}
