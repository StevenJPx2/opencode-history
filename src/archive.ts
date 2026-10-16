// Canonical evidence and rebuildable memory projections. No model owns the
// archive: completed messages are captured whether or not a judge selects them.
import { auditFeed, memoryStatus, workerHeartbeat, type AuditEntry, type AuditQuery, type Status } from "./audit.ts"
import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, chmodSync } from "node:fs"
import { dirname } from "node:path"

export interface Evidence {
  id: string
  project: string
  session: string
  message: string
  kind: string
  at: number
  text: string
  payload: string
}

export interface Remembered {
  id: string
  text: string
  scopes: string[]
  sources: string[]
  at: number
  /** `legacy`: an imported agent-written note, not independently verified. */
  status: "confirmed" | "proposed" | "unresolved" | "legacy"
  supersedes?: string
}

export interface Job {
  id: string
  evidence: string
  phase: "select" | "extract" | "embed"
  token: string
  attempts: number
}

export const digest = (text: string) => createHash("sha256").update(text).digest("hex")
/** Attempts a job gets for faults of its own before it is marked `failed`. */
export const MAX_ATTEMPTS = 5
export type Scope = string | "all"
export interface Hit { id: string; text: string; kind: string; at: number }
const bounded = (limit: number) => Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 50) : 12
const expression = (query: string) => (query.match(/[\p{L}\p{N}_-]+/gu) ?? []).slice(0, 32).map(term => `"${term}"`).join(" OR ")

export class Archive {
  readonly db: Database

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true, strict: true })
    if (path !== ":memory:") chmodSync(path, 0o600)
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence(
        id TEXT PRIMARY KEY, project TEXT NOT NULL, session TEXT NOT NULL,
        message TEXT NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL,
        text TEXT NOT NULL, payload TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(
        id TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER NOT NULL,
        status TEXT NOT NULL, supersedes TEXT REFERENCES memories(id));
      CREATE TABLE IF NOT EXISTS scopes(
        memory TEXT NOT NULL REFERENCES memories(id), scope TEXT NOT NULL,
        PRIMARY KEY(memory, scope));
      CREATE TABLE IF NOT EXISTS sources(
        memory TEXT NOT NULL REFERENCES memories(id), evidence TEXT NOT NULL REFERENCES evidence(id),
        PRIMARY KEY(memory, evidence));
      CREATE TABLE IF NOT EXISTS legacy(
        store TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
        bytes BLOB NOT NULL, hash TEXT NOT NULL, PRIMARY KEY(store,kind,id));
      CREATE TABLE IF NOT EXISTS legacy_versions(
        store TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, hash TEXT NOT NULL,
        bytes BLOB NOT NULL, PRIMARY KEY(store,kind,id,hash));
      CREATE TABLE IF NOT EXISTS projects(scope TEXT PRIMARY KEY, canonical TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS selections(evidence TEXT PRIMARY KEY REFERENCES evidence(id), selected INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vectors(memory TEXT PRIMARY KEY REFERENCES memories(id), model TEXT NOT NULL, dimensions INTEGER NOT NULL, vector BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS captures(session TEXT PRIMARY KEY, project TEXT NOT NULL, directory TEXT NOT NULL,
        requested INTEGER NOT NULL, ready INTEGER NOT NULL DEFAULT 0, token TEXT, lease INTEGER NOT NULL DEFAULT 0, error TEXT);
      CREATE TABLE IF NOT EXISTS jobs(
        id TEXT PRIMARY KEY, evidence TEXT NOT NULL REFERENCES evidence(id), phase TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
        ready INTEGER NOT NULL DEFAULT 0, lease INTEGER NOT NULL DEFAULT 0,
        token TEXT, error TEXT, UNIQUE(evidence,phase));
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(state,ready,lease);
      CREATE INDEX IF NOT EXISTS evidence_project ON evidence(project,at);
      CREATE INDEX IF NOT EXISTS memories_supersedes ON memories(supersedes);
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_search USING fts5(id UNINDEXED,text);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED,text);
      CREATE TABLE IF NOT EXISTS audit(
        id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, op TEXT NOT NULL,
        outcome TEXT NOT NULL, subject TEXT NOT NULL, phase TEXT, model TEXT,
        reason TEXT, count INTEGER NOT NULL DEFAULT 0, duration INTEGER) STRICT;
      CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
      CREATE INDEX IF NOT EXISTS audit_op ON audit(op,outcome);
      INSERT OR IGNORE INTO meta VALUES('schema','1');
    `)
    const version = this.db.query<{value: string}, []>("SELECT value FROM meta WHERE key='schema'").get()?.value
    if (version !== "1") throw new Error(`Unsupported memory schema ${version}`)
  }

  capture(entry: Evidence, select = true): boolean {
    return this.db.transaction(() => {
      const hash = digest(JSON.stringify(entry))
      const existing = this.db.query<{hash: string}, [string]>("SELECT hash FROM evidence WHERE id=?").get(entry.id)
      if (existing) {
        if (existing.hash !== hash) throw new Error(`Evidence changed at immutable ID ${entry.id}`)
        return false
      }
      this.db.query("INSERT INTO evidence VALUES(?,?,?,?,?,?,?,?,?)").run(
        entry.id, entry.project, entry.session, entry.message, entry.kind, entry.at, entry.text, entry.payload, hash,
      )
      this.db.query("INSERT INTO evidence_search(id,text) VALUES(?,?)").run(entry.id, entry.text)
      if (select) this.enqueue(entry.id, "select")
      return true
    }).immediate()
  }

  enqueue(evidence: string, phase: Job["phase"]): void {
    this.db.query("INSERT OR IGNORE INTO jobs(id,evidence,phase) VALUES(?,?,?)")
      .run(digest(`${evidence}:${phase}`), evidence, phase)
  }

  evidence(id: string): Evidence | null {
    return this.db.query<Evidence, [string]>("SELECT id,project,session,message,kind,at,text,payload FROM evidence WHERE id=?").get(id)
  }

  claim(now = Date.now(), leaseMs = 120_000): Job | null {
    return this.db.transaction(() => {
      const next = this.db.query<{id: string; evidence: string; phase: Job["phase"]; attempts: number}, [number,number]>(
        "SELECT id,evidence,phase,attempts FROM jobs WHERE (state='pending' AND ready<=?) OR (state='running' AND lease<=?) ORDER BY phase='embed',ready,id LIMIT 1",
      ).get(now, now)
      if (!next) return null

      const token = randomUUID()
      this.db.query("UPDATE jobs SET state='running',lease=?,token=?,attempts=attempts+1 WHERE id=?")
        .run(now + leaseMs, token, next.id)
      return { ...next, attempts: next.attempts + 1, token }
    }).immediate()
  }

  owns(job: Job, now = Date.now()): boolean {
    return !!this.db.query("SELECT 1 FROM jobs WHERE id=? AND token=? AND state='running' AND lease>?")
      .get(job.id, job.token, now)
  }

  complete(job: Job, action: () => void = () => {}): boolean {
    return this.db.transaction(() => {
      if (!this.owns(job)) return false

      action()
      this.db.query("UPDATE jobs SET state='done',token=NULL,lease=0,error=NULL WHERE id=? AND token=?").run(job.id, job.token)
      return true
    }).immediate()
  }

  /**
   * The job's own fault, such as unusable model output: back off, and after
   * `MAX_ATTEMPTS` mark it `failed` so it stops costing model calls.
   */
  retry(job: Job, error: string): void {
    const state = job.attempts >= MAX_ATTEMPTS ? "failed" : "pending"
    const delay = Math.min(3_600_000, 5_000 * 2 ** Math.min(job.attempts, 10))
    this.db.query("UPDATE jobs SET state=?,ready=?,token=NULL,lease=0,error=? WHERE id=? AND token=?")
      .run(state, Date.now() + delay, error, job.id, job.token)
  }

  /** Not the job's fault (a model outage or reload): run it at `ready`, attempt not counted. */
  defer(job: Job, ready: number, error: string): void {
    this.db.query("UPDATE jobs SET state='pending',ready=?,attempts=attempts-1,token=NULL,lease=0,error=? WHERE id=? AND token=?")
      .run(ready, error, job.id, job.token)
  }

  /** Keep a lease alive while a model request is in flight. */
  renew(job: Job, leaseMs = 120_000): boolean {
    return this.db.query("UPDATE jobs SET lease=? WHERE id=? AND token=? AND state='running' AND lease>?")
      .run(Date.now() + leaseMs, job.id, job.token, Date.now()).changes === 1
  }

  remember(memory: Remembered): void {
    this.db.transaction(() => {
      const existing = this.db.query("SELECT 1 FROM memories WHERE id=?").get(memory.id)
      if (existing) return

      if (!memory.text.trim() || memory.sources.length === 0) {
        throw new Error("A memory needs text and evidence")
      }
      if (memory.supersedes) {
        // Corrections must share a scope. Never let a project suppress another project's memory.
        const target = this.db.query<{scope: string}, [string]>("SELECT scope FROM scopes WHERE memory=?").all(memory.supersedes)
        if (target.length === 0 || !target.every(row => memory.scopes.includes(row.scope))) throw new Error("Correction crosses memory scope")
      }
      this.db.query("INSERT INTO memories VALUES(?,?,?,?,?)")
        .run(memory.id, memory.text, memory.at, memory.status, memory.supersedes ?? null)
      for (const scope of new Set(memory.scopes)) this.db.query("INSERT INTO scopes VALUES(?,?)").run(memory.id, scope)
      for (const source of new Set(memory.sources)) this.db.query("INSERT INTO sources VALUES(?,?)").run(memory.id, source)
      this.db.query("INSERT INTO memory_search(id,text) VALUES(?,?)").run(memory.id, memory.text)
    }).immediate()
  }

  /** Scope filtering happens inside SQL before ranking or limiting results. */
  search(project: Scope, query: string, limit = 12): Hit[] {
    const match = expression(query)
    if (!match) return []

    return this.db.query<Hit, [string,string,string,string,number]>(`
      SELECT e.id,e.text,e.kind,e.at FROM evidence_search f JOIN evidence e ON e.id=f.id
      WHERE evidence_search MATCH ? AND e.kind NOT IN ('transcript','event') AND
        (?='all' OR e.project=? OR EXISTS(SELECT 1 FROM sources s JOIN scopes sc ON sc.memory=s.memory WHERE s.evidence=e.id AND sc.scope IN (?, 'global')))
      ORDER BY rank LIMIT ?
    `).all(match, project, project, project, bounded(limit))
  }

  recall(project: Scope, query: string, limit = 12): Remembered[] {
    const match = expression(query)
    if (!match) return this.recent(project, limit)

    return this.matching(project, match, limit)
  }

  /** Active memories in scope matching a prepared FTS expression, best first. */
  matching(project: Scope, match: string, limit = 12): Remembered[] {
    const rows = this.db.query<{id: string}, [string,string,string,number]>(`
      SELECT m.id FROM memory_search f JOIN memories m ON m.id=f.id
      WHERE memory_search MATCH ? AND (?='all' OR EXISTS(SELECT 1 FROM scopes s WHERE s.memory=m.id AND s.scope IN (?, 'global')))
      AND NOT EXISTS(SELECT 1 FROM memories newer WHERE newer.supersedes=m.id AND newer.status='confirmed')
      ORDER BY rank LIMIT ?
    `).all(match, project, project, bounded(limit))
    return rows.map(row => this.memory(row.id)!)
  }

  /** How many active memories in scope match, or all of them without `match`. */
  countActive(project: Scope, match?: string): number {
    const active = `(?='all' OR EXISTS(SELECT 1 FROM scopes s WHERE s.memory=m.id AND s.scope IN (?, 'global')))
      AND NOT EXISTS(SELECT 1 FROM memories newer WHERE newer.supersedes=m.id AND newer.status='confirmed')`
    return match === undefined
      ? this.db.query<{n: number}, [string,string]>(`SELECT count(*) n FROM memories m WHERE ${active}`).get(project, project)!.n
      : this.db.query<{n: number}, [string,string,string]>(`SELECT count(*) n FROM memory_search f JOIN memories m ON m.id=f.id WHERE memory_search MATCH ? AND ${active}`)
        .get(match, project, project)!.n
  }

  recent(project: Scope, limit = 12): Remembered[] {
    return this.db.query<{id: string}, [string,string,number]>(`
      SELECT m.id FROM memories m WHERE (?='all' OR EXISTS(SELECT 1 FROM scopes s WHERE s.memory=m.id AND s.scope IN (?, 'global')))
      AND NOT EXISTS(SELECT 1 FROM memories newer WHERE newer.supersedes=m.id AND newer.status='confirmed')
      ORDER BY m.at DESC,m.id DESC LIMIT ?
    `).all(project, project, bounded(limit)).map(row => this.memory(row.id)!)
  }

  memory(id: string): Remembered | null {
    const row = this.db.query<{id: string; text: string; at: number; status: Remembered['status']; supersedes: string | null}, [string]>(
      "SELECT id,text,at,status,supersedes FROM memories WHERE id=?",
    ).get(id)
    if (!row) return null

    return {
      id: row.id, text: row.text, at: row.at, status: row.status,
      ...(row.supersedes === null ? {} : {supersedes: row.supersedes}),
      scopes: this.db.query<{scope: string}, [string]>("SELECT scope FROM scopes WHERE memory=? ORDER BY scope").all(id).map(r => r.scope),
      sources: this.db.query<{evidence: string}, [string]>("SELECT evidence FROM sources WHERE memory=? ORDER BY evidence").all(id).map(r => r.evidence),
    }
  }

  project(canonical: string): string {
    return this.db.transaction(() => {
      const known = this.db.query<{scope: string}, [string]>("SELECT scope FROM projects WHERE canonical=?").get(canonical)
      if (known) return known.scope

      // A stable host identity, independent of judge inference and basename collisions.
      const scope = `project:${digest(canonical).slice(0, 24)}`
      this.db.query("INSERT INTO projects VALUES(?,?)").run(scope, canonical)
      return scope
    }).immediate()
  }

  putVector(id: string, model: string, vector: number[]): void {
    const normalized = normalize(vector)
    this.db.query("INSERT INTO vectors VALUES(?,?,?,?) ON CONFLICT(memory) DO UPDATE SET model=excluded.model,dimensions=excluded.dimensions,vector=excluded.vector")
      .run(id, model, vector.length, Buffer.from(new Float32Array(normalized).buffer))
  }

  semantic(project: Scope, model: string, vector: number[], limit = 12): Remembered[] {
    return this.semanticScored(project, model, vector, limit).map(row => row.memory)
  }

  /** Cosine similarity of every active in-scope memory to the query, best first. */
  semanticScored(project: Scope, model: string, vector: number[], limit = 12): Array<{memory: Remembered; score: number}> {
    const query = normalize(vector)
    const rows = this.db.query<{memory: string; vector: Uint8Array}, [string,number,string,string]>(`
      SELECT v.memory,v.vector FROM vectors v JOIN memories m ON m.id=v.memory
      WHERE v.model=? AND v.dimensions=? AND (?='all' OR EXISTS(SELECT 1 FROM scopes s WHERE s.memory=m.id AND s.scope IN (?, 'global')))
      AND NOT EXISTS(SELECT 1 FROM memories newer WHERE newer.supersedes=m.id AND newer.status='confirmed')
    `).all(model, query.length, project, project)
    return rows.map(row => {
      const values = new Float32Array(Uint8Array.from(row.vector).buffer)
      return {id: row.memory, score: query.reduce((sum, value, i) => sum + value * values[i]!, 0)}
    }).sort((a,b) => b.score-a.score || a.id.localeCompare(b.id)).slice(0, bounded(limit)).map(row => ({memory: this.memory(row.id)!, score: row.score}))
  }

  /** Stored, normalized vectors for these memories under one model. */
  vectorsFor(ids: readonly string[], model: string): Map<string, Float32Array> {
    const found = new Map<string, Float32Array>()
    const query = this.db.query<{vector: Uint8Array}, [string,string]>("SELECT vector FROM vectors WHERE memory=? AND model=?")
    for (const id of ids) {
      const row = query.get(id, model)
      if (row) found.set(id, new Float32Array(Uint8Array.from(row.vector).buffer))
    }
    return found
  }

  /** Each plugin instance contributes its location and release; stale ones fall away. */
  workerHeartbeat(location: string, options: { release?: string | undefined; at?: number } = {}): void { workerHeartbeat(this, location, options) }

  /** Read-only view of pipeline history, for `status` and the `memory_status` tool. */
  audit(query: AuditQuery = {}): AuditEntry[] { return auditFeed(this, query) }

  /** Read-only health summary: is the worker alive, what is queued, what failed. */
  status(options: { at?: number; staleMs?: number } = {}): Status { return memoryStatus(this, options) }

  close(): void { this.db.close() }
}

function normalize(vector: number[]): number[] {
  if (vector.length < 1 || vector.length > 4096 || vector.some(value => !Number.isFinite(value))) throw new Error("Invalid embedding vector")

  const norm = Math.hypot(...vector)
  if (norm === 0 || !Number.isFinite(norm)) throw new Error("Invalid embedding norm")

  return vector.map(value => value / norm)
}
