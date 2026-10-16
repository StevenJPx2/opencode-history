// A fake OpenCode host: the external boundary the plugin talks to. Each
// capability records what the plugin asked of OpenCode, so tests can check
// behaviour the host would observe (sessions created, prompts sent).
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupUnified } from "../src/unified.ts"

type Generate = (prompt: string, signal: AbortSignal, model: string) => Promise<string>
type Tool = { name: string; execute: (input: unknown, context: { sessionID: string; signal: AbortSignal }) => Promise<{ content: string }> }
export type ContextEvent = {
  sessionID: string
  tools: Record<string, unknown>
  system: Array<{ type: string; text: string }>
  messages: Array<{ role: string; content: string | Array<{ type: string; text: string }> }>
}

export interface SessionRecord {
  created: Array<{ id: string; title?: string; parentID?: string; model?: { providerID: string; id: string; variant?: string } }>
  archived: string[]
  removed: string[]
  generated: Array<{ sessionID: string; prompt: string }>
  prompted: Array<{ sessionID: string; prompt: string }>
  /** Why a scripted answer was not available, for diagnosing a failing test. */
  errors: string[]
}

export interface Host {
  root: string
  directory: string
  archivePath: string
  /** Every prompt the plugin sent to a model, in order. */
  prompts: string[]
  /** Prompts sent to the stateless generate route, which memory should never use. */
  stateless: number
  /** Sessions the plugin asked OpenCode to create. */
  created: unknown[]
  sessions: SessionRecord
  tools: Map<string, Tool>
  context(sessionID: string, user: string | Array<{ type: string; text: string }>): Promise<ContextEvent>
  dispose(): void
}

export async function startHost(options: {
  root?: string
  directory?: string
  generate?: Generate
  models?: Array<{ providerID: string; id: string; variant?: string }>
  /** Answers per model; anything not scripted fails as an outage. */
  script?: Record<string, Array<string | Error>>
  /** Extra plugin options, such as `embeddingURL`. */
  options?: Record<string, unknown>
}): Promise<Host> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "optmem-host-"))
  const archivePath = join(root, "archive.sqlite")
  const directory = options.directory ?? join(root, "alpha")
  const prompts: string[] = []
  const created: unknown[] = []
  const sessions: SessionRecord = { created: [], archived: [], removed: [], generated: [], prompted: [], errors: [] }
  const tools = new Map<string, Tool>()
  let stateless = 0
  let hook!: (event: ContextEvent) => Promise<void>
  let counter = 0
  const script = options.script ? { ...options.script } : {}
  const generate = options.generate ?? (async (prompt, signal, model) => {
    const reply = script[model]?.shift()
    if (reply === undefined) {
      sessions.errors.push(`no scripted reply for ${model} (have ${Object.keys(script).join(",")})`)
      throw Object.assign(new Error(`no scripted reply for ${model}`), { _tag: "ServiceUnavailableError" })
    }
    if (reply instanceof Error) throw reply
    return reply
  })

  const ctx = {
    options: { archivePath, memoryDir: join(root, "no-legacy-store"), ...options.options },
    location: { directory, project: { canonical: directory } },
    tool: { transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => callback({ add: tool => tools.set(tool.name, tool) }) },
    generate: {
      text: async ({ model, prompt }: { model: { providerID: string; id: string; variant?: string }; prompt: string }, request?: { signal?: AbortSignal }) => {
        stateless++
        prompts.push(prompt)
        return { text: await generate(prompt, request?.signal ?? new AbortController().signal, `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`) }
      },
    },
    session: {
      hook: async (name: string, callback: typeof hook) => { if (name === "context") hook = callback },
      create: async (input: { title?: string; parentID?: string; model?: { providerID: string; id: string; variant?: string } }) => {
        counter++
        const id = `ses_historian_${counter}`
        created.push(input)
        sessions.created.push({ id, ...input })
        return { id, ...input }
      },
      update: async ({ sessionID, time }: { sessionID: string; time?: { archived?: number } }) => {
        if (time?.archived) sessions.archived.push(sessionID)
      },
      remove: async ({ sessionID }: { sessionID: string }) => { sessions.removed.push(sessionID) },
      prompt: async ({ sessionID, text }: { sessionID: string; text: string }) => { sessions.prompted.push({ sessionID, prompt: text }); return {} },
      list: async () => ({ data: [{ id: "ses_work", title: "Ordinary user work" }] }),
      context: async () => [],
      get: async ({ sessionID }: { sessionID: string }) => {
        const row = sessions.created.find(entry => entry.id === sessionID)
        if (row) return row
        throw Object.assign(new Error("not found"), { _tag: "SessionNotFoundError" })
      },
      generate: async ({ sessionID, prompt }: { sessionID: string; prompt: string }, request?: { signal?: AbortSignal }) => {
        sessions.generated.push({ sessionID, prompt })
        prompts.push(prompt)
        const session = sessions.created.find(entry => entry.id === sessionID)
        const model = session?.model
        return { text: await generate(prompt, request?.signal ?? new AbortController().signal, model ? `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}` : "unknown") }
      },
    },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => idle(signal) },
  }

  // SAFETY: the fake implements exactly the context members the plugin uses.
  const dispose = await setupUnified(ctx as unknown as Parameters<typeof setupUnified>[0], options.models ?? [{ providerID: "test", id: "model" }])
  return {
    root, directory, archivePath, prompts, created, sessions, tools,
    get stateless() { return stateless },
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
