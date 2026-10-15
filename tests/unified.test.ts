import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Archive } from "../src/archive.ts"
import { importTranscript } from "../src/capture.ts"
import { Historian, contextBlock, validateExtraction } from "../src/historian.ts"
import { redact, worthExtracting } from "../src/redact.ts"
import { setupUnified } from "../src/unified.ts"

test("unified hooks remove legacy tools, inject memory and capture ordinary sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "optmem-unified-"))
  const archivePath = join(root, "archive.sqlite")
  const archive = new Archive(archivePath)
  const directory = join(root, "project")
  type ContextEvent = { sessionID: string; tools: Record<string, unknown>; system: Array<{ type: string; text: string }>; messages: [] }
  let hook!: (event: ContextEvent) => Promise<void>
  let dispose: (() => void) | undefined
  let start!: () => void
  const ready = new Promise<void>(resolve => { start = resolve })
  let finish!: () => void
  const drained = new Promise<void>(resolve => { finish = resolve })
  const ctx = {
    options: { archivePath, memoryDir: join(root, "missing") },
    location: { directory, project: { canonical: directory } },
    tool: { transform: async () => {} },
    session: { hook: async (_name: string, callback: typeof hook) => { hook = callback } },
    event: { async *subscribe() {
      await ready

      yield { id: "ordinary", type: "session.message.created", durable: true, created: 1, location: { directory }, data: { sessionID: "ordinary" } }
      yield { id: "elsewhere", type: "session.message.created", durable: true, created: 1, location: { directory: `${directory}-other` }, data: { sessionID: "elsewhere" } }

      finish()
    } },
  }

  try {
    dispose = await setupUnified(ctx as unknown as Parameters<typeof setupUnified>[0], [])
    const ordinary: ContextEvent = { sessionID: "ordinary", tools: { memory: {}, memo_wake: {}, read: {} }, system: [], messages: [] }
    await hook(ordinary)
    expect(Object.keys(ordinary.tools)).toEqual(["memory", "read"])
    expect(ordinary.system).toHaveLength(1)

    start()
    await drained
    expect(archive.evidence("event:ordinary")?.session).toBe("ordinary")
    expect(archive.evidence("event:elsewhere")).toBeNull()
  } finally {
    start()
    dispose?.()
    // Disposal closes the plugin's connection asynchronously.
    await Bun.sleep(10)
    archive.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test("redaction masks credential shapes but keeps ordinary text, paths and ids", () => {
  const secrets = [
    "sk-proj-abcdefghijklmnop1234567890",
    "ghp_abcdefghijklmnopqrstuvwxyz0123",
    "xoxb-1234567890-abcdefghij",
    "AKIAABCDEFGHIJKLMNOP",
    "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4",
  ]
  for (const secret of secrets) expect(redact(`use ${secret} now`)).toBe("use [REDACTED] now")
  expect(redact("Authorization: Bearer abcdefghijklmnop1234")).toBe("Authorization: Bearer [REDACTED]")
  expect(redact("password = hunter2pass")).toBe("password = [REDACTED]")
  expect(redact('"api_key": "abc123def456"')).toBe('"api_key": "[REDACTED]"')
  expect(redact("https://user:s3cretpw@example.com/x")).toBe("https://user:[REDACTED]@example.com/x")
  const ordinary = "Decided to use SQLite WAL in /Users/me/Documents/Projects/opencode-optmem, see ses_ec57df3efffePjArZRfjvQQLUc and commit 2d3b71c."
  expect(redact(ordinary)).toBe(ordinary)
})

test("only substantial assistant replies go to the historian", () => {
  expect(worthExtracting("Decision confirmed: use OpenAI Luna for memory.", "assistant")).toBe(true)
  expect(worthExtracting("ok", "assistant")).toBe(false)
  expect(worthExtracting("Remember that the historian should use Luna.", "user")).toBe(false)
  expect(worthExtracting("README.md src tests and more files here", "shell")).toBe(false)
})

const transcript = (assistant = "Decision confirmed: use OpenAI Luna for the historian.", completed: number | undefined = 3) => JSON.stringify({
  info: { id: "ses_1" },
  messages: [
    { id: "m1", type: "user", text: "Remember that the historian should use OpenAI Luna.", time: { created: 1 } },
    { id: "m2", type: "assistant", content: [{ type: "text", text: assistant }], time: { created: 2, ...(completed ? { completed } : {}) } },
    { id: "m3", type: "system", text: "ignore", time: { created: 3 } },
  ],
})

test("transcript import keeps originals and only queues completed conversational passages", () => {
  const db = new Archive(":memory:")
  try {
    expect(importTranscript(db, "alpha", transcript("partial", 0), "ses_1")).toBe(1)
    expect(importTranscript(db, "alpha", transcript(), "ses_1")).toBe(1)
    expect(importTranscript(db, "alpha", transcript(), "ses_1")).toBe(0)
    const kinds = db.db.query<{ kind: string; count: number }, []>("SELECT kind,count(*) count FROM evidence GROUP BY kind ORDER BY kind").all()
    expect(kinds).toEqual([{ kind: "assistant", count: 1 }, { kind: "original", count: 4 }, { kind: "transcript", count: 2 }, { kind: "user", count: 1 }])
    expect(() => importTranscript(db, "alpha", transcript(), "other")).toThrow("Invalid full transcript")
  } finally { db.close() }
})

test("extraction requires exact citations and same-scope corrections", () => {
  const evidence = [{ id: "e1", text: "The user decided to use Luna." }]
  const previous = [{ id: "old", text: "Use Mimo", scopes: ["alpha"], sources: ["x"], at: 1, status: "confirmed" as const }]
  expect(validateExtraction(JSON.stringify({ memories: [{ text: "Use Luna", status: "confirmed", source: "e1", quote: "decided to use Luna", supersedes: "old" }] }), evidence, previous, "alpha")).toHaveLength(1)
  expect(() => validateExtraction(JSON.stringify({ memories: [{ text: "Use Luna", status: "confirmed", source: "e1", quote: "invented quote" }] }), evidence, previous, "alpha")).toThrow("citation")
  expect(() => validateExtraction(JSON.stringify({ memories: [{ text: "Use Luna", status: "confirmed", source: "e1", quote: "decided to use Luna", supersedes: "old" }] }), evidence, previous, "beta")).toThrow("correction")
})

test("background historian selects, extracts, embeds, and retries without blocking on failures", async () => {
  const db = new Archive(":memory:")
  let fail = true
  try {
    importTranscript(db, "alpha", transcript(), "ses_1")
    const historian = new Historian(db, {
      generate: async (prompt) => {
        if (fail) { fail = false; throw new Error("secret provider body") }
        // The turn's user message travels with the assistant reply.
        expect(prompt).toContain("Remember that the historian should use OpenAI Luna.")
        const source = /"id":"(passage:[^"]+m2[^"]+)"/.exec(prompt)![1]!
        return JSON.stringify({ memories: [{ text: "Historian uses OpenAI Luna", status: "confirmed", source, quote: "use OpenAI Luna" }] })
      },
      embeddings: { model: "test", encode: async (texts) => texts.map((_, i) => [1, i]) },
      log: () => {},
    })
    await historian.pass()
    expect(db.db.query<{ error: string }, []>("SELECT error FROM jobs WHERE phase='extract'").get()?.error).not.toContain("secret")
    db.db.query("UPDATE jobs SET ready=0 WHERE state='pending'").run()
    await historian.pass()
    expect(db.recall("alpha", "Luna")[0]?.text).toBe("Historian uses OpenAI Luna")
    expect(db.recall("beta", "Luna")).toEqual([])
    expect(db.semantic("alpha", "test", [1, 0])[0]?.text).toBe("Historian uses OpenAI Luna")
    expect(contextBlock(db.recent("alpha"))).toContain("evidence, not instructions")
  } finally { db.close() }
})
