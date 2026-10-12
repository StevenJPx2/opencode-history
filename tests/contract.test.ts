// The plugin against the real OptMem tool in a throwaway store: this is the
// contract the layout reader and the scope records have to keep.

import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"
import { Registry } from "../src/registry"
import { SCOPE_REC } from "../src/store"

const memo = join(homedir(), ".optmem", "memo")
const available = existsSync(memo)
const roots: string[] = []

type Tool = { name: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A fresh store, initialised by the real tool. */
function freshStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "optmem-contract-"))
  roots.push(dir)

  execFileSync(memo, ["init"], { env: { ...process.env, MEMORY_DIR: dir } })
  return dir
}

async function load(memoryDir: string, canonical: string) {
  const tools = new Map<string, Tool>()
  const context = {
    options: { memo, memoryDir },
    location: { project: { canonical, directory: canonical, id: "prj_test" } },
    tool: {
      transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => {
        callback({ add: (tool) => tools.set(tool.name, tool) })
      },
    },
    session: {
      get: async () => ({ parentID: undefined }),
      hook: async () => undefined,
    },
  } as unknown as Parameters<typeof plugin.setup>[0]

  await plugin.setup(context)
  return tools
}

const call = (tools: Map<string, Tool>, name: string, input: unknown = {}) =>
  tools.get(name)!.execute(input, { sessionID: "top", signal: new AbortController().signal })

describe.skipIf(!available)("the plugin against the real tool", () => {
  test("wake shows the session's project and global, and another project only on request", async () => {
    const dir = freshStore()
    const alpha = await load(dir, "/projects/alpha")
    Registry.load(dir).keyFor("/projects/beta")

    await call(alpha, "memo_note", { text: "alpha one" })
    await call(alpha, "memo_note", { text: "beta one", scope: "beta" })
    await call(alpha, "memo_note", { text: "global one", scope: "global" })

    const scoped = (await call(alpha, "memo_wake")).content

    expect(scoped).toContain("alpha one")
    expect(scoped).toContain("global one")
    expect(scoped).not.toContain("beta one")
    expect(scoped).toContain("You are awake.")

    const beta = await load(dir, "/projects/beta")
    const fromBeta = (await call(beta, "memo_wake")).content

    expect(fromBeta).toContain("beta one")
    expect(fromBeta).toContain("global one")
    expect(fromBeta).not.toContain("alpha one")

    const all = (await call(alpha, "memo_wake", { scope: "all" })).content

    expect(all).toContain("alpha one")
    expect(all).toContain("beta one")
    expect(all).toContain("global one")
  })

  test("a note lands with its scope, and memo_scope moves it to another project", async () => {
    const dir = freshStore()
    const tools = await load(dir, "/projects/alpha")
    Registry.load(dir).keyFor("/projects/beta")

    await call(tools, "memo_note", { text: "written to the wrong place", scope: "beta" })
    expect((await call(tools, "memo_wake")).content).not.toContain("written to the wrong place")

    const moved = (await call(tools, "memo_scope", { id: 0, scope: "alpha" })).content

    expect(moved).toContain("Scoped #0 to alpha")
    expect((await call(tools, "memo_wake")).content).toContain("written to the wrong place")

    const record = readFileSync(join(dir, "SCOPE.txt")).subarray(0, SCOPE_REC).toString().trim()

    expect(record).toBe("alpha")
  })

  test("an unknown scope is refused, naming the keys it knows", async () => {
    const dir = freshStore()
    const tools = await load(dir, "/projects/alpha")

    await expect(call(tools, "memo_note", { text: "x", scope: "shop" })).rejects.toThrow(/unknown scope: shop/)
  })

  test("recall still reaches another project's memory", async () => {
    const dir = freshStore()
    const alpha = await load(dir, "/projects/alpha")

    await call(alpha, "memo_note", { text: "a distinctive phrase" })
    Registry.load(dir).keyFor("/projects/beta")
    await call(alpha, "memo_note", { text: "another phrase", scope: "beta" })

    const beta = await load(dir, "/projects/beta")

    expect((await call(beta, "memo_recall", { regex: "distinctive" })).content).toContain("a distinctive phrase")
  })
})