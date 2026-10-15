import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Archive } from "../src/archive.ts"
import { importTranscript } from "../src/capture.ts"
import { GenerationCancelled, GenerationInterrupted, GenerationUnavailable } from "../src/errors.ts"
import { Generator, type Model } from "../src/generator.ts"
import { removeRoot, startHost } from "./host.ts"

const turn = JSON.stringify({ info: { id: "ses_gen" }, messages: [
  { id: "u", type: "user", text: "Shall we use SQLite WAL for the archive?", time: { created: 10 } },
  { id: "a", type: "assistant", content: [{ type: "text", text: "Decision confirmed: the archive uses SQLite WAL." }], time: { created: 11, completed: 12 } },
] })

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && !check()) await Bun.sleep(10)
  return check()
}

test("background extraction reaches the model without creating an OpenCode session", async () => {
  const root = mkdtempSync(join(tmpdir(), "optmem-gen-"))
  const seed = new Archive(join(root, "archive.sqlite"))
  importTranscript(seed, seed.project(join(root, "alpha")), turn, "ses_gen")
  seed.close()
  const host = await startHost({ root })
  try {
    expect(await until(() => host.prompts.length > 0)).toBe(true)
    expect(host.created).toEqual([])
  } finally { host.dispose(); await Bun.sleep(20); removeRoot(root) }
})

const LUNA: Model = { providerID: "openai", id: "luna" }
const HAIKU: Model = { providerID: "anthropic", id: "haiku" }
const outage = Object.assign(new Error("provider down"), { _tag: "ServiceUnavailableError" })
const rejected = Object.assign(new Error("Model unavailable"), { _tag: "InvalidRequestError" })

/** A provider double: answers per model from a script, recording calls it received. */
function provider(script: Record<string, Array<Error | string>>) {
  const calls: string[] = []
  return {
    calls,
    call: async (model: Model, _prompt: string, _signal: AbortSignal) => {
      calls.push(model.id)
      const next = script[model.id]!.shift()
      if (next === undefined) throw new Error(`no scripted reply for ${model.id}`)
      if (next instanceof Error) throw next
      return next
    },
  }
}

function harness(models: Model[], script: Record<string, Array<Error | string>>) {
  const archive = new Archive(":memory:")
  const clock = { now: 1_000_000 }
  const fake = provider(script)
  const generator = new Generator(archive, models, fake.call, () => clock.now)
  const ask = () => generator.generate("prompt", new AbortController().signal)
  return { archive, clock, fake, ask }
}

test("a provider outage cools the model down instead of being retried on every job", async () => {
  const { archive, clock, fake, ask } = harness([LUNA], { luna: [outage, "recovered"] })
  try {
    await expect(ask()).rejects.toBeInstanceOf(GenerationUnavailable)
    await expect(ask()).rejects.toBeInstanceOf(GenerationUnavailable)
    expect(fake.calls).toEqual(["luna"])

    clock.now += 61_000
    expect(await ask()).toBe("recovered")
    expect(fake.calls).toEqual(["luna", "luna"])
  } finally { archive.close() }
})

test("an unavailable primary falls back, and is skipped while it cools down", async () => {
  const { archive, fake, ask } = harness([LUNA, HAIKU], { luna: [outage], haiku: ["first", "second"] })
  try {
    expect(await ask()).toBe("first")
    expect(await ask()).toBe("second")
    expect(fake.calls).toEqual(["luna", "haiku", "haiku"])
  } finally { archive.close() }
})

test("a provider's retry-after is honoured", async () => {
  const limited = Object.assign(new Error("rate limited; retry-after=3600s"), { _tag: "ServiceUnavailableError" })
  const { archive, clock, fake, ask } = harness([LUNA], { luna: [limited, "later"] })
  try {
    await expect(ask()).rejects.toBeInstanceOf(GenerationUnavailable)
    clock.now += 3_599_000
    await expect(ask()).rejects.toBeInstanceOf(GenerationUnavailable)
    clock.now += 2_000
    expect(await ask()).toBe("later")
    expect(fake.calls).toEqual(["luna", "luna"])
  } finally { archive.close() }
})

test("a rejected model cools down for longer than a transient outage", async () => {
  const { archive, clock, fake, ask } = harness([LUNA], { luna: [rejected, "ok"] })
  try {
    await expect(ask()).rejects.toBeInstanceOf(GenerationUnavailable)
    clock.now += 61_000
    await expect(ask()).rejects.toBeInstanceOf(GenerationUnavailable)
    clock.now += 30 * 60_000
    expect(await ask()).toBe("ok")
    expect(fake.calls).toEqual(["luna", "luna"])
  } finally { archive.close() }
})

test("cooldowns are shared by every plugin instance on the same archive", async () => {
  const archive = new Archive(":memory:")
  const first = provider({ luna: [outage] })
  const second = provider({ luna: ["unused"] })
  try {
    const now = () => 5_000
    await expect(new Generator(archive, [LUNA], first.call, now).generate("p", new AbortController().signal)).rejects.toBeInstanceOf(GenerationUnavailable)
    await expect(new Generator(archive, [LUNA], second.call, now).generate("p", new AbortController().signal)).rejects.toBeInstanceOf(GenerationUnavailable)
    expect(second.calls).toEqual([])
  } finally { archive.close() }
})

test("an interrupted call is not an outage", async () => {
  const { archive, fake, ask } = harness([LUNA], { luna: [new Error("All fibers interrupted without error"), "ok"] })
  try {
    await expect(ask()).rejects.toBeInstanceOf(GenerationInterrupted)
    expect(await ask()).toBe("ok")
    expect(fake.calls).toEqual(["luna", "luna"])
  } finally { archive.close() }
})

test("our own cancellation is reported as cancellation and cools nothing down", async () => {
  const archive = new Archive(":memory:")
  const controller = new AbortController()
  const fake = provider({ luna: ["ok"] })
  const generator = new Generator(archive, [LUNA], async (model, prompt, signal) => {
    if (!controller.signal.aborted) {
      controller.abort()
      signal.throwIfAborted()
    }
    return fake.call(model, prompt, signal)
  }, () => 1)
  try {
    await expect(generator.generate("p", controller.signal)).rejects.toBeInstanceOf(GenerationCancelled)
    expect(await generator.generate("p", new AbortController().signal)).toBe("ok")
  } finally { archive.close() }
})
