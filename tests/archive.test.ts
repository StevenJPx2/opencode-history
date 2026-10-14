import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Archive, type Evidence } from "../src/archive.ts"
import { migrateOptMem } from "../src/migrate.ts"

const roots: string[] = []
afterAll(() => roots.forEach(root => rmSync(root, {recursive: true, force: true})))
const evidence = (id: string, project = "alpha"): Evidence => ({id,project,session:"s",message:id,kind:"user",at:1,text:"decided OpenAI Luna",payload:JSON.stringify({id})})

test("capture is idempotent and refuses a changed source identity", () => {
  const db = new Archive(":memory:")
  try {
    expect(db.capture(evidence("a"))).toBe(true)
    expect(db.capture(evidence("a"))).toBe(false)
    expect(() => db.capture({...evidence("a"),payload:"changed"})).toThrow("immutable ID")
  } finally { db.close() }
})

test("scope filtering precedes search and global memories are explicit", () => {
  const db = new Archive(":memory:")
  try {
    db.capture(evidence("a")); db.capture(evidence("b", "beta"))
    db.remember({id:"ma",text:"Luna alpha",at:1,status:"confirmed",scopes:["alpha"],sources:["a"]})
    db.remember({id:"mb",text:"Luna beta",at:2,status:"confirmed",scopes:["beta"],sources:["b"]})
    db.remember({id:"mg",text:"Luna global",at:3,status:"confirmed",scopes:["global"],sources:["a"]})
    expect(db.search("alpha", "Luna").map(r => r.id)).toEqual(["a"])
    expect(db.recall("alpha", "Luna").map(r => r.id).sort()).toEqual(["ma","mg"])
  } finally { db.close() }
})

test("lease tokens prevent stale workers from committing after reclamation", () => {
  const db = new Archive(":memory:")
  try {
    db.capture(evidence("a"))
    const old = db.claim(0, 1)!
    const fresh = db.claim(Date.now(), 10_000)!
    expect(old.token).not.toBe(fresh.token)
    expect(db.complete(old)).toBe(false)
    expect(db.complete(fresh)).toBe(true)
    expect(db.claim()).toBeNull()
  } finally { db.close() }
})

test("migration preserves note IDs, dates, scope, summary bytes and is repeatable", () => {
  const dir = mkdtempSync(join(tmpdir(), "archive-test-"))
  roots.push(dir)
  const pad = (text: string, width: number) => Buffer.from(text.padEnd(width, " "))
  writeFileSync(join(dir,"LOG.txt"), Buffer.concat([pad("#0 2026-10-12 Luna alpha",320),pad("#1 2026-10-13 Luna beta",320)]))
  writeFileSync(join(dir,"SCOPE.txt"), Buffer.concat([pad("alpha",128),pad("beta",128)]))
  writeFileSync(join(dir,"scopes.json"), '{"alpha":"/alpha","beta":"/beta"}')
  mkdirSync(join(dir,"TREE")); writeFileSync(join(dir,"TREE","2"),pad("combined summary",288))
  const db = new Archive(join(dir,"archive.sqlite"))
  try {
    const report = migrateOptMem(db, dir)
    expect(report.notes).toBe(2); expect(report.summaries).toBe(1); expect(report.verified).toBe(true)
    expect(migrateOptMem(db, dir)).toEqual(report)
    expect(db.recall("alpha","Luna")[0]?.text).toBe("Luna alpha")
    expect(db.recall("alpha","Luna")[0]?.id).toEndWith(":0")
    expect(db.recall("beta","Luna")[0]?.at).toBe(Date.parse("2026-10-13T00:00:00Z"))
    expect(db.claim()).toBeNull()
  } finally { db.close() }
})

test("live selection runs before embedding backfill", () => {
  const db = new Archive(":memory:")
  try {
    db.capture(evidence("old"), false)
    db.enqueue("old", "embed")
    db.capture(evidence("new"))
    expect(db.claim()?.phase).toBe("select")
  } finally { db.close() }
})

test("migration rejects malformed data atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "archive-bad-"))
  roots.push(dir); writeFileSync(join(dir,"LOG.txt"),"partial")
  const db = new Archive(":memory:")
  try { expect(() => migrateOptMem(db,dir)).toThrow("incomplete") } finally { db.close() }
})
