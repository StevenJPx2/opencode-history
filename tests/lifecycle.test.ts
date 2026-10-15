import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Archive } from "../src/archive.ts"
import { importTranscript } from "../src/capture.ts"
import { removeRoot, startHost } from "./host.ts"

const turn = JSON.stringify({ info: { id: "ses_life" }, messages: [
  { id: "u", type: "user", text: "Which journal mode does the archive use?", time: { created: 10 } },
  { id: "a", type: "assistant", content: [{ type: "text", text: "Decision confirmed: the archive uses SQLite WAL." }], time: { created: 11, completed: 12 } },
] })

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && !check()) await Bun.sleep(10)
  return check()
}

function seeded(): string {
  const root = mkdtempSync(join(tmpdir(), "optmem-life-"))
  const archive = new Archive(join(root, "archive.sqlite"))
  importTranscript(archive, archive.project(join(root, "alpha")), turn, "ses_life")
  archive.close()
  return root
}

function extraction(root: string) {
  const archive = new Archive(join(root, "archive.sqlite"))
  try {
    return archive.db.query<{ state: string; attempts: number }, []>("SELECT state,attempts FROM jobs WHERE phase='extract'").get()!
  } finally { archive.close() }
}

/** A model call that only finishes when its signal aborts, like a call cut off by a reload. */
const hangs = (_prompt: string, signal: AbortSignal) => new Promise<string>((_, reject) =>
  signal.addEventListener("abort", () => reject(new Error("All fibers interrupted without error")), { once: true }))

test("disposing the plugin returns at once even while a model call is in flight", async () => {
  const root = seeded()
  const host = await startHost({ root, generate: hangs })
  try {
    expect(await until(() => host.prompts.length > 0)).toBe(true)
    const started = performance.now()
    host.dispose()
    expect(performance.now() - started).toBeLessThan(50)
  } finally { await Bun.sleep(50); removeRoot(root) }
})

test("a reload mid-call loses no work: the next instance finishes the job", async () => {
  const root = seeded()
  const first = await startHost({ root, generate: hangs })
  expect(await until(() => first.prompts.length > 0)).toBe(true)
  first.dispose()
  await Bun.sleep(50)

  // Whatever the reload left behind, the job is still owed an extraction.
  const left = extraction(root)
  expect(["pending", "running"]).toContain(left.state)
  const archive = new Archive(join(root, "archive.sqlite"))
  archive.db.query("UPDATE jobs SET ready=0, lease=0 WHERE phase='extract'").run()
  archive.close()

  const second = await startHost({ root, generate: async prompt => {
    const source = /"id":"(passage:[^"]+:a:[^"]+)"/.exec(prompt)![1]!
    return JSON.stringify({ memories: [{ text: "The archive uses SQLite WAL.", status: "confirmed", source, quote: "the archive uses SQLite WAL" }] })
  } })
  try {
    expect(await until(() => extraction(root).state === "done")).toBe(true)
    expect(extraction(root).attempts).toBeLessThanOrEqual(1)
  } finally { second.dispose(); await Bun.sleep(50); removeRoot(root) }
})

test("a closed archive after disposal raises nothing unhandled", async () => {
  const root = seeded()
  const errors: unknown[] = []
  const onError = (error: unknown) => { errors.push(error) }
  process.on("unhandledRejection", onError)
  const host = await startHost({ root, generate: hangs })
  try {
    expect(await until(() => host.prompts.length > 0)).toBe(true)
    host.dispose()
    await Bun.sleep(200)
    expect(errors).toEqual([])
  } finally { process.off("unhandledRejection", onError); removeRoot(root) }
})
