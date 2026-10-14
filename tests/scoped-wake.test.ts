// The scoped view, over a store laid out exactly as OptMem lays it out:
// fixed-width LOG.txt records, fixed-width TREE/<size> summaries, and the
// plugin's own SCOPE.txt.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GLOBAL, LOG_REC, SCOPE_REC, Store, TREE_REC } from "../src/store"
import { matches, scopedView } from "../src/wake"

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length)
}

interface Seed {
  readonly text: string
  readonly scope?: string
}

/** A store holding `memories`, with `summaries` keyed by block size. */
function seed(memories: readonly Seed[], summaries: Readonly<Record<number, readonly string[]>> = {}): Store {
  const dir = mkdtempSync(join(tmpdir(), "optmem-store-"))
  roots.push(dir)

  writeFileSync(
    join(dir, "LOG.txt"),
    memories.map((memory, i) => pad(`#${i} 2026-10-12 ${memory.text}`, LOG_REC)).join(""),
  )

  mkdirSync(join(dir, "TREE"), { recursive: true })

  for (const [size, lines] of Object.entries(summaries)) {
    writeFileSync(
      join(dir, "TREE", size),
      lines.map((line) => pad(line, TREE_REC)).join(""),
    )
  }

  writeFileSync(
    join(dir, "SCOPE.txt"),
    memories
      .map((memory, i) => pad(memory.scope ?? "", SCOPE_REC))
      .join(""),
  )

  const store = Store.open(dir)
  if (store === undefined) throw new Error("seeded store did not open")

  return store
}

const view = (store: Store, watch: readonly string[], budget: number) =>
  scopedView(store, (i) => matches(store.scope(i), watch), budget).lines.map((line) => line.text)

describe("scoped wake", () => {
  test("shows only the session's project and global memories", () => {
    const store = seed([
      { text: "alpha", scope: GLOBAL },
      { text: "beta", scope: "alpha" },
      { text: "gamma", scope: "beta" },
    ])

    expect(view(store, [GLOBAL, "alpha"], 96)).toEqual([
      "#0 2026-10-12 alpha",
      "#1 2026-10-12 beta",
    ])
    expect(view(store, [GLOBAL, "beta"], 96)).toEqual(["#0 2026-10-12 alpha", "#2 2026-10-12 gamma"])
  })

  test("a fully in-scope block stands for itself, and a mixed one splits", () => {
    // [0,2) is global + beta, [2,4) is alpha + alpha, [4,6) is beta + alpha,
    // [6,8) is global + beta: two halves in scope by half, one whole.
    const store = seed(
      [
        { text: "one", scope: GLOBAL },
        { text: "two", scope: "beta" },
        { text: "three", scope: "alpha" },
        { text: "four", scope: "alpha" },
        { text: "five", scope: "beta" },
        { text: "six", scope: "alpha" },
        { text: "seven", scope: GLOBAL },
        { text: "eight", scope: "beta" },
      ],
      { 2: ["s1 s2", "s3 s4", "s5 s6", "s7 s8"] },
    )

    expect(view(store, [GLOBAL, "alpha"], 4)).toEqual([
      "#0 2026-10-12 one",
      "#2-3 s3 s4",
      "#5 2026-10-12 six",
      "#6 2026-10-12 seven",
    ])
  })

  test("never emits a mixed summary even when 75 percent is in scope", () => {
    const store = seed([
      { text: "one", scope: "alpha" },
      { text: "two", scope: "alpha" },
      { text: "three", scope: "alpha" },
      { text: "secret beta", scope: "beta" },
    ], { 2: ["alpha pair", "alpha plus secret beta"], 4: ["mostly alpha but secret beta"] })

    const lines = view(store, ["alpha"], 2)

    expect(lines.join("\n")).not.toContain("secret beta")
    expect(lines).toEqual(["#0-1 alpha pair", "#2 2026-10-12 three"])
  })

  test("splits a block whose summary is not built instead of refusing", () => {
    const store = seed([
      { text: "one", scope: "alpha" },
      { text: "two", scope: "alpha" },
      { text: "three", scope: "alpha" },
      { text: "four", scope: "alpha" },
    ])

    expect(view(store, [GLOBAL, "alpha"], 4)).toEqual([
      "#0 2026-10-12 one",
      "#1 2026-10-12 two",
      "#2 2026-10-12 three",
      "#3 2026-10-12 four",
    ])
  })

  test("an unscoped memory is in no session's wake, and global is in every one", () => {
    const store = seed([{ text: "loose" }, { text: "kept", scope: GLOBAL }])

    expect(view(store, [GLOBAL, "alpha"], 96)).toEqual(["#1 2026-10-12 kept"])
    expect(view(store, ["alpha"], 96)).toEqual(["#1 2026-10-12 kept"])
  })

  test("empty and out-of-scope stores produce no lines", () => {
    expect(view(seed([]), [GLOBAL, "alpha"], 96)).toEqual([])
    expect(view(seed([{ text: "a", scope: "beta" }]), [GLOBAL, "alpha"], 96)).toEqual([])
  })

  test("scope records survive a write and read back per memory", () => {
    const store = seed([{ text: "one" }, { text: "two" }])

    store.writeScope(0, [GLOBAL, "alpha"])
    store.writeScope(1, ["beta"])

    expect(store.scope(0)).toEqual([GLOBAL, "alpha"])
    expect(store.scope(1)).toEqual(["beta"])
  })
})
