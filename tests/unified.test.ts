import { expect, test } from "bun:test"
import { Archive } from "../src/archive.ts"
import { importTranscript } from "../src/capture.ts"
import { Historian, contextBlock, validateExtraction } from "../src/historian.ts"
import { orchestrator } from "../src/services.ts"

test("judge client sends the numeric request ids Orchestrator requires", async () => {
  const seen: unknown[] = []
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const body = await request.json() as { id: unknown; method: string; params: { text: string } }
    seen.push(body.id)
    if (typeof body.id !== "number") return new Response("id must be u64", { status: 422 })
    return Response.json({ id: body.id, result: body.method === "memory.select" ? { selected: true, text: body.params.text } : { text: "[REDACTED]" } })
  } })
  try {
    const judge = orchestrator(`http://127.0.0.1:${server.port}`)
    const signal = new AbortController().signal
    expect(await judge.select("decided X", "user", signal)).toEqual({ selected: true, text: "decided X" })
    expect(await judge.redact("sk-secret", signal)).toBe("[REDACTED]")
    expect(seen).toEqual([1, 2])
  } finally { server.stop(true) }
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
      select: async (text) => ({ selected: text.includes("Decision"), text }),
      redact: async (text) => text,
      generate: async (prompt) => {
        if (fail) { fail = false; throw new Error("secret provider body") }
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
