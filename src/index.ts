// OptMem (https://github.com/VictorTaelin/OptMem): permanent memory for agents.
//
// The instructions go into every top-level session, `memo` runs through native
// memo_* tools (argv, so a note is never rewritten by a shell), and subagent
// sessions get neither the instructions nor the tools.
//
// Memories are scoped. `memo_note` records under the session's own project by
// default, and `memo_wake` renders the store's own tree filtered to that
// project plus `global`. Any memory stays reachable through `memo_recall` and
// `memo_zoom`, so nothing is lost to a session that never worked on it.
//
// Blocks due for a summary are compressed in the background by a cheap model,
// so no session has to answer them.

import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import { Registry } from "./registry.ts"
import { renderWake } from "./render.ts"
import { GLOBAL, Store, readSizes } from "./store.ts"
import { Compressor, runnable, type Listed, type Model } from "./worker.ts"
import { matches, scopedView, type Relevant } from "./wake.ts"
import { setupUnified } from "./unified.ts"

const INSTALL = "curl -fsSL https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh"
const TOOL_NAMES = ["memo_wake", "memo_note", "memo_nap", "memo_recall", "memo_zoom", "memo_forget", "memo_scope"]

/** Primary model and free fallback for background compression. */
const DEFAULT_MODEL = "openai/gpt-6-luna#xhigh"
const DEFAULT_FALLBACK_MODEL = "opencode/mimo-v2.6-flash-free"
const DEFAULT_BACKSTOP_SECONDS = 300
const DEFAULT_DELAY_MS = 2_000
const BLOCKS_PER_PASS = 8
const ATTEMPTS_PER_BLOCK = 3

/** `provider/id#variant`, or an explicit reference. */
export function modelRef(option: unknown, fallback = DEFAULT_MODEL): Model {
  if (typeof option !== "string") {
    if (option && typeof option === "object") {
      const { providerID, id, variant } = option as { providerID?: unknown; id?: unknown; variant?: unknown }
      if (typeof providerID === "string" && typeof id === "string") {
        return { providerID, id, ...(typeof variant === "string" ? { variant } : {}) }
      }
    }

    return modelRef(fallback, "")
  }

  const slash = option.indexOf("/")
  if (slash === -1) return { providerID: option, id: "" }

  const selector = option.slice(slash + 1)
  const hash = selector.indexOf("#")
  const id = hash === -1 ? selector : selector.slice(0, hash)
  const variant = hash === -1 ? undefined : selector.slice(hash + 1)

  return { providerID: option.slice(0, slash), id, ...(variant ? { variant } : {}) }
}

function modelName(model: Model): string {
  return `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`
}

/**
 * The historian's chain: the primary first, then every configured fallback in
 * order, deduplicated. `fallbackModel` accepts a string or a list, and
 * `fallbackModels` always takes a list; `false` means no fallbacks at all.
 */
export function modelChain(options: Record<string, unknown>, defaults: { fallback?: string } = {}): Model[] {
  const configured: unknown[] = []
  // An explicit false means no fallbacks at all; only silence falls back to the default.
  const disabled = options.fallbackModel === false || options.fallbackModels === false
  for (const [key, value] of [["fallbackModel", options.fallbackModel], ["fallbackModels", options.fallbackModels]] as const) {
    if (value === false || value === undefined || value === null) continue
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (typeof entry === "string" && entry.trim()) configured.push(entry.trim())
      else if (entry && typeof entry === "object") configured.push(entry)
    }
  }
  const fallback = disabled ? undefined : (configured.length > 0 ? undefined : defaults.fallback)
  const chain = [
    modelRef(options.model),
    ...configured.map(entry => modelRef(entry, "")),
    ...(fallback === undefined ? [] : [modelRef(fallback)]),
  ]
  return chain.filter((model, index, all) => all.findIndex((other) => modelName(other) === modelName(model)) === index)
}

function positive(option: unknown, fallback: number): number {
  return typeof option === "number" && Number.isInteger(option) && option > 0 ? option : fallback
}

/** One startup line per process, however many times the plugin is set up. */
let announced = false
const BLOCK = {
  type: "string",
  pattern: "^\\d+-\\d+$",
  description: "A block id exactly as memo prints it, e.g. 16-31",
} as const

function expand(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path
}

function pretty(path: string): string {
  const home = homedir()
  return path.startsWith(home + "/") ? "~" + path.slice(home.length) : path
}

function instructions(memo: string, data: string): string {
  return `## Memory

Your memory is OptMem:
- The tools are memo_wake, memo_note, memo_nap, memo_recall, memo_zoom, memo_forget and memo_scope
- Your memories are in \`${data}\`

OptMem outlives every session, compaction, model and vendor change.
Without it you do not know who you are, or what was decided and tried.

### At startup: activating OptMem (mandatory)

Call memo_wake before any other tool call, in every session, and
then do exactly what it prints, to the end of its output.

Its output names shell commands such as \`${memo} nap 0-1 "<your line>"\` or
\`${memo} wake 2 296\`. Run each one through the matching tool instead of the
shell: memo_nap { block: "0-1", summary: "<your line>" }, memo_wake { part: 2, snapshot: 296 }.

### Scopes: what wake shows you

memo_wake shows your memories for this project plus the ones scoped \`global\`,
the preferences you want in every project. Memories of other projects are not
in your wake; they are one memo_recall away, and memo_zoom opens any of them
whole. Every wake names its scope, so you know how much of the store you hold.

memo_note records under this project unless you pass scope: "global" for
enduring user preferences relevant to every project. Project incidents and
general tool/platform findings belong to their project, not global. Use a
comma-separated list such as
scope: "orchestrator,feeds" when it belongs to several. memo_scope moves a
memory you recorded under the wrong scope. Do not re-note what already exists.

### While working: register memories (mandatory)

Call memo_note with one line of at most 280 bytes whenever you learn
something new, or something worth keeping happens. That covers a task
worth real effort, a fact or insight the user teaches you, anything you
learn about their life (even indirectly), any event of lasting effect.

Due blocks are compressed in the background. If compression is disabled or
the worker leaves a block pending, you can answer it with memo_nap.

Never edit or delete anything under \`${data}\`: the tools manage it.

### When you need an old memory: search, or navigate

memo_recall searches every memory ever recorded, word for word (case-insensitive regex).

Your memories also form a binary tree: #0-1, #2-3 ... exist as one-line
summaries, pairs of those as #0-3, and so on -- every \`#a-b\` line wake
prints is one node of it. memo_zoom opens a node into its two halves,
down to the raw memories.`
}

/** Skip configured models OpenCode cannot resolve, keeping the configured order. */
async function available(ctx: { model: { list(): Promise<{ data: readonly Listed[] }> } }, configured: readonly Model[], log: (message: string) => void): Promise<Model[]> {
  try {
    const listed = (await ctx.model.list()).data
    const usable = configured.filter((model) => runnable(listed, model))

    for (const model of configured) {
      if (!usable.some((entry) => modelName(entry) === modelName(model))) {
        log(`skipping unavailable compression model ${modelName(model)}`)
      }
    }

    return usable
  } catch (error) {
    log(`cannot list models (${error}); will try configured models in order`)
    return [...configured]
  }
}

export default Plugin.define({
  id: "optmem",
  async setup(ctx) {
    if (ctx.options.mode === "unified") {
      // The primary always gets first refusal, and a vanished model costs no call.
      const models = await available(ctx, modelChain(ctx.options, { fallback: DEFAULT_FALLBACK_MODEL }), message => console.log(`[optmem] ${message}`))
      return setupUnified(ctx, models)
    }
    const memo = expand(typeof ctx.options.memo === "string" ? ctx.options.memo : "~/.optmem/memo")
    const memoryDir = expand(
      typeof ctx.options.memoryDir === "string"
        ? ctx.options.memoryDir
        : process.env.MEMORY_DIR || "~/.optmem/memory",
    )
    const prompt = instructions(pretty(memo), pretty(memoryDir))
    const parents = new Map<string, Promise<boolean>>()
    // Keyed on the canonical directory, so every worktree of a repository
    // shares one scope.
    const watch = Registry.load(memoryDir).keyFor(ctx.location.project.canonical)
    const scopes = [GLOBAL, watch]
    const compressing = existsSync(memo) && ctx.options.compression !== false
    const log = (message: string) => console.log(`[optmem] ${message}`)
    const configured = modelChain(ctx.options, { fallback: DEFAULT_FALLBACK_MODEL })
    const models = compressing ? await available(ctx, configured, log) : []

    if (compressing && models.length === 0) {
      log("background compression off: none of the configured models are available")
    }

    const compressor = models.length > 0
      ? new Compressor({
          call: (args) => run(args),
          ask: async (prompt, model) => (await ctx.generate.text({ model, prompt })).text,
          log,
          models,
          perPass: positive(ctx.options.blocksPerPass, BLOCKS_PER_PASS),
          attempts: positive(ctx.options.attemptsPerBlock, ATTEMPTS_PER_BLOCK),
        })
      : undefined

    function isSubagent(sessionID: string): Promise<boolean> {
      let known = parents.get(sessionID)
      if (!known) {
        known = ctx.session.get({ sessionID }).then(
          (session) => Boolean(session.parentID),
          () => {
            parents.delete(sessionID)
            return false
          },
        )
        parents.set(sessionID, known)
      }
      return known
    }

    /** Runs `memo` and returns its output, whether or not it exited zero. */
    function run(args: string[], signal?: AbortSignal): Promise<string> {
      if (!existsSync(memo)) {
        return Promise.reject(new Error(`OptMem is not installed at ${pretty(memo)}. Ask the user to run: ${INSTALL}`))
      }

      return new Promise<string>((resolve, reject) => {
        execFile(
          memo,
          args,
          { env: { ...process.env, MEMORY_DIR: memoryDir }, signal, timeout: 30_000, maxBuffer: 4 << 20 },
          (error, stdout, stderr) => {
            const output = [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join("\n")
            // wake and nap exit 1 with instructions on stdout; that is output, not failure.
            if (error && !stdout.trim()) reject(new Error(output || error.message))
            else resolve(output)
          },
        )
      })
    }

    /** `run`, once the caller is known to be a top-level session. */
    async function call(args: string[], context: { sessionID: string; signal: AbortSignal }): Promise<string> {
      if (await isSubagent(context.sessionID)) {
        throw new Error("You are a subagent. Don't run memo: only the top-level session records memories.")
      }

      return run(args, context.signal)
    }

    /** The scope keys of `text`, validated against the registry. */
    function parseScope(text: string | undefined): readonly string[] {
      if (text === undefined || text === "") return [watch]

      const keys = text.split(",").map((key) => key.trim()).filter(Boolean)
      const registry = Registry.load(memoryDir)
      const unknown = keys.filter((key) => !registry.has(key) && key !== GLOBAL)

      if (unknown.length > 0) {
        throw new Error(
          `unknown scope: ${unknown.join(", ")}. Known: ${[GLOBAL, ...registry.list().keys()].join(", ") || GLOBAL}.`,
        )
      }

      return keys
    }

    /** The scoped view must never fall back to an unfiltered global wake. */
    async function view(
      part: number | undefined,
      snapshot: number | undefined,
      context: { sessionID: string; signal: AbortSignal },
    ): Promise<{ content: string }> {
      if (!existsSync(memo)) throw new Error(`OptMem is not installed at ${pretty(memo)}`)
      if (await isSubagent(context.sessionID)) throw new Error("You are a subagent. Don't run memo.")

      const store = Store.open(memoryDir)

      if (store === undefined) {
        throw new Error(`Cannot read scoped OptMem store at ${pretty(memoryDir)}. Use scope: "all" only if you want an unfiltered wake.`)
      }

      try {
        const sizes = readSizes(memoryDir)
        const total = store.count()
        const seen = snapshot === undefined ? total : Math.min(snapshot, total)
        const relevant: Relevant = (i) => matches(store.scope(i), scopes)
        const rendered = scopedView(store, relevant, sizes.wakeLines)

        // No pending-compression footer: memo's prompt quotes the raw memories
        // of the next global block, which can belong to another project. The
        // background worker handles that queue independently.
        return {
          content: renderWake({
            lines: rendered.lines,
            total: seen,
            scopes,
            part: part ?? 1,
            snapshot: rendered.snapshot,
            sizes,
            awake: "You are awake.",
          }),
        }
      } finally {
        store.close()
      }
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "memo_wake",
        description:
          "Read your OptMem memory: your project's memories plus the ones scoped global. Call first, before any other tool, " +
          "in every session, then do exactly what it prints. Long views arrive in parts: pass the part and snapshot it names.",
        input: {
          type: "object",
          properties: {
            part: { type: "integer", minimum: 1, description: "Part to read, as named by the previous part's footer" },
            snapshot: { type: "integer", minimum: 0, description: "The memory count from that footer; requires part" },
            scope: {
              type: "string",
              enum: ["project", "all"],
              description: "'project' (default) shows this project and global; 'all' shows every memory",
            },
          },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { part, snapshot, scope } = input as { part?: number; snapshot?: number; scope?: string }
          if (snapshot !== undefined && part === undefined) throw new Error("snapshot requires part")

          if (scope === "all") {
            const args = ["wake"]
            if (part !== undefined) args.push(String(part))
            if (snapshot !== undefined) args.push(String(snapshot))
            return { content: await call(args, context) }
          }

          return view(part, snapshot, context)
        },
      })

      editor.add({
        name: "memo_note",
        description:
          "Record one memory in OptMem: one line, at most 280 bytes, scoped to this project unless you pass a scope. " +
          "Use whenever you learn something new or something worth keeping happens. Due blocks are compressed in the background; " +
          "if compression is disabled or a block stays pending, answer it with memo_nap.",
        input: {
          type: "object",
          properties: {
            text: { type: "string", minLength: 1, description: "The memory: one line, at most 280 bytes" },
            scope: {
              type: "string",
              description: "'global' for something true in every project, or a comma-separated list of project keys such as 'orchestrator,feeds'",
            },
          },
          required: ["text"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { text, scope } = input as { text: string; scope?: string }
          const keys = parseScope(scope)
          const content = await call(["note", text], context)
          const store = Store.open(memoryDir)
          const saved = /Saved as #(\d+)\./.exec(content)

          if (store !== undefined && saved?.[1] !== undefined) {
            try {
              store.writeScope(Number(saved[1]), keys)
            } finally {
              store.close()
            }
          }

          // A note is what makes a block due, so it is the trigger worth
          // reacting to; the backstop covers another session's notes. Notes
          // often come in bursts, so waits are collapsed into one pass.
          compressor?.schedule(positive(ctx.options.compressDelayMs, DEFAULT_DELAY_MS))

          return { content }
        },
      })

      editor.add({
        name: "memo_scope",
        description: "Move one memory to another scope, for a note recorded under the wrong one.",
        input: {
          type: "object",
          properties: {
            id: { type: "integer", minimum: 0, description: "The memory id, as memo prints it" },
            scope: {
              type: "string",
              description: "'global', a comma-separated list of project keys, or an empty string to leave it unclassified",
            },
          },
          required: ["id", "scope"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input) => {
          const { id, scope } = input as { id: number; scope: string }
          const keys = parseScope(scope)
          const store = Store.open(memoryDir)

          if (store === undefined) throw new Error(`no readable OptMem store at ${pretty(memoryDir)}`)

          try {
            store.writeScope(id, keys)
            return { content: `Scoped #${id} to ${keys.join(", ") || "nothing"}.` }
          } finally {
            store.close()
          }
        },
      })

      editor.add({
        name: "memo_nap",
        description:
          "Answer the OptMem compression that came due: pass the block and your one-line summary. " +
          "Call with no arguments to see the next pending compression.",
        input: {
          type: "object",
          properties: {
            block: BLOCK,
            summary: { type: "string", minLength: 1, description: "One line, at most 280 bytes. Keep what lasts; invent nothing." },
          },
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { block, summary } = input as { block?: string; summary?: string }
          if ((block === undefined) !== (summary === undefined)) throw new Error("Pass both block and summary, or neither.")
          return { content: await call(block === undefined ? ["nap"] : ["nap", block, summary!], context) }
        },
      })

      editor.add({
        name: "memo_recall",
        description:
          "Search every OptMem memory ever recorded, word for word, with a case-insensitive Python regex. The only way to " +
          "reach another project's memories, which wake does not show you.",
        input: {
          type: "object",
          properties: { regex: { type: "string", minLength: 1 } },
          required: ["regex"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { regex } = input as { regex: string }
          return { content: await call(["recall", regex], context) }
        },
      })

      editor.add({
        name: "memo_zoom",
        description: "Open one node of the OptMem memory tree (an #a-b line from wake) into its two halves.",
        input: {
          type: "object",
          properties: { block: BLOCK },
          required: ["block"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { block } = input as { block: string }
          return { content: await call(["zoom", block], context) }
        },
      })

      editor.add({
        name: "memo_forget",
        description:
          "Drop a bad OptMem summary and every summary built on it; the next memo_nap rebuilds them. Raw memories are never lost.",
        input: {
          type: "object",
          properties: { block: BLOCK },
          required: ["block"],
          additionalProperties: false,
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const { block } = input as { block: string }
          return { content: await call(["forget", block], context) }
        },
      })
    })

    await ctx.session.hook("context", async (event) => {
      if (!existsSync(memo) || (await isSubagent(event.sessionID))) {
        for (const name of TOOL_NAMES) delete event.tools[name]
        return
      }
      event.system.push({ type: "text", text: prompt })
    })

    if (compressor === undefined) return

    // A backstop, because a block can also fall due from another session's
    // notes, and nothing here would otherwise notice. A pass with nothing
    // pending is one cheap `memo nap` call.
    const backstop = positive(ctx.options.backstopSeconds, DEFAULT_BACKSTOP_SECONDS) * 1_000
    const timer = setInterval(() => void compressor.pass(), backstop)
    timer.unref?.()

    if (!announced) {
      announced = true
      log(`background compression on, models ${models.map(modelName).join(" -> ")}, backstop ${backstop / 1000}s`)
    }

    return () => {
      clearInterval(timer)
      compressor.stop()
    }
  },
})
