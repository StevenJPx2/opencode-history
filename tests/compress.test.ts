// Background compression: memo chooses the block, the plugin supplies the line.
//
// The unit tests fake memo's side of the conversation to pin the protocol and the
// bounded retries; the contract test runs the real tool so a summary that lands
// in TREE/ is a summary the tool itself accepts.

import { afterAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

import { bytes, cutTask, line, parsePending, task } from "../src/compact"
import { modelRef } from "../src/index"
import { Compressor, runnable } from "../src/worker"

const memo = join(homedir(), ".optmem", "memo")
const available = existsSync(memo)
const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** What `memo nap` prints when a block is due, in memo's own words. */
const prompt = (lo: number, hi: number, limit = 280, body = "  #0 2026-10-12 alpha") =>
  [
    `Compress memories #${lo}-${hi} into one line of at most ${limit} bytes.`,
    "Keep what has lasting effect, drop what does not. Invent nothing.",
    "",
    body,
    "",
    `Run: ${memo} nap ${lo}-${hi} "<your line>"`,
  ].join("\n")

describe("reading what memo asks for", () => {
  test("finds the block and the byte limit", () => {
    expect(parsePending(prompt(4, 7, 280))).toEqual({ lo: 4, hi: 7, limit: 280 })
    expect(parsePending(prompt(4, 7).replace(`Run: ${memo} nap`, "Run: /path with spaces/memo nap"))).toEqual({
      lo: 4,
      hi: 7,
      limit: 280,
    })
  })

  test("reports nothing pending rather than a block", () => {
    expect(parsePending("Nothing left to compress.")).toBeUndefined()
    expect(parsePending("")).toBeUndefined()
    expect(parsePending("some output with no Run line")).toBeUndefined()
  })

  test("asks for one line within the limit, with the block's own input", () => {
    const written = task({ lo: 4, hi: 7, limit: 280 }, "#0-3 summary")

    expect(written).toContain("Compress memories #4-7 into one line of at most 280 bytes.")
    expect(written).toContain("Keep what has lasting effect")
    expect(written).toContain("#0-3 summary")
  })

  test("marks where the cut falls when a line comes back too long", () => {
    const written = cutTask({ lo: 4, hi: 7, limit: 10 }, "#0-3 summary", "far too many bytes here", 22)

    expect(written).toContain("your line is 22 bytes, over the 10-byte limit")
    expect(written).toContain("far too ma| ← LIMIT")
    expect(cutTask({ lo: 4, hi: 7, limit: 4 }, "input", "ééé", 6)).toContain("éé| ← LIMIT")
  })

  test("takes one plain line from a reply", () => {
    expect(line("`alpha and beta`")).toBe("alpha and beta")
    expect(line('"alpha and beta"')).toBe("alpha and beta")
    expect(line("#4-7 | alpha and beta")).toBe("alpha and beta")
    expect(line("```text\nalpha and beta\n```\n")).toBe("alpha and beta")
    expect(line("\n\nalpha and beta\n\nsomething else")).toBe("alpha and beta")
    expect(line("   ")).toBe("")
  })
})

describe("knowing which model to ask", () => {
  test("reads a model reference written either way", () => {
    expect(modelRef("opencode/mimo-v2.6-flash-free")).toEqual({
      providerID: "opencode",
      id: "mimo-v2.6-flash-free",
    })
    expect(modelRef("openai/gpt-6-luna#xhigh")).toEqual({
      providerID: "openai",
      id: "gpt-6-luna",
      variant: "xhigh",
    })
    expect(modelRef({ providerID: "opencode", id: "muse-spark-1.3", variant: "high" })).toEqual({
      providerID: "opencode",
      id: "muse-spark-1.3",
      variant: "high",
    })
    expect(modelRef(undefined)).toEqual({ providerID: "openai", id: "gpt-6-luna", variant: "xhigh" })
  })

  test("accepts a model OpenCode can run, and no other", () => {
    const listed = [
      { providerID: "opencode", modelID: "mimo-v2.6-flash-free", variants: [] },
      { providerID: "openai", modelID: "gpt-6-luna", variants: [{ id: "xhigh" }] },
      { providerID: "anthropic", modelID: "claude-haiku-5-5" },
    ]

    expect(runnable(listed, { providerID: "opencode", id: "mimo-v2.6-flash-free" })).toBe(true)
    expect(runnable(listed, { providerID: "anthropic", id: "claude-haiku-5-5" })).toBe(true)
    expect(runnable(listed, { providerID: "openai", id: "gpt-6-luna", variant: "xhigh" })).toBe(true)
    expect(runnable(listed, { providerID: "opencode", id: "minimax-m2.5-free" })).toBe(false)
    expect(runnable(listed, { providerID: "openai", id: "gpt-6-luna", variant: "high" })).toBe(false)
    expect(runnable(listed, { providerID: "nope", id: "claude-haiku-5-5" })).toBe(false)
    expect(runnable([], { providerID: "opencode", id: "mimo-v2.6-flash-free" })).toBe(false)
  })
})

/** memo's side of the conversation, faked. */
function fakeMemo(blocks: Array<{ lo: number; hi: number; limit: number }>, settled: string[] = []) {
  const asked: string[][] = []

  return {
    asked,
    async call(args: string[]) {
      asked.push(args)

      if (args[0] === "nap" && args.length === 1) {
        const next = blocks[0]
        return next === undefined ? "Nothing left to compress." : prompt(next.lo, next.hi, next.limit)
      }
      if (args[0] === "zoom") return "  #0-3 a summary of two memories"

      const block = `${args[1]}`
      // Real memo drops a settled block from the queue; this fake keeps
      // offering it, so the loop's own guard is what has to stop the pass.
      if (settled.includes(block)) return `${block} was settled or forgotten meanwhile.`
      if (bytes(args[2] ?? "") > 280) return `Too long: 300 bytes, limit 280. Compress it further.`

      settled.push(block)
      const index = blocks.findIndex((entry) => `${entry.lo}-${entry.hi}` === block)
      blocks.splice(index < 0 ? 0 : index, 1)

      return `${block} saved.`
    },
  }
}

const noModel = { providerID: "test", id: "test" }
const luna = { providerID: "openai", id: "gpt-6-luna", variant: "xhigh" }
const free = { providerID: "opencode", id: "mimo-v2.6-flash-free" }

describe("the compression loop", () => {
  test("compresses every pending block, oldest range first", async () => {
    const memoFake = fakeMemo([
      { lo: 0, hi: 1, limit: 280 },
      { lo: 2, hi: 3, limit: 280 },
    ])
    const asked: string[] = []

    const done = await new Compressor({
      call: memoFake.call,
      ask: async (prompt) => (asked.push(prompt), "alpha and beta"),
      log: () => undefined,
      models: [noModel],
      perPass: 8,
      attempts: 3,
    }).pass()

    expect(done).toBe(2)
    expect(memoFake.asked.filter((args) => args[0] === "nap" && args.length === 3).map((args) => args[1])).toEqual([
      "0-1",
      "2-3",
    ])
    expect(asked).toHaveLength(2)
  })

  test("continues in another pass after reaching the per-pass bound", async () => {
    const memoFake = fakeMemo([
      { lo: 0, hi: 1, limit: 280 },
      { lo: 2, hi: 3, limit: 280 },
    ])
    const compressor = new Compressor({
      call: memoFake.call,
      ask: async () => "alpha and beta",
      log: () => undefined,
      models: [noModel],
      perPass: 1,
      attempts: 3,
      continueAfterMs: 1,
    })

    expect(await compressor.pass()).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 20))
    compressor.stop()

    expect(memoFake.asked.filter((args) => args[0] === "nap" && args.length === 3).map((args) => args[1])).toEqual([
      "0-1",
      "2-3",
    ])
  })

  test("does nothing when nothing is pending", async () => {
    const asked: string[] = []

    const done = await new Compressor({
      call: fakeMemo([]).call,
      ask: async (prompt) => (asked.push(prompt), "unused"),
      log: () => undefined,
      models: [noModel],
      perPass: 8,
      attempts: 3,
    }).pass()

    expect(done).toBe(0)
    expect(asked).toEqual([])
  })

  test("cuts and retries a line that is too long, then keeps it", async () => {
    const prompts: string[] = []
    const memoFake = fakeMemo([{ lo: 0, hi: 1, limit: 40 }])

    const done = await new Compressor({
      call: memoFake.call,
      ask: async (prompt) => {
        prompts.push(prompt)
        return prompts.length === 1 ? "x".repeat(90) : "y".repeat(30)
      },
      log: () => undefined,
      models: [noModel],
      perPass: 8,
      attempts: 3,
    }).pass()

    expect(done).toBe(1)
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("cutting just enough")
  })

  test("falls back to the free model when Luna errors", async () => {
    const memoFake = fakeMemo([{ lo: 0, hi: 1, limit: 280 }])
    const models: string[] = []

    const done = await new Compressor({
      call: memoFake.call,
      ask: async (_prompt, model) => {
        models.push(`${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`)
        if (model === luna || model.providerID === luna.providerID) throw new Error("primary unavailable")
        return "summarized with fallback"
      },
      log: () => undefined,
      models: [luna, free],
      perPass: 8,
      attempts: 3,
    }).pass()

    expect(done).toBe(1)
    expect(models).toEqual(["openai/gpt-6-luna#xhigh", "opencode/mimo-v2.6-flash-free"])
    expect(memoFake.asked.some((args) => args[0] === "nap" && args[2] === "summarized with fallback")).toBe(true)
  })

  test("falls back when the primary cannot meet the byte limit", async () => {
    const memoFake = fakeMemo([{ lo: 0, hi: 1, limit: 40 }])
    const models: string[] = []

    const done = await new Compressor({
      call: memoFake.call,
      ask: async (_prompt, model) => {
        models.push(`${model.providerID}/${model.id}`)
        return model.providerID === luna.providerID ? "x".repeat(60) : "valid fallback summary"
      },
      log: () => undefined,
      models: [luna, free],
      perPass: 8,
      attempts: 2,
    }).pass()

    expect(done).toBe(1)
    expect(models).toEqual([
      "openai/gpt-6-luna",
      "openai/gpt-6-luna",
      "opencode/mimo-v2.6-flash-free",
    ])
  })

  test("leaves a block for the agent when every attempt is too long", async () => {
    const logs: string[] = []
    const memoFake = fakeMemo([{ lo: 0, hi: 1, limit: 40 }])

    const done = await new Compressor({
      call: memoFake.call,
      ask: async () => "z".repeat(200),
      log: (message) => logs.push(message),
      models: [noModel],
      perPass: 8,
      attempts: 3,
    }).pass()

    expect(done).toBe(0)
    expect(memoFake.asked.some((args) => args.length === 3)).toBe(false)
    expect(logs.join(" ")).toContain("left for the agent")
  })

  test("moves on when the agent answered the block first", async () => {
    const memoFake = fakeMemo([{ lo: 0, hi: 1, limit: 280 }], ["0-1"])

    const done = await new Compressor({
      call: memoFake.call,
      ask: async () => "alpha and beta",
      log: () => undefined,
      models: [noModel],
      perPass: 8,
      attempts: 3,
    }).pass()

    expect(done).toBe(1)
  })

  test("keeps to one pass at a time, and stops when told to", async () => {
    let running = 0
    let peak = 0
    const blocks = Array.from({ length: 6 }, (_, index) => ({ lo: index * 2, hi: index * 2 + 1, limit: 280 }))
    const memoFake = fakeMemo(blocks)

    const compressor = new Compressor({
      call: async (args) => {
        running++
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 1))
        const output = await memoFake.call(args)
        running--
        return output
      },
      ask: async () => "alpha and beta",
      log: () => undefined,
      models: [noModel],
      perPass: 8,
      attempts: 3,
    })

    await Promise.all([compressor.pass(), compressor.pass()])

    expect(peak).toBe(1)

    compressor.stop()
    expect(await compressor.pass()).toBe(0)
  })

  test("reports a failure instead of throwing", async () => {
    const logs: string[] = []

    const done = await new Compressor({
      call: async () => {
        throw new Error("memo is gone")
      },
      ask: async () => "unused",
      log: (message) => logs.push(message),
      models: [noModel],
      perPass: 8,
      attempts: 3,
    }).pass()

    expect(done).toBe(0)
    expect(logs.join(" ")).toContain("memo is gone")
  })
})

function freshStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "optmem-compress-"))
  roots.push(dir)

  execFileSync(memo, ["init"], { env: { ...process.env, MEMORY_DIR: dir } })
  return dir
}

describe.skipIf(!available)("compression against the real tool", () => {
  test("writes a summary the tool itself accepts", async () => {
    const dir = freshStore()
    const run = (args: string[]) => execFileSync(memo, args, { env: { ...process.env, MEMORY_DIR: dir }, encoding: "utf8" })

    run(["note", "alpha"])
    run(["note", "beta"])

    expect(run(["nap"])).toContain("Compress memories #0-1")

    await new Compressor({
      call: async (args) => run(args),
      ask: async () => "alpha and beta in one line",
      log: () => undefined,
      models: [noModel],
      perPass: 8,
      attempts: 3,
    }).pass()

    expect(readFileSync(join(dir, "TREE", "2"), "utf8").trim()).toBe("alpha and beta in one line")
    expect(run(["nap"])).toContain("Nothing left to compress.")
    // The store is smaller than memo's line budget, so it shows the raw
    // memories and keeps the summary for when it is not.
    expect(run(["wake"])).toMatch(/#0 \d{4}-\d{2}-\d{2} alpha/)
    expect(run(["zoom", "0-1"])).toContain("alpha")
    expect(run(["zoom", "0-1"])).toContain("beta")
  })

  test("reads exactly what memo asked for", async () => {
    const dir = freshStore()
    const run = (args: string[]) => execFileSync(memo, args, { env: { ...process.env, MEMORY_DIR: dir }, encoding: "utf8" })

    run(["note", "alpha"])
    run(["note", "beta"])

    const pending = parsePending(run(["nap"]))

    expect(pending).toEqual({ lo: 0, hi: 1, limit: 280 })
    expect(run(["zoom", "0-1"])).toContain("alpha")
    expect(run(["zoom", "0-1"])).toContain("beta")
  })
})
