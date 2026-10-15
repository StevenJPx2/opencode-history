// The historian's model chain: the primary answers first, then each configured
// fallback in order, skipping models OpenCode cannot run.
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import plugin from "../src/index"
import { Archive } from "../src/archive.ts"
import { importTranscript } from "../src/capture.ts"

const LISTED = [
  { providerID: "openai", modelID: "gpt-6-luna", variants: [{ id: "xhigh" }] },
  { providerID: "opencode", modelID: "space-bunny-free", variants: [] },
  { providerID: "opencode", modelID: "mimo-v2.6-flash-free", variants: [] },
]

const turn = JSON.stringify({ info: { id: "ses_chain" }, messages: [
  { id: "u", type: "user", text: "Shall the archive keep a fallback chain of models?", time: { created: 10 } },
  { id: "a", type: "assistant", content: [{ type: "text", text: "Decision confirmed: the archive tries every configured model in order." }], time: { created: 11, completed: 12 } },
] })

/** The plugin's own context, with a model list and a generate double that records. */
function context(root: string, options: Record<string, unknown>, ask: (model: string) => Promise<string>) {
  const asked: string[] = []
  const ctx = {
    options: { mode: "unified", archivePath: join(root, "archive.sqlite"), memoryDir: join(root, "no-store"), ...options },
    location: { directory: join(root, "alpha"), project: { canonical: join(root, "alpha") } },
    model: { list: async () => ({ data: LISTED }) },
    generate: {
      text: async ({ model, prompt }: { model: { providerID: string; id: string; variant?: string }; prompt: string }) => {
        const name = `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
        asked.push(name)
        return { text: await ask(name) }
      },
    },
    tool: { transform: async (callback: (editor: { add: (tool: unknown) => void }) => void) => callback({ add: () => undefined }) },
    session: { hook: async () => undefined, get: async () => ({}), create: async () => ({ id: "ses_created" }) },
    event: { subscribe: async function* ({ signal }: { signal: AbortSignal }) { await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })) } },
  }
  return { asked, ctx: ctx as unknown as Parameters<typeof plugin.setup>[0] }
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && !check()) await Bun.sleep(10)
  return check()
}

function rootWithWork(): string {
  const root = mkdtempSync(join(tmpdir(), "optmem-chain-"))
  const seed = new Archive(join(root, "archive.sqlite"))
  importTranscript(seed, seed.project(join(root, "alpha")), turn, "ses_chain")
  seed.close()
  return root
}

test("a fallback list is tried in order, and models OpenCode cannot run are skipped", async () => {
  const root = rootWithWork()
  const { asked, ctx } = context(root, {
    model: "openai/gpt-6-luna#xhigh",
    fallbackModels: ["opencode/gone-forever", "opencode/space-bunny-free"],
  }, async name => {
    if (name.startsWith("openai/")) throw new Error("provider is down")
    return JSON.stringify({ memories: [] })
  })
  const dispose = await plugin.setup(ctx)
  try {
    expect(await until(() => asked.length > 0)).toBe(true)
    // The unavailable model is never called: opencode/space-bunny-free answers.
    expect(asked).toEqual(["openai/gpt-6-luna#xhigh", "opencode/space-bunny-free"])
  } finally { (dispose as () => void)?.(); await Bun.sleep(20); rmSync(root, { recursive: true, force: true }) }
})

test("a single fallback string still works, and false still disables them", async () => {
  const single = rootWithWork()
  const first = context(single, { model: "openai/gpt-6-luna#xhigh", fallbackModel: "opencode/mimo-v2.6-flash-free" },
    async name => name.startsWith("openai/") ? Promise.reject(new Error("provider is down")) : JSON.stringify({ memories: [] }))
  const disposeSingle = await plugin.setup(first.ctx)
  try {
    expect(await until(() => first.asked.length > 0)).toBe(true)
    expect(first.asked).toEqual(["openai/gpt-6-luna#xhigh", "opencode/mimo-v2.6-flash-free"])
  } finally { (disposeSingle as () => void)?.(); await Bun.sleep(20); rmSync(single, { recursive: true, force: true }) }

  const none = rootWithWork()
  const second = context(none, { model: "openai/gpt-6-luna#xhigh", fallbackModel: false, fallbackModels: ["opencode/space-bunny-free"] },
    async () => JSON.stringify({ memories: [] }))
  const disposeNone = await plugin.setup(second.ctx)
  try {
    expect(await until(() => second.asked.length > 0)).toBe(true)
    await Bun.sleep(50)
    expect(second.asked).toEqual(["openai/gpt-6-luna#xhigh"])
  } finally { (disposeNone as () => void)?.(); await Bun.sleep(20); rmSync(none, { recursive: true, force: true }) }
})

test("a repeated model appears once, keeping the order it was configured in", async () => {
  const root = rootWithWork()
  const { asked, ctx } = context(root, {
    model: "opencode/space-bunny-free",
    fallbackModels: ["opencode/space-bunny-free", "opencode/mimo-v2.6-flash-free", "opencode/gone-forever"],
  }, async () => JSON.stringify({ memories: [] }))
  const dispose = await plugin.setup(ctx)
  try {
    expect(await until(() => asked.length > 0)).toBe(true)
    expect(asked).toEqual(["opencode/space-bunny-free"])
  } finally { (dispose as () => void)?.(); await Bun.sleep(20); rmSync(root, { recursive: true, force: true }) }
})