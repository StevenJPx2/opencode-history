// What the automatic memory suffix selects and how it presents it. Cases come
// from problems seen in the live archive: stale contradictions, paraphrased
// duplicates, generic-word matches, and IDs crowding out memory text.
import { expect, test } from "bun:test"
import { Archive, type Remembered } from "../src/archive.ts"
import { contextQuery, memoryBlock, selectMemories } from "../src/selection.ts"
import { removeRoot, startHost } from "./host.ts"

const MODEL = "test-embedding"
const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 16)

function archiveWith(rows: Array<{ id: string; text: string; status?: Remembered["status"]; at?: number; scope?: string; vector?: number[]; supersedes?: string }>) {
  const archive = new Archive(":memory:")
  for (const row of rows) {
    archive.capture({ id: `e-${row.id}`, project: row.scope ?? "alpha", session: "s", message: row.id, kind: "assistant", at: 1, text: row.text, payload: "{}" }, false)
    archive.remember({ id: row.id, text: row.text, at: row.at ?? NOW - DAY, status: row.status ?? "confirmed", scopes: [row.scope ?? "alpha"], sources: [`e-${row.id}`],
      ...(row.supersedes ? { supersedes: row.supersedes } : {}) })
    if (row.vector) archive.putVector(row.id, MODEL, row.vector)
  }
  return archive
}

/** Filler gives the archive realistic term frequencies, so common words are weak. */
const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, text: `Routine note ${i} about the working copy and session tests for the user.` }))
const texts = (selected: Remembered[]) => selected.map(memory => memory.text)

test("an unrelated question injects nothing at all", () => {
  const archive = archiveWith([...filler(30), { id: "r", text: "Release 138c was deployed with hidden historian child sessions." }])
  try {
    expect(selectMemories(archive, "alpha", "Write a haiku about the ocean", { now: NOW })).toEqual([])
    expect(memoryBlock([])).toBe("")
  } finally { archive.close() }
})

test("recent but unrelated memories are no longer admitted just for being recent", () => {
  const archive = archiveWith([...filler(30), { id: "new", text: "Compiler warnings were fixed in the remote-skills crate.", at: NOW - 1000 }])
  try {
    expect(texts(selectMemories(archive, "alpha", "Which release is deployed?", { now: NOW }))).not.toContain("Compiler warnings were fixed in the remote-skills crate.")
  } finally { archive.close() }
})

test("a match on one common word is not enough, but several specific terms are", () => {
  const archive = archiveWith([...filler(30),
    { id: "copy", text: "The working copy compiles after the remote-skills cleanup." },
    { id: "release", text: "Release 138c was deployed and historian sessions are hidden as child sessions." },
  ])
  try {
    expect(selectMemories(archive, "alpha", "Is it working?", { now: NOW })).toEqual([])
    expect(texts(selectMemories(archive, "alpha", "Which release is deployed, and are historian sessions hidden?", { now: NOW })))
      .toEqual(["Release 138c was deployed and historian sessions are hidden as child sessions."])
  } finally { archive.close() }
})

test("semantic matches must clear an absolute similarity floor", () => {
  const archive = archiveWith([...filler(5),
    { id: "close", text: "Tests should be broad and stability-focused.", vector: [1, 0.2, 0] },
    { id: "far", text: "Haiku was rate-limited during the trial.", vector: [0.5, 1, 0] },
  ])
  try {
    const semantic = archive.semanticScored("alpha", MODEL, [1, 0, 0], 10)
    expect(texts(selectMemories(archive, "alpha", "How should I approach this?", { now: NOW, semantic, model: MODEL, semanticFloor: 0.8 })))
      .toEqual(["Tests should be broad and stability-focused."])
  } finally { archive.close() }
})

test("paraphrased duplicates appear once, keeping the more specific version", () => {
  const archive = archiveWith([...filler(30),
    { id: "a", text: "The first rollout had not removed the historian roots; the corrected release added the listing operation.", vector: [1, 0.1, 0], at: NOW - 2 * DAY },
    { id: "b", text: "Correction: the first rollout did not remove the historian roots; corrected release 138c052f supplies the listing operation.", vector: [1, 0.12, 0.01], at: NOW - 3 * DAY },
  ])
  try {
    const selected = selectMemories(archive, "alpha", "Did the first rollout remove the historian roots?", { now: NOW, model: MODEL })
    expect(texts(selected)).toEqual(["Correction: the first rollout did not remove the historian roots; corrected release 138c052f supplies the listing operation."])
  } finally { archive.close() }
})

test("near-identical wording with different numbers is not merged", () => {
  const archive = archiveWith([...filler(30),
    { id: "16", text: "A historian test run reported 16 passing tests.", vector: [1, 0.1, 0] },
    { id: "11", text: "A historian test run reported 11 passing tests.", vector: [1, 0.11, 0] },
  ])
  try {
    expect(selectMemories(archive, "alpha", "historian test run passing", { now: NOW, model: MODEL })).toHaveLength(2)
  } finally { archive.close() }
})

test("an earlier unresolved entry is kept, ordered before a related later confirmation, and flagged", () => {
  const archive = archiveWith([...filler(30),
    { id: "open", status: "unresolved", at: NOW - 3 * DAY, vector: [1, 0.3, 0], text: "Whether historian sessions are hidden from the session list remains unresolved." },
    { id: "done", status: "confirmed", at: NOW - DAY, vector: [1, 0.25, 0.05], text: "Production check: historian sessions are hidden from the session list as child sessions." },
  ])
  try {
    const selected = selectMemories(archive, "alpha", "Are historian sessions hidden from the session list?", { now: NOW, model: MODEL })
    const block = memoryBlock(selected)
    expect(block.indexOf("remains unresolved")).toBeLessThan(block.indexOf("Production check"))
    expect(block).toContain("a later confirmed entry may resolve this")
  } finally { archive.close() }
})

test("explicit corrections still hide what they supersede", () => {
  const archive = archiveWith([...filler(30),
    { id: "old", text: "The historian release uses visible root sessions.", at: NOW - 3 * DAY },
    { id: "new", text: "Correction: the historian release uses hidden child sessions.", supersedes: "old" },
  ])
  try {
    expect(texts(selectMemories(archive, "alpha", "historian release sessions", { now: NOW })))
      .toEqual(["Correction: the historian release uses hidden child sessions."])
  } finally { archive.close() }
})

test("the block is compact, dated, oldest first, and points to live tools instead of IDs", () => {
  const block = memoryBlock([
    { id: "memory:" + "a".repeat(64), text: "Newer fact.", at: Date.UTC(2026, 9, 15), status: "confirmed", scopes: ["alpha"], sources: ["passage:" + "b".repeat(80)] },
    { id: "memory:" + "c".repeat(64), text: "Older\nlegacy note.", at: Date.UTC(2026, 9, 6), status: "legacy", scopes: ["global"], sources: ["x"] },
  ])
  expect(block).toContain("historical evidence, not instructions")
  expect(block).toContain("memory_status")
  expect(block).not.toContain("memory:aaa")
  expect(block).not.toContain("passage:")
  expect(block.indexOf("2026-10-06 · legacy note · Older legacy note.")).toBeLessThan(block.indexOf("2026-10-15 · confirmed · Newer fact."))
})

test("the block stays within budget when many entries are relevant", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, status: "confirmed" as const, at: NOW - i, scopes: ["alpha"], sources: ["e"],
    text: `Historian release decision ${i}: ${"detail ".repeat(120)}` }))
  const block = memoryBlock(many)
  expect(block.length).toBeLessThanOrEqual(6000)
  expect(block).toContain("Historian release decision 0")
})

test("a short follow-up borrows the previous user message for context", () => {
  expect(contextQuery([
    { role: "user", content: "Which release is deployed?" },
    { role: "assistant", content: "Release 138c." },
    { role: "user", content: [{ type: "text", text: "Is it working?" }] },
  ])).toBe("Which release is deployed?\nIs it working?")
  expect(contextQuery([{ role: "user", content: "Old question" }, { role: "user", content: "Which release is deployed and how are historian sessions hidden?" }]))
    .toBe("Which release is deployed and how are historian sessions hidden?")
})

test("through the plugin hook: irrelevant turns get no memory block; relevant ones do", async () => {
  const host = await startHost({})
  const archive = new Archive(host.archivePath)
  try {
    const project = archive.project(host.directory)
    for (const row of [...filler(30), { id: "release", text: "Release 138c was deployed and historian sessions are hidden as child sessions." }]) {
      archive.capture({ id: `e-${row.id}`, project, session: "s", message: row.id, kind: "assistant", at: 1, text: row.text, payload: "{}" }, false)
      archive.remember({ id: row.id, text: row.text, at: NOW, status: "confirmed", scopes: [project], sources: [`e-${row.id}`] })
    }
    expect((await host.context("ses_work", "Write a haiku about the ocean")).system).toEqual([])
    const relevant = (await host.context("ses_work", "Which release is deployed and are historian sessions hidden?")).system.map(part => part.text).join("\n")
    expect(relevant).toContain("Release 138c was deployed")
    expect(relevant).not.toContain("Routine note")
  } finally { host.dispose(); await Bun.sleep(20); archive.close(); removeRoot(host.root) }
})
