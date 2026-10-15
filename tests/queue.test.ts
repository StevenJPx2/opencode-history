import { expect, test } from "bun:test"
import { Archive } from "../src/archive.ts"
import { importTranscript } from "../src/capture.ts"
import { GenerationInterrupted, GenerationUnavailable } from "../src/errors.ts"
import { Historian } from "../src/historian.ts"

const turn = (id: string) => JSON.stringify({ info: { id }, messages: [
  { id: `${id}-u`, type: "user", text: "Should the archive use SQLite WAL mode?", time: { created: 10 } },
  { id: `${id}-a`, type: "assistant", content: [{ type: "text", text: "Decision confirmed: the archive uses SQLite WAL." }], time: { created: 11, completed: 12 } },
] })

type Reply = string | Error

/** Runs the historian over one captured turn, replying from `replies` in order. */
function harness(replies: Reply[]) {
  const archive = new Archive(":memory:")
  importTranscript(archive, "alpha", turn("ses_q"), "ses_q")
  let calls = 0
  const historian = new Historian(archive, { log: () => {}, generate: async () => {
    calls++
    const reply = replies.shift() ?? JSON.stringify({ memories: [] })
    if (reply instanceof Error) throw reply
    return reply
  } })
  const extract = () => archive.db.query<{ state: string; attempts: number; ready: number; error: string | null }, []>(
    "SELECT state,attempts,ready,error FROM jobs WHERE phase='extract'").get()!
  /** Make the job due now, then run one pass. */
  const rerun = async () => { archive.db.query("UPDATE jobs SET ready=0 WHERE state='pending'").run(); await historian.pass() }
  return { archive, historian, extract, rerun, calls: () => calls }
}

test("output that never cites its evidence stops being retried and is marked failed", async () => {
  const bad = JSON.stringify({ memories: [{ text: "x", status: "confirmed", source: "nope", quote: "not in evidence" }] })
  const { archive, historian, extract, rerun, calls } = harness(Array(20).fill(bad))
  try {
    await historian.pass()
    for (let i = 0; i < 10; i++) await rerun()

    expect(extract().state).toBe("failed")
    expect(calls()).toBe(5)
  } finally { archive.close() }
})

test("a model outage defers the job until the cooldown ends without using up its attempts", async () => {
  const until = Date.now() + 3_600_000
  const { archive, historian, extract, calls } = harness([new GenerationUnavailable(until)])
  try {
    await historian.pass()

    expect(extract()).toMatchObject({ state: "pending", attempts: 0, ready: until })
    expect(calls()).toBe(1)
  } finally { archive.close() }
})

test("an interrupted call is retried promptly without using up attempts", async () => {
  const { archive, historian, extract } = harness([new GenerationInterrupted()])
  try {
    await historian.pass()

    const job = extract()
    expect(job).toMatchObject({ state: "pending", attempts: 0 })
    expect(job.ready - Date.now()).toBeLessThan(60_000)
  } finally { archive.close() }
})

test("a pass stops calling the model once every model is cooling down", async () => {
  const archive = new Archive(":memory:")
  for (const id of ["a", "b", "c", "d"]) importTranscript(archive, "alpha", turn(`ses_${id}`), `ses_${id}`)
  let calls = 0
  const historian = new Historian(archive, { log: () => {}, generate: async () => {
    calls++
    throw new GenerationUnavailable(Date.now() + 60_000)
  } })
  try {
    await historian.pass()

    expect(calls).toBe(1)
  } finally { archive.close() }
})

test("a worker whose lease was taken over cannot commit its result", async () => {
  const archive = new Archive(":memory:")
  try {
    importTranscript(archive, "alpha", turn("ses_l"), "ses_l")
    const stale = archive.claim(0, 1)!
    const current = archive.claim(Date.now(), 60_000)!

    expect(archive.complete(stale)).toBe(false)
    expect(archive.complete(current)).toBe(true)
  } finally { archive.close() }
})
