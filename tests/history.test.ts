import { afterAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import { chunk, HistoryIndex, matchExpression, objectiveOf, openSource, recentSessions, SourceSchemaError } from "../src/history.ts"
import { assistant, fixture, removeFixtures, text, type Fixture } from "./fixture.ts"

afterAll(removeFixtures)

function indexed(f: Fixture): { index: HistoryIndex; source: Database } {
  const index = new HistoryIndex(":memory:")
  const source = openSource(f.path)
  index.sync(source)
  return { index, source }
}

test("openSource refuses a layout without the columns it reads", () => {
  const f = fixture()
  f.db.exec("ALTER TABLE session_v2 DROP COLUMN parent_id")
  expect(() => openSource(f.path)).toThrow(SourceSchemaError)
})

test("indexes user text, assistant text and compaction summaries, never reasoning or tool calls", () => {
  const f = fixture()
  f.session("s1", "p1", "Payments work")
  f.message("s1", "user", { text: "why does the stripe webhook retry" })
  f.message("s1", "assistant", assistant(
    { type: "reasoning", text: "secretreasoning" },
    { type: "tool", name: "bash", state: { input: { command: "toolinputonly" }, output: "tooloutputonly" } },
    text("Because the idempotency key was missing")))
  f.message("s1", "compaction", { summary: "## Objective\n- Fix duplicate charges" })
  f.message("s1", "synthetic", { text: "syntheticnotice" })
  const index = new HistoryIndex(":memory:")

  expect(index.sync(openSource(f.path))).toEqual({ sessions: 1, chunks: 3, removed: 0, remaining: 0 })
  for (const hidden of ["secretreasoning", "toolinputonly", "tooloutputonly", "syntheticnotice"]) expect(index.search(hidden)).toEqual([])
  expect(index.search("idempotency")[0]).toMatchObject({ session: "s1", title: "Payments work", kind: "assistant" })
  expect(index.search("duplicate charges")[0]?.kind).toBe("compaction")
})

test("re-syncs only changed sessions and picks up a reply that completed after indexing", () => {
  const f = fixture()
  f.session("s1", "p1", "One")
  f.session("s2", "p1", "Two")
  f.message("s1", "user", { text: "start" })
  const reply = f.message("s1", "assistant", assistant(text("partial")))
  f.message("s2", "user", { text: "untouched" })
  const { index, source } = indexed(f)

  f.db.query("UPDATE session_message SET data=? WHERE id=?").run(JSON.stringify(assistant(text("completedanswer"))), reply)
  f.message("s1", "idle", {})

  expect(index.sync(source)).toMatchObject({ sessions: 1, remaining: 0 })
  expect(index.search("completedanswer").map(hit => hit.session)).toEqual(["s1"])
  expect(index.search("partial")).toEqual([])
  expect(index.sync(source).sessions).toBe(0)
})

test("drops sessions OpenCode deleted and never indexes historian sessions", () => {
  const f = fixture()
  f.session("s1", "p1", "Keep")
  f.session("s2", "p1", "Gone")
  f.session("h1", "p1", "optmem historian: openai/gpt-6-luna")
  for (const id of ["s1", "s2", "h1"]) f.message(id, "user", { text: "shared term" })
  const { index, source } = indexed(f)
  f.db.exec("DELETE FROM session_v2 WHERE id='s2'; DELETE FROM session_message WHERE session_id='s2'")

  expect(index.sync(source).removed).toBe(1)
  expect(index.search("shared").map(hit => hit.session)).toEqual(["s1"])
})

test("search filters by project, by session and by exclusion, and treats input as text", () => {
  const f = fixture()
  f.session("a", "p1", "A")
  f.session("b", "p2", "B")
  f.session("child", "p1", "Explore", "a")
  f.message("a", "user", { text: "qdrant latency" })
  f.message("a", "assistant", assistant(text("qdrant qdrant again")))
  f.message("b", "user", { text: "qdrant elsewhere" })
  f.message("child", "assistant", assistant(text("qdrant from a subagent")))
  const { index } = indexed(f)

  expect(index.search("qdrant").map(hit => hit.session).sort()).toEqual(["a", "b", "child"])
  expect(index.search("qdrant", { project: "p1" }).map(hit => hit.session).sort()).toEqual(["a", "child"])
  expect(index.search("qdrant", { project: "p1", exclude: "a" }).map(hit => hit.session)).toEqual(["child"])
  expect(index.search("qdrant", { session: "a" }).map(hit => hit.message).sort()).toEqual(["msg_a_0", "msg_a_1"])
  expect(index.search('qdrant" OR NEAR( * -')).not.toEqual([])
})

test("a spent time budget leaves the rest for later passes, which resume part-way sessions", () => {
  const f = fixture()
  for (const id of ["s1", "s2"]) {
    f.session(id, "p1", id)
    for (let i = 0; i < 7; i++) f.message(id, i % 2 ? "assistant" : "user", i % 2 ? assistant(text(`${id}reply${i}`)) : { text: `${id}ask${i}` })
  }
  const index = new HistoryIndex(":memory:")
  const source = openSource(f.path)

  // A zero budget runs exactly one page per pass.
  const passes = [index.sync(source, { budgetMs: 0, page: 3 })]
  while (passes.at(-1)!.remaining > 0 && passes.length < 20) passes.push(index.sync(source, { budgetMs: 0, page: 3 }))
  expect(passes[0]).toMatchObject({ sessions: 0, remaining: 2 })
  expect(passes.length).toBe(6)
  for (const id of ["s1", "s2"]) for (let i = 0; i < 7; i++) {
    expect(index.search(`${id}${i % 2 ? "reply" : "ask"}${i}`).map(hit => hit.session)).toEqual([id])
  }
  expect(index.db.query("SELECT count(*) AS n FROM chunks").get()).toEqual({ n: 14 })
  expect(index.sync(source).sessions).toBe(0)
})

test("an index from an older layout is rebuilt rather than misread", () => {
  const f = fixture()
  const path = join(f.root, "index.sqlite")
  const old = new Database(path, { create: true })
  old.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY, directory TEXT)")
  old.close()
  f.session("s1", "p1", "One")
  f.message("s1", "user", { text: "rebuilt" })

  const index = new HistoryIndex(path)
  index.sync(openSource(f.path))
  expect(index.search("rebuilt").map(hit => hit.session)).toEqual(["s1"])
  index.close()
})

test("recent sessions: the project's top-level work by last message, with an objective or first ask", () => {
  const f = fixture()
  f.session("old", "p1", "Old work")
  f.message("old", "user", { text: "\n  first line of the old ask\nsecond line" })
  f.session("new", "p1", "New work")
  f.message("new", "user", { text: "ignored when a summary exists" })
  f.message("new", "compaction", { summary: "## Objective\n- Ship the search tool\n- in one change\n\n## Decisions\n- BM25" })
  f.session("child", "p1", "Subagent", "new")
  f.message("child", "user", { text: "subagent" })
  f.session("other", "p2", "Other project")
  f.message("other", "user", { text: "elsewhere" })
  f.session("current", "p1", "Current")
  f.message("current", "user", { text: "now" })

  const recent = recentSessions(openSource(f.path), "p1", "current", 5)
  expect(recent.map(row => row.id)).toEqual(["new", "old"])
  expect(recent[0]?.gist).toEqual({ kind: "objective", text: "Ship the search tool in one change" })
  expect(recent[1]?.gist).toEqual({ kind: "first ask", text: "first line of the old ask" })
})

test("objectiveOf reads only the Objective section", () => {
  expect(objectiveOf("## Objective\n- A\n- B\n## Requirements\n- C")).toBe("A B")
  expect(objectiveOf("## Objective\n- Last section")).toBe("Last section")
  expect(objectiveOf("## Goal\n- none")).toBeUndefined()
})

test("a frozen block never changes once built, even if a rebuild would differ", () => {
  const index = new HistoryIndex(":memory:")
  expect(index.frozenBlock("s1", () => "first")).toBe("first")
  expect(index.frozenBlock("s1", () => "second")).toBe("first")
  expect(index.frozenBlock("s1", () => { throw new Error("must not rebuild") })).toBe("first")
})

test("chunks overlap, prefer whitespace cuts, and cover the whole text", () => {
  const sample = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ")
  const parts = chunk(sample, 300, 50)
  expect(parts.every(part => part.length <= 300)).toBe(true)
  expect(parts.at(-1)?.endsWith("word399")).toBe(true)
  expect(parts.every((part, i) => i === 0 || sample.indexOf(part) < sample.indexOf(parts[i - 1]!) + parts[i - 1]!.length)).toBe(true)
  expect(chunk("   ")).toEqual([])
})

test("match expressions quote content words and fall back to common words alone", () => {
  expect(matchExpression('what did we decide about "Qdrant" OR c*')).toBe('"decide" OR "qdrant" OR "c"')
  expect(matchExpression("what is this")).toBe('"what" OR "is" OR "this"')
  expect(matchExpression("!!!")).toBe("")
})
