// A fake OpenCode host: the external boundary the plugin talks to. Each
// capability records what the plugin asked of OpenCode, so tests can check
// behaviour the host would observe (sessions created, prompts sent).
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupUnified } from "../src/unified.ts"

type Generate = (prompt: string, signal: AbortSignal) => Promise<string>
type Tool = { name: string; execute: (input: unknown, context: { sessionID: string; signal: AbortSignal }) => Promise<{ content: string }> }
export type ContextEvent = {
  sessionID: string
  tools: Record<string, unknown>
  system: Array<{ type: string; text: string }>
  messages: Array<{ role: string; content: string }>
}

export interface Host {
  root: string
  archivePath: string
  /** Every prompt the plugin sent to a model, in order. */
  prompts: string[]
  /** Sessions the plugin asked OpenCode to create. */
  created: unknown[]
  tools: Map<string, Tool>
  context(sessionID: string, user: string): Promise<ContextEvent>
  dispose(): void
}

export async function startHost(options: {
  root?: string
  directory?: string
  generate?: Generate
  models?: Array<{ providerID: string; id: string }>
}): Promise<Host> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "optmem-host-"))
  const archivePath = join(root, "archive.sqlite")
  const directory = options.directory ?? join(root, "alpha")
  const prompts: string[] = []
  const created: unknown[] = []
  const tools = new Map<string, Tool>()
  let hook!: (event: ContextEvent) => Promise<void>
  const generate = options.generate ?? (async () => JSON.stringify({ memories: [] }))

  const ctx = {
    options: { archivePath, memoryDir: join(root, "no-legacy-store") },
    location: { directory, project: { canonical: directory } },
    tool: { transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => callback({ add: tool => tools.set(tool.name, tool) }) },
    generate: {
      text: async ({ prompt }: { prompt: string }, request?: { signal?: AbortSignal }) => {
        prompts.push(prompt)
        return { text: await generate(prompt, request?.signal ?? new AbortController().signal) }
      },
    },
    session: {
      hook: async (name: string, callback: typeof hook) => { if (name === "context") hook = callback },
      create: async (input: unknown) => { created.push(input); return { id: `ses_created_${created.length}` } },
      get: async () => ({}),
      generate: async ({ prompt }: { prompt: string }) => { prompts.push(prompt); return { text: await generate(prompt, new AbortController().signal) } },
    },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => idle(signal) },
  }

  // SAFETY: the fake implements exactly the context members the plugin uses.
  const dispose = await setupUnified(ctx as unknown as Parameters<typeof setupUnified>[0], options.models ?? [{ providerID: "test", id: "model" }])
  return {
    root, archivePath, prompts, created, tools,
    async context(sessionID, user) {
      const event: ContextEvent = { sessionID, tools: { memory: {}, memo_wake: {}, memo_note: {}, read: {} }, system: [], messages: [{ role: "user", content: user }] }
      await hook(event)
      return event
    },
    dispose,
  }
}

async function* idle(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }))
}

export function removeRoot(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
