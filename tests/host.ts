// The host surface the plugin uses: tool registration, the prompt and context
// hooks, and synthetic messages.
import { join } from "node:path"
import plugin from "../src/index.ts"
import { assistant, text, type Fixture } from "./fixture.ts"

type Tool = { name: string; options?: { codemode?: boolean }; execute: (input: unknown, context: { sessionID: string; signal: AbortSignal }) => Promise<{ content: string }> }
type ContextEvent = { sessionID: string; system: Array<{ type: string; text: string }> }
type PromptEvent = { sessionID: string; messageID: string; prompt: { text: string } }
export type Synthetic = { sessionID: string; text: string; resume: boolean; metadata: unknown }

/**
 * Loads the plugin against `f`. `env` is visible only while the plugin sets
 * up, which is when it reads its judge settings.
 */
export async function load(f: Fixture, options: Record<string, unknown> = {}, env: Record<string, string | undefined> = {}) {
  const tools = new Map<string, Tool>()
  const hooks = new Map<string, (event: never) => void | Promise<void>>()
  const synthetics: Synthetic[] = []
  let refuseSynthetic = false
  const ctx = {
    options: { database: f.path, index: join(f.root, "index.sqlite"), ...options },
    tool: { transform: async (callback: (editor: { add: (tool: Tool) => void }) => void) => callback({ add: tool => tools.set(tool.name, tool) }) },
    session: {
      hook: async (name: string, callback: (event: never) => void | Promise<void>) => { hooks.set(name, callback) },
      synthetic: async (input: Synthetic) => {
        if (refuseSynthetic) throw new Error("synthetic refused")
        synthetics.push(input)
        return {}
      },
    },
  }

  const saved = Object.fromEntries(["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_DEFAULT_MODEL"].map(key => [key, process.env[key]]))
  for (const key of Object.keys(saved)) delete process.env[key]
  Object.assign(process.env, Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)))
  let dispose: unknown
  try {
    // SAFETY: the fake implements exactly the context members the plugin uses.
    dispose = await plugin.setup(ctx as unknown as Parameters<typeof plugin.setup>[0])
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  const search = (sessionID: string, input: unknown) => tools.get("history_search")!.execute(input, { sessionID, signal: new AbortController().signal })
  const context = async (sessionID: string) => {
    const event: ContextEvent = { sessionID, system: [] }
    await (hooks.get("context") as ((event: ContextEvent) => void | Promise<void>))(event)
    return event.system.map(part => part.text).join("\n")
  }
  /** Runs the prompt hook, if registered, as OpenCode does before admitting the message. */
  const prompt = async (sessionID: string, messageText: string, messageID = "msg_new") => {
    const hook = hooks.get("prompt") as ((event: PromptEvent) => void | Promise<void>) | undefined
    await hook?.({ sessionID, messageID, prompt: { text: messageText } })
  }
  return {
    tools,
    hooks,
    synthetics,
    search,
    context,
    prompt,
    refuseSynthetics: () => { refuseSynthetic = true },
    dispose: dispose as () => void,
  }
}

export function project(f: Fixture) {
  f.session("ses_old", "p1", "Webhook retries")
  f.message("ses_old", "user", { text: "why does the stripe webhook retry" })
  f.message("ses_old", "assistant", assistant({ type: "tool", name: "bash", state: { output: "idempotency in tool output" } }, text("The idempotency key was missing")))
  f.session("ses_other", "p2", "Other project")
  f.message("ses_other", "assistant", assistant(text("idempotency elsewhere")))
  f.session("ses_now", "p1", "Current work")
  f.message("ses_now", "user", { text: "idempotency again?" })
  f.session("ses_child", "p1", "Explore", "ses_now")
}
