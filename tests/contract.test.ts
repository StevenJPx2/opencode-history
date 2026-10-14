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
const cleanups: Array<() => void> = []

type Tool = { name: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }

afterAll(() => {
  for (const cleanup of cleanups) cleanup()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A fresh store, initialised by the real tool. */
function freshStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "optmem-contract-"))
  roots.push(dir)

  execFileSync(memo, ["init"], { env: { ...process.env, MEMORY_DIR: dir } })
  return dir
}

const DEFAULT_MODELS = [
  { providerID: "test", modelID: "test" },
  { providerID: "openai", modelID: "gpt-6-luna", variants: [{ id: "xhigh" }] },
  { providerID: "opencode", modelID: "mimo-v2.6-flash-free", variants: [] },
]

/** The plugin's context, with `options` and any dependency a test replaces. */
function contextFor(
  memoryDir: string,
  canonical: string,
  options: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  const tools = new Map<string, Tool>()
  const context = {
    options: { memo, memoryDir, ...options },
    location: { project: { canonical, directory: canonical, id: "prj_test" } },
    model: { list: async () => ({ data: DEFAULT_MODELS }) },
    generate: { text: async () => ({ text: "a line from the model" }) },
    tool: {
      transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => {
        callback({ add: (tool) => tools.set(tool.name, tool) })
      },
    },
    session: {
      get: async () => ({ parentID: undefined }),
      hook: async () => undefined,
    },
    ...overrides,
  }

  return { tools, context: context as unknown as Parameters<typeof plugin.setup>[0] }
}

async function load(memoryDir: string, canonical: string, options: Record<string, unknown> = {}) {
  const { tools, context } = contextFor(memoryDir, canonical, { compression: false, ...options })

  await activate(context)
  return tools
}

/** Setup with replaced dependencies, keeping the tools for driving the plugin. */
async function setup(
  memoryDir: string,
  canonical: string,
  options: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  const { tools, context } = contextFor(memoryDir, canonical, options, overrides)

  await activate(context)
  return tools
}

async function activate(context: Parameters<typeof plugin.setup>[0]): Promise<void> {
  const cleanup = await plugin.setup(context)
  if (typeof cleanup === "function") cleanups.push(cleanup as () => void)
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
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

describe("the plugin's background compression", () => {
  // The debounce and the backstop are time-based, so the tests shorten both
  // rather than wait them out.
  const soon = { backstopSeconds: 3600, compressDelayMs: 20 }
  const settle = 400

  /** Two notes, which is what makes block #0-1 due. */
  const twoNotes = async (tools: Map<string, Tool>) => {
    await call(tools, "memo_note", { text: "alpha" })
    await call(tools, "memo_note", { text: "beta" })
  }

  test("the notes a session writes are compressed without the session being asked", async () => {
    const dir = freshStore()
    const asked: Array<{ model: string; prompt: string }> = []

    const tools = await setup(
      dir,
      "/projects/alpha",
      soon,
      {
        generate: {
          text: async ({ model, prompt }: { model: { providerID: string; id: string; variant?: string }; prompt: string }) => {
            asked.push({ model: `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`, prompt })
            return { text: "alpha and beta in one line" }
          },
        },
      },
    )
    await twoNotes(tools)
    await sleep(settle)

    expect(tools.size).toBeGreaterThan(0)
    expect(asked).toHaveLength(1)
    expect(asked[0]?.model).toBe("openai/gpt-6-luna#xhigh")
    expect(asked[0]?.prompt).toContain("Compress memories #0-1 into one line of at most 280 bytes.")
    expect(asked[0]?.prompt).toContain("alpha")
    expect(readFileSync(join(dir, "TREE", "2"), "utf8").trim()).toBe("alpha and beta in one line")
  }, 20_000)

  test("nothing is asked when compression is turned off", async () => {
    const dir = freshStore()
    let calls = 0

    const tools = await setup(
      dir,
      "/projects/alpha",
      { compression: false, ...soon },
      {
        generate: {
          text: async () => {
            calls++
            return { text: "unused" }
          },
        },
      },
    )
    await twoNotes(tools)
    await sleep(settle)

    expect(calls).toBe(0)
  }, 20_000)

  test("skips an unavailable primary and uses the free fallback", async () => {
    const dir = freshStore()
    const asked: string[] = []

    const tools = await setup(
      dir,
      "/projects/alpha",
      { model: "opencode/gone-forever", ...soon },
      {
        generate: {
          text: async ({ model }: { model: { providerID: string; id: string } }) => {
            asked.push(`${model.providerID}/${model.id}`)
            return { text: "summary from free fallback" }
          },
        },
      },
    )
    await twoNotes(tools)
    await sleep(settle)

    expect(asked).toEqual(["opencode/mimo-v2.6-flash-free"])
    expect(readFileSync(join(dir, "TREE", "2"), "utf8").trim()).toBe("summary from free fallback")
  }, 20_000)

  test("falls back to the free model when Luna errors", async () => {
    const dir = freshStore()
    const asked: string[] = []

    const tools = await setup(
      dir,
      "/projects/alpha",
      soon,
      {
        generate: {
          text: async ({ model }: { model: { providerID: string } }) => {
            asked.push(model.providerID)
            if (model.providerID === "openai") throw new Error("primary provider is down")

            return { text: "summary from the fallback" }
          },
        },
      },
    )
    await twoNotes(tools)
    await sleep(settle)

    expect(asked).toEqual(["openai", "opencode"])
    expect(readFileSync(join(dir, "TREE", "2"), "utf8").trim()).toBe("summary from the fallback")
  }, 20_000)

  test("leaves the block pending when every configured model fails", async () => {
    const dir = freshStore()
    const asked: string[] = []

    const tools = await setup(
      dir,
      "/projects/alpha",
      soon,
      {
        generate: {
          text: async ({ model }: { model: { providerID: string } }) => {
            asked.push(model.providerID)
            throw new Error("provider is down")
          },
        },
      },
    )
    await twoNotes(tools)
    await sleep(settle)

    expect(asked).toEqual(["openai", "opencode"])
    expect(existsSync(join(dir, "TREE", "2"))).toBe(false)
  }, 20_000)

  test("a too-long model response is left pending after bounded retries", async () => {
    const dir = freshStore()
    let calls = 0

    const tools = await setup(
      dir,
      "/projects/alpha",
      { ...soon, attemptsPerBlock: 2, fallbackModel: false },
      {
        generate: {
          text: async () => {
            calls++
            return { text: "x".repeat(400) }
          },
        },
      },
    )
    await twoNotes(tools)
    await sleep(settle)

    // Two attempts for the block, then it stops rather than looping on it.
    expect(calls).toBe(2)
    expect(existsSync(join(dir, "TREE", "2"))).toBe(false)
  }, 20_000)

  test("the backstop compresses what another session left behind", async () => {
    const dir = freshStore()
    const run = (args: string[]) => execFileSync(memo, args, { env: { ...process.env, MEMORY_DIR: dir }, encoding: "utf8" })

    // Another session's notes, in a store this plugin has not touched.
    run(["note", "alpha"])
    run(["note", "beta"])

    await setup(dir, "/projects/alpha", { backstopSeconds: 1 })
    await sleep(1_500)

    expect(readFileSync(join(dir, "TREE", "2"), "utf8").trim()).toBe("a line from the model")
  }, 20_000)
})
