import { afterAll, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { assistant, fixture, removeFixtures, text } from "./fixture.ts"
import { load, project } from "./host.ts"

afterAll(removeFixtures)

test("history_search registers as a direct tool and finds earlier project work, not the asking session", async () => {
  const f = fixture()
  project(f)
  const host = await load(f)
  try {
    expect(host.tools.get("history_search")?.options?.codemode).toBe(false)
    const found = (await host.search("ses_now", { query: "idempotency" })).content
    expect(found).toContain("ses_old")
    expect(found).toContain("«idempotency»")
    expect(found).not.toContain("ses_now")
    expect(found).not.toContain("ses_other")
    expect(found).not.toContain("tool output")
    expect((await host.search("ses_now", { query: "idempotency", scope: "all" })).content).toContain("ses_other")
    expect((await host.search("ses_now", { query: "nonexistentword" })).content).toContain("does not prove it never happened")
  } finally { host.dispose() }
})

test("a search sees sessions written after the plugin loaded", async () => {
  const f = fixture()
  project(f)
  const host = await load(f)
  try {
    f.message("ses_old", "assistant", assistant(text("followup about rotating keys")))
    expect((await host.search("ses_now", { query: "rotating" })).content).toContain("ses_old")
  } finally { host.dispose() }
})

test("top-level sessions get one frozen recent-work block; subagents get none", async () => {
  const f = fixture()
  project(f)
  const host = await load(f)
  try {
    const first = await host.context("ses_now")
    expect(first).toContain("<recent_work>")
    expect(first).toContain("ses_old · first ask: why does the stripe webhook retry")
    expect(first).not.toContain("ses_other")
    expect(first).not.toContain("ses_now")

    f.session("ses_newer", "p1", "Started later")
    f.message("ses_newer", "user", { text: "later work" })
    expect(await host.context("ses_now")).toBe(first)
    expect(await host.context("ses_child")).toBe("")
  } finally { host.dispose() }
})

test("open returns a result's whole message, which the search only quoted in part", async () => {
  const f = fixture()
  project(f)
  const long = `${"filler words before the point ".repeat(60)}the retry budget is 5 attempts ${"and more filler after it ".repeat(60)}`
  const id = f.message("ses_old", "assistant", assistant({ type: "reasoning", text: "hidden thoughts" }, text(long), text("second text part")))
  const host = await load(f)
  try {
    const found = (await host.search("ses_now", { query: "retry budget attempts" })).content
    expect(found).toContain(id)
    expect(found).not.toContain("second text part")

    const opened = (await host.search("ses_now", { open: id })).content
    expect(opened).toContain("the retry budget is 5 attempts")
    expect(opened).toContain("second text part")
    expect(opened).toContain("ses_old")
    expect(opened).not.toContain("hidden thoughts")
  } finally { host.dispose() }
})

test("open cuts very long messages and refuses unknown or tool-only messages", async () => {
  const f = fixture()
  project(f)
  const huge = f.message("ses_old", "user", { text: "x".repeat(20_000) })
  const toolOnly = f.message("ses_old", "assistant", assistant({ type: "tool", name: "bash", state: { output: "only tool output" } }))
  const host = await load(f)
  try {
    expect((await host.search("ses_now", { open: huge })).content).toContain("[Cut: 8000 more characters")
    await expect(host.search("ses_now", { open: toolOnly })).rejects.toThrow("No searchable message")
    await expect(host.search("ses_now", { open: "msg_missing" })).rejects.toThrow("No searchable message")
    await expect(host.search("ses_now", { query: "x", open: huge })).rejects.toThrow("either `query`")
    await expect(host.search("ses_now", {})).rejects.toThrow("either `query`")
  } finally { host.dispose() }
})

test("a project with no earlier sessions gets no block at all", async () => {
  const f = fixture()
  f.session("ses_first", "p9", "First ever")
  f.message("ses_first", "user", { text: "hello" })
  const host = await load(f)
  try {
    expect(await host.context("ses_first")).toBe("")
  } finally { host.dispose() }
})

test("audit records search, empty results, open, and usage failures without their contents", async () => {
  const f = fixture()
  project(f)
  const id = f.message("ses_old", "user", { text: "private passage to open" })
  const host = await load(f)
  try {
    await host.search("ses_now", { query: "idempotency", scope: "all", session: "ses_other" })
    await host.search("ses_now", { query: "privatequerynomatch" })
    await host.search("ses_now", { open: id })
    await expect(host.search("ses_now", { open: "msg_private_missing" })).rejects.toThrow("No searchable message")
    await expect(host.search("ses_now", {})).rejects.toThrow("either `query`")

    const log = readFileSync(join(f.root, "audit.jsonl"), "utf8")
    const events = log.trim().split("\n").map(line => JSON.parse(line))
    expect(events).toHaveLength(5)
    expect(events[0]).toMatchObject({ tool: "history_search", session: "ses_now", mode: "search", status: "ok", scope: "all", session_filter: true, results: 1, pending: 0 })
    expect(events[1]).toMatchObject({ mode: "search", status: "ok", results: 0 })
    expect(events[2]).toMatchObject({ mode: "open", status: "ok", results: 1 })
    expect(events[3]).toMatchObject({ mode: "open", status: "error", error: "message_not_found" })
    expect(events[4]).toMatchObject({ mode: "invalid", status: "error", error: "invalid_input" })
    for (const event of events) {
      expect(Number.isFinite(Date.parse(event.at))).toBe(true)
      expect(event.duration_ms).toBeGreaterThanOrEqual(0)
    }
    for (const privateText of ["idempotency", "privatequerynomatch", "private passage", "msg_private_missing", "ses_other", id]) {
      expect(log).not.toContain(privateText)
    }
  } finally { host.dispose() }
})

test("malformed tool input is rejected and audited", async () => {
  const f = fixture()
  project(f)
  const host = await load(f)
  const inputs = [null, [], "private", { query: 1 }, { query: " " }, { query: "x".repeat(2001) },
    { open: "" }, { query: "x", open: "msg_x" }, { query: "x", scope: "bad" }, { query: "x", session: 1 },
    { query: "x", limit: 0 }, { query: "x", limit: 21 }, { query: "x", limit: 1.5 }, { query: "x", extra: true }]
  try {
    for (const input of inputs) await expect(host.search("ses_now", input)).rejects.toThrow()
    const events = readFileSync(join(f.root, "audit.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line))
    expect(events).toHaveLength(inputs.length)
    expect(events.every(event => event.status === "error" && event.error === "invalid_input")).toBe(true)
  } finally { host.dispose() }
})

test("audit records execution errors without changing the failure", async () => {
  const f = fixture()
  project(f)
  const host = await load(f)
  try {
    f.db.exec("DROP TABLE session_message")
    await expect(host.search("ses_now", { query: "private query" })).rejects.toThrow("session_message")
    const log = readFileSync(join(f.root, "audit.jsonl"), "utf8")
    expect(JSON.parse(log)).toMatchObject({ mode: "search", status: "error", error: "execution_failed" })
    expect(log).not.toContain("private query")
    expect(log).not.toContain("session_message")
  } finally { host.dispose() }
})

test("audit can be disabled or placed elsewhere", async () => {
  const f = fixture()
  project(f)
  const disabled = await load(f, { audit: false })
  try {
    await disabled.search("ses_now", { query: "idempotency" })
    expect(existsSync(join(f.root, "audit.jsonl"))).toBe(false)
  } finally { disabled.dispose() }

  const path = join(f.root, "custom", "usage.jsonl")
  const custom = await load(f, { audit: path })
  try {
    await custom.search("ses_now", { query: "idempotency" })
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ status: "ok" })
  } finally { custom.dispose() }
})

test("audit write failure does not break the tool or mask a usage error", async () => {
  const f = fixture()
  project(f)
  // A database file cannot be used as a directory.
  const host = await load(f, { audit: join(f.path, "audit.jsonl") })
  try {
    expect((await host.search("ses_now", { query: "idempotency" })).content).toContain("ses_old")
    await expect(host.search("ses_now", {})).rejects.toThrow("either `query`")
  } finally { host.dispose() }
})
