import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import plugin from "../src/index"

type Tool = {
  name: string
  options?: { codemode?: boolean }
  execute: (input: unknown, context: unknown) => Promise<{ content: string }>
}
type ContextEvent = { sessionID: string; system: Array<{ type: string; text: string }>; tools: Record<string, unknown> }

const root = mkdtempSync(join(tmpdir(), "optmem-test-"))
const memo = join(root, "memo")
const memoryDir = join(root, "memory")
const project = "/home/user/projects/example"

// Stub memo: echoes its argv one per line; bare `wake` exits 1 with stdout, like the real tool when a compression is due.
writeFileSync(
  memo,
  `#!/bin/sh
[ "$1" = wake ] && [ $# -eq 1 ] && { echo "Cannot wake: compress first."; exit 1; }
printf 'MEMORY_DIR=%s\\n' "$MEMORY_DIR"
for a in "$@"; do printf '[%s]\\n' "$a"; done
`,
)
chmodSync(memo, 0o755)

afterAll(() => rmSync(root, { recursive: true, force: true }))

async function load(memoPath = memo, canonical = project, options: Record<string, unknown> = {}) {
  const tools = new Map<string, Tool>()
  let hook!: (event: ContextEvent) => Promise<void>
  const context = {
    options: { memo: memoPath, memoryDir, compression: false, ...options },
    location: { project: { canonical, directory: canonical, id: "prj_test" } },
    // The models the background compressor would consider, and a reply.
    model: {
      list: async () => ({
        data: [
          { providerID: "test", modelID: "test" },
          { providerID: "opencode", modelID: "mimo-v2.6-flash-free" },
        ],
      }),
    },
    generate: { text: async () => ({ text: "a line from the model" }) },
    tool: {
      transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => {
        callback({ add: (tool) => tools.set(tool.name, tool) })
      },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ parentID: sessionID === "child" ? "parent" : undefined }),
      hook: async (name: string, callback: typeof hook) => {
        if (name === "context") hook = callback
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0]
  await plugin.setup(context)
  return { tools, hook }
}

function call(tools: Map<string, Tool>, name: string, input: unknown, sessionID = "top") {
  return tools.get(name)!.execute(input, { sessionID, signal: new AbortController().signal })
}

function event(sessionID: string): ContextEvent {
  return { sessionID, system: [], tools: { memo_wake: {}, memo_note: {}, read: {} } }
}

describe("optmem", () => {
  test("registers every memo tool as a direct tool, not behind Code Mode", async () => {
    const { tools } = await load()

    expect([...tools.keys()].sort()).toEqual([
      "memo_forget",
      "memo_nap",
      "memo_note",
      "memo_recall",
      "memo_scope",
      "memo_wake",
      "memo_zoom",
    ])

    for (const tool of tools.values()) expect(tool.options?.codemode).toBe(false)
  })
  test("passes text as one argv entry, with MEMORY_DIR set", async () => {
    const { tools } = await load()
    const tricky = `it's "quoted" $HOME \`x\``
    const { content } = await call(tools, "memo_note", { text: tricky })
    expect(content).toBe(`MEMORY_DIR=${join(root, "memory")}\n[note]\n[${tricky}]`)
  })

  test("maps optional arguments onto memo's positional ones", async () => {
    const { tools } = await load()
    expect((await call(tools, "memo_wake", { scope: "all", part: 2, snapshot: 296 })).content).toEndWith("[wake]\n[2]\n[296]")
    expect((await call(tools, "memo_nap", { block: "0-1", summary: "s" })).content).toEndWith("[nap]\n[0-1]\n[s]")
    expect((await call(tools, "memo_nap", {})).content).toEndWith("[nap]")
    await expect(call(tools, "memo_nap", { block: "0-1" })).rejects.toThrow("both block and summary")
    await expect(call(tools, "memo_wake", { snapshot: 3 })).rejects.toThrow("snapshot requires part")
  })

  test("returns instructions printed before a non-zero exit, and throws stderr-only failures", async () => {
    const { tools } = await load()
    await expect(call(tools, "memo_wake", {})).rejects.toThrow("Cannot read scoped OptMem store")
    expect((await call(tools, "memo_wake", { scope: "all" })).content).toBe("Cannot wake: compress first.")

    const dies = join(root, "dies")
    writeFileSync(dies, `#!/bin/sh\necho "No memory at x." >&2\nexit 1\n`)
    chmodSync(dies, 0o755)
    const { tools: dying } = await load(dies)
    await expect(call(dying, "memo_recall", { regex: "x" })).rejects.toThrow("No memory at x.")
  })

  test("injects the prompt for top-level sessions only and hides tools from subagents", async () => {
    const { tools, hook } = await load()

    const top = event("top")
    await hook(top)
    expect(top.system).toHaveLength(1)
    expect(top.system[0]!.text).toContain("Call memo_wake before any other tool call")
    expect(Object.keys(top.tools)).toEqual(["memo_wake", "memo_note", "read"])

    const child = event("child")
    await hook(child)
    expect(child.system).toHaveLength(0)
    expect(Object.keys(child.tools)).toEqual(["read"])
    await expect(call(tools, "memo_note", { text: "x" }, "child")).rejects.toThrow("You are a subagent")
  })

  test("stays silent when memo is not installed", async () => {
    const { tools, hook } = await load(join(root, "missing"))
    const top = event("top")
    await hook(top)
    expect(top.system).toHaveLength(0)
    expect(Object.keys(top.tools)).toEqual(["read"])
    await expect(call(tools, "memo_wake", {})).rejects.toThrow("OptMem is not installed")
  })
})
