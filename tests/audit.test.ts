import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { recordAudit } from "../src/audit.ts"
import { Archive } from "../src/archive.ts"
import { CaptureQueue, importTranscript } from "../src/capture.ts"
import { GenerationUnavailable } from "../src/errors.ts"
import { Historian } from "../src/historian.ts"
import { removeRoot, startHost } from "./host.ts"

const turn = JSON.stringify({ info: { id: "ses_audit" }, messages: [
  { id: "u", type: "user", text: "Should the archive use SQLite WAL mode?", time: { created: 10 } },
  { id: "a", type: "assistant", content: [{ type: "text", text: "Decision confirmed: the archive uses SQLite WAL." }], time: { created: 11, completed: 12 } },
] })

/** Answers the extraction contract against the ids the plugin actually supplied. */
function historian(archive: Archive, replies: Array<string | ((evidence: {id: string; kind: string; text: string}[]) => string)>) {
  return new Historian(archive, { log: () => {}, generate: async prompt => {
    const data = JSON.parse(prompt.slice(prompt.indexOf("\n\n") + 2)) as { evidence: Array<{ id: string; kind: string; text: string }> }
    const reply = replies.shift() ?? JSON.stringify({ memories: [] })
    return typeof reply === "function" ? reply(data.evidence) : reply
  } })
}

test("audit records every pipeline outcome with job and source ids, and never raw content", async () => {
  const archive = new Archive(":memory:")
  const worker = historian(archive, [
    source => JSON.stringify({ memories: [{ text: "The archive uses SQLite WAL.", status: "confirmed", source: source.find(entry => entry.kind === "assistant")!.id, quote: "the archive uses SQLite WAL" }] }),
    "not json",
  ])
  try {
    importTranscript(archive, "alpha", turn, "ses_audit")
    await worker.pass() // selects both passages, then extracts the substantial one
    const passage = archive.search("alpha", "Decision confirmed").find(entry => entry.kind === "assistant")!
    // Requeue the same evidence, as an expired lease would.
    archive.db.query("UPDATE jobs SET state='pending', ready=0, attempts=0 WHERE phase='extract'").run()
    await worker.pass() // extract: the model's reply is not JSON

    const records = archive.audit({ limit: 20 })
    expect(records.map(record => [record.op, record.outcome])).toEqual([
      ["select", "skipped"], ["select", "done"], ["extract", "done"], ["extract", "failed"],
    ])
    expect(records[2]!.subject).toBe(passage.id)
    expect(records[2]!.count).toBe(1)
    expect(records[3]!.reason).toBe("Historian response is not JSON")
    expect(records.every(record => record.subject.length > 0)).toBe(true)
    expect(JSON.stringify(records)).not.toContain("SQLite WAL")
  } finally { await worker.stop(); archive.close() }
})

test("status distinguishes a working worker from one that stopped or never ran", async () => {
  const archive = new Archive(":memory:")
  const now = 1_000_000
  try {
    archive.workerHeartbeat("projet-a", { at: now, release: "33dbbf5babfbfaac" })
    const fresh = archive.status({ at: now + 10_000, staleMs: 90_000 })
    expect(fresh.worker).toEqual({ active: true, locations: ["projet-a"], lastAt: now, releases: ["33dbbf5babfbfaac"] })

    const stale = archive.status({ at: now + 200_000, staleMs: 90_000 })
    expect(stale.worker).toEqual({ active: false, locations: [], lastAt: now, releases: [] })

    // A stale location drops out; a live one keeps its own release.
    archive.workerHeartbeat("projet-b", { at: now + 200_000, release: "working copy" })
    const two = archive.status({ at: now + 210_000, staleMs: 90_000 })
    expect(two.worker).toEqual({ active: true, locations: ["projet-b"], lastAt: now + 200_000, releases: ["working copy"] })
  } finally { archive.close() }
})

test("status reports queue state, failures, cooldowns and the newest capture", async () => {
  const archive = new Archive(":memory:")
  try {
    const capture = new CaptureQueue(archive, async () => { throw new Error("no service") }, "unused", () => {})
    capture.request("ses_1", "alpha", "/x")
    expect(archive.status().captures).toMatchObject({ queued: 1, lastError: null })
    const captureAudit = () => archive.audit({ ops: ["capture"], limit: 5 })

    // A capture first, then one job that gave up and one still waiting.
    archive.db.query("INSERT INTO evidence(id,hash,project,session,message,kind,at,text,payload) VALUES('e1','h1','beta','ses_1','m1','user',5,'hello there','{}')").run()
    archive.db.query("INSERT INTO jobs(evidence,phase,state,attempts,ready,error) VALUES('e1','extract','failed',5,0,'Memory citation does not match supplied evidence')").run()
    archive.db.query("INSERT INTO evidence(id,hash,project,session,message,kind,at,text,payload) VALUES('e2','h2','beta','ses_1','m2','user',6,'still waiting','{}')").run()
    archive.db.query("INSERT INTO jobs(evidence,phase,state,attempts,ready) VALUES('e2','select','pending',0,0)").run()
    archive.db.query("INSERT INTO meta VALUES('cooldown:openai/luna','{\"until\":5000,\"failures\":2,\"kind\":\"unavailable\"}')").run()
    await capture.pass()

    const status = archive.status()
    expect(status.captures).toMatchObject({ queued: 1, lastError: "Full export failed; queued for retry" })
    expect(status.captures.lastAt).not.toBeNull()
    expect(captureAudit().map(record => [record.outcome, record.reason])).toEqual([
      ["deferred", "Full export failed; queued for retry"],
    ])
    expect(status.jobs).toMatchObject({ failed: 1, pending: 1, done: 0, running: 0 })
    expect(status.failures).toEqual([{ reason: "Memory citation does not match supplied evidence", count: 1 }])
    expect(status.cooldowns).toEqual([{ model: "openai/luna", until: 5000, failures: 2, kind: "unavailable", tag: "unknown" }])
    expect(status.evidence.lastKind).toBe("user")
  } finally { archive.close() }
})

test("a saved conversation is audited with its passage count, so silence means no capture", async () => {
  const archive = new Archive(":memory:")
  const capture = new CaptureQueue(archive, async () => turn, "unused", () => {})
  try {
    capture.request("ses_audit", "alpha", "/x")
    await capture.pass()

    expect(archive.audit({ ops: ["capture"] }).map(entry => [entry.outcome, entry.subject, entry.count])).toEqual([
      ["done", "ses_audit", 2],
    ])
    expect(archive.status().captures).toMatchObject({ queued: 0 })
  } finally { await capture.stop(); archive.close() }
})

test("the feed pages by exclusive cursor so a follower never repeats a line", async () => {
  const archive = new Archive(":memory:")
  try {
    recordAudit(archive, { at: Date.now(), op: "capture", outcome: "done", subject: "ses_1", count: 1 })
    const cursor = archive.audit({ limit: 5 }).at(-1)!.id

    for (const session of ["ses_2", "ses_3"]) {
      recordAudit(archive, { at: Date.now(), op: "capture", outcome: "done", subject: session, count: 1 })
    }

    const next = archive.audit({ after: cursor, limit: 2 })
    expect(next.map(entry => entry.subject)).toEqual(["ses_2", "ses_3"])
    expect(archive.audit({ after: next.at(-1)!.id })).toEqual([])
    expect(archive.audit({ ops: ["extract"], after: cursor })).toEqual([])
  } finally { archive.close() }
})

test("a tool lets the working agent see memory health without leaving the session", async () => {
  const root = mkdtempSync(join(tmpdir(), "optmem-status-"))
  const host = await startHost({ root })
  try {
    const tool = host.tools.get("memory_status")
    expect(tool).toBeDefined()
    const report = JSON.parse((await tool!.execute({ detail: false }, { sessionID: "ses_work", signal: new AbortController().signal })).content)
    expect(report.worker.active).toBe(true)
    expect(report.worker.locations).toEqual([host.directory])
    expect(report.worker.releases).toEqual(["working copy"])
    expect(report.evidence.count).toBeGreaterThanOrEqual(0)
    expect(report.recent).toEqual([])
  } finally { host.dispose(); await Bun.sleep(20); removeRoot(root) }
})

test("a provider outage is recorded once and stops the pass instead of looping the queue", async () => {
  const archive = new Archive(":memory:")
  const worker = new Historian(archive, { log: () => {}, generate: async () => { throw new GenerationUnavailable(Date.now() + 60_000) } })
  try {
    // Two substantial replies, so the pass has more than one model call to refuse.
    importTranscript(archive, "alpha", JSON.stringify({ info: { id: "ses_out" }, messages: [
      { id: "u", type: "user", text: "Record the architecture decision and the deployment constraint we agreed on.", time: { created: 10 } },
      { id: "a", type: "assistant", content: [{ type: "text", text: "Decision confirmed: OptMem keeps every model call inside the plugin." }], time: { created: 11, completed: 12 } },
      { id: "b", type: "assistant", content: [{ type: "text", text: "Decision confirmed: production runs a pinned release under the releases directory." }], time: { created: 13, completed: 14 } },
    ] }))
    await worker.pass()

    const records = archive.audit({ ops: ["extract"], limit: 10 })
    expect(records.map(record => record.outcome)).toEqual(["deferred"])
    expect(archive.status().jobs.pending).toBe(2)
  } finally { await worker.stop(); archive.close() }
})