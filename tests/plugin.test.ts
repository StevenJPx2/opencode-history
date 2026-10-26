import { afterAll, expect, test } from "bun:test"
import { join } from "node:path"
import plugin from "../src/index.ts"
import { assistant, fixture, removeFixtures, text, type Fixture } from "./fixture.ts"

afterAll(removeFixtures)

type Tool = { name: string; options?: { codemode?: boolean }; execute: (input: unknown, context: { sessionID: string; signal: AbortSignal }) => Promise<{ content: string }> }
type ContextEvent = { sessionID: string; system: Array<{ type: string; text: string }> }

/** The host surface the plugin uses: tool registration and the context hook. */
async function load(f: Fixture) {
  const tools = new Map<string, Tool>()
  let hook!: (event: ContextEvent) => void | Promise<void>
  const ctx = {
    options: { database: f.path, index: join(f.root, "index.sqlite") },
    tool: { transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => callback({ add: tool => tools.set(tool.name, tool) }) },
    session: { hook: async (name: string, callback: typeof hook) => { if (name === "context") hook = callback } },
  }
  // SAFETY: the fake implements exactly the context members the plugin uses.
  const dispose = await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0])
  const search = (sessionID: string, input: unknown) => tools.get("history_search")!.execute(input, { sessionID, signal: new AbortController().signal })
  const context = async (sessionID: string) => {
    const event: ContextEvent = { sessionID, system: [] }
    await hook(event)
    return event.system.map(part => part.text).join("\n")
  }
  return { tools, search, context, dispose: dispose as () => void }
}

function project(f: Fixture) {
  f.session("ses_old", "p1", "Webhook retries")
  f.message("ses_old", "user", { text: "why does the stripe webhook retry" })
  f.message("ses_old", "assistant", assistant({ type: "tool", name: "bash", state: { output: "idempotency in tool output" } }, text("The idempotency key was missing")))
  f.session("ses_other", "p2", "Other project")
  f.message("ses_other", "assistant", assistant(text("idempotency elsewhere")))
  f.session("ses_now", "p1", "Current work")
  f.message("ses_now", "user", { text: "idempotency again?" })
  f.session("ses_child", "p1", "Explore", "ses_now")
}

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
