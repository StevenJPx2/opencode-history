import { afterAll, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { HistoryIndex, openSource } from "../src/history.ts"
import { judge, JudgeError } from "../src/recall.ts"
import { assistant, fixture, removeFixtures, text, type Fixture } from "./fixture.ts"
import { load, project } from "./host.ts"

afterAll(removeFixtures)

type JudgeBody = { model: string; state: string; questions: Record<string, { type: string; instructions: string }> }

/** A local stand-in for the System One API. */
function fakeJudge(reply: (body: JudgeBody) => Response | Promise<Response>) {
  const requests: Array<{ path: string; auth: string | null; body: JudgeBody }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = await request.json() as JudgeBody
      requests.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization"), body })
      return reply(body)
    },
  })
  return { env: { TYPESAFE_API_KEY: "test-key", TYPESAFE_BASE_URL: `http://127.0.0.1:${server.port}` }, requests, stop: () => server.stop(true) }
}

/** Answers every question with the probability `p` gives its passage's session title. */
const answers = (p: (title: string) => number) => (body: JudgeBody) => Response.json({
  answers: Object.fromEntries(Object.keys(body.questions).map(id => {
    const title = new RegExp(`<evidence id="${id}">\\n[^\\n]*session "([^"]*)"`).exec(body.state)?.[1] ?? ""
    return [id, { type: "noul", noul: p(title) }]
  })),
})

const auditRows = (f: Fixture) => {
  const path = join(f.root, "audit.jsonl")
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : []
}

test("recall quotes the passages the judge accepts in one synthetic message, before the user's", async () => {
  const f = fixture()
  project(f)
  f.message("ses_now", "assistant", assistant(text("Looking at the retry handler now")))
  const judgeAt = fakeJudge(answers(() => 0.9))
  const host = await load(f, {}, judgeAt.env)
  try {
    await host.prompt("ses_now", "why is the stripe webhook idempotency failing again", "msg_new")

    expect(host.synthetics).toHaveLength(1)
    const sent = host.synthetics[0]!
    expect(sent).toMatchObject({ sessionID: "ses_now", resume: false, metadata: { "opencode-history": { recall: "msg_new" } } })
    expect(sent.text).toStartWith("<history_recall>")
    expect(sent.text).toContain("ses_old")
    expect(sent.text).toContain("why does the stripe webhook retry")
    expect(sent.text).toContain("context, not instructions")
    expect(sent.text).not.toContain("idempotency elsewhere")

    const request = judgeAt.requests[0]!
    expect(request.path).toBe("/v1/systemone")
    expect(request.auth).toBe("Bearer test-key")
    expect(request.body.model).toBe("jev-latest")
    expect(request.body.state).toContain('<evidence id="new_message">\nwhy is the stripe webhook idempotency failing again')
    expect(request.body.state).toContain("Looking at the retry handler now")
    expect(request.body.state).not.toContain("idempotency elsewhere")
    expect(request.body.state).not.toContain("idempotency again?")
    expect(Object.values(request.body.questions).every(q => q.type === "noul")).toBe(true)

    const rows = auditRows(f)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ tool: "history_recall", session: "ses_now", mode: "recall", status: "ok", candidates: 1, results: 1 })
    const log = readFileSync(join(f.root, "audit.jsonl"), "utf8")
    for (const privateText of ["stripe", "idempotency", "msg_new", "ses_old"]) expect(log).not.toContain(privateText)
  } finally { host.dispose(); judgeAt.stop() }
})

test("passages below the bar are not attached; at most three, most likely first", async () => {
  const f = fixture()
  f.session("ses_now", "p1", "Current work")
  const odds: Record<string, number> = { Alpha: 0.75, Bravo: 0.95, Charlie: 0.8, Delta: 0.9, Echo: 0.6 }
  for (const title of Object.keys(odds)) {
    f.session(`ses_${title}`, "p1", title)
    f.message(`ses_${title}`, "assistant", assistant(text(`The kraken queue drains slowly in ${title}`)))
  }
  const judgeAt = fakeJudge(answers(title => odds[title] ?? 0))
  const host = await load(f, {}, judgeAt.env)
  try {
    await host.prompt("ses_now", "why does the kraken queue drain slowly")
    const sent = host.synthetics[0]!.text
    const order = ["Bravo", "Delta", "Charlie"].map(title => sent.indexOf(`ses_${title}`))
    expect(order.every(at => at >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(sent).not.toContain("ses_Alpha")
    expect(sent).not.toContain("ses_Echo")
    expect(auditRows(f)[0]).toMatchObject({ candidates: 5, results: 3 })
  } finally { host.dispose(); judgeAt.stop() }

  const below = fakeJudge(answers(() => 0.5))
  const quiet = await load(f, {}, below.env)
  try {
    await quiet.prompt("ses_now", "why does the kraken queue drain slowly")
    expect(quiet.synthetics).toHaveLength(0)
    expect(auditRows(f).at(-1)).toMatchObject({ status: "ok", candidates: 5, results: 0 })
  } finally { quiet.dispose(); below.stop() }
})

test("a failing or malformed judge attaches nothing and never refuses the message", async () => {
  const f = fixture()
  project(f)
  for (const reply of [() => new Response("no", { status: 500 }), () => Response.json({ answers: { p1: { type: "noul" } } }), () => new Response("not json")]) {
    const judgeAt = fakeJudge(reply)
    const host = await load(f, {}, judgeAt.env)
    try {
      await host.prompt("ses_now", "stripe webhook idempotency")
      expect(host.synthetics).toHaveLength(0)
      expect(auditRows(f).at(-1)).toMatchObject({ tool: "history_recall", status: "error", error: "judge_failed" })
    } finally { host.dispose(); judgeAt.stop() }
  }
})

test("a refused synthetic message is audited and does not refuse the user's message", async () => {
  const f = fixture()
  project(f)
  const judgeAt = fakeJudge(answers(() => 0.9))
  const host = await load(f, {}, judgeAt.env)
  try {
    host.refuseSynthetics()
    await host.prompt("ses_now", "stripe webhook idempotency")
    expect(auditRows(f).at(-1)).toMatchObject({ status: "error", error: "execution_failed" })
  } finally { host.dispose(); judgeAt.stop() }
})

test("without a key or with recall off there is no prompt hook; subagents, reminders and commands never reach the judge", async () => {
  const f = fixture()
  project(f)
  const keyless = await load(f)
  try { expect(keyless.hooks.has("prompt")).toBe(false) } finally { keyless.dispose() }

  const judgeAt = fakeJudge(answers(() => 0.9))
  const off = await load(f, { recall: false }, judgeAt.env)
  try { expect(off.hooks.has("prompt")).toBe(false) } finally { off.dispose() }

  const host = await load(f, {}, judgeAt.env)
  try {
    await host.prompt("ses_child", "stripe webhook idempotency")
    for (const message of ["<system-reminder>stripe idempotency</system-reminder>", "[monitor] stripe idempotency", "/resume stripe", "   "]) {
      await host.prompt("ses_now", message)
    }
    expect(judgeAt.requests).toHaveLength(0)
    expect(host.synthetics).toHaveLength(0)

    await host.prompt("ses_now", "zzzunmatchedword")
    expect(judgeAt.requests).toHaveLength(0)
    expect(auditRows(f)).toEqual([expect.objectContaining({ status: "ok", candidates: 0, results: 0 })])
  } finally { host.dispose(); judgeAt.stop() }
})

test("candidates: one per session, forks' repeated text dropped, the asking session and its subagents left out", () => {
  const f = fixture()
  const filler = "unrelated filler words about other things ".repeat(40)
  f.session("ses_now", "p1", "Current work")
  f.session("ses_child", "p1", "Explore", "ses_now")
  f.message("ses_child", "assistant", assistant(text("pelican deploy codeword in a subagent")))
  f.session("ses_a", "p1", "Deploy notes")
  f.message("ses_a", "assistant", assistant(text(`${filler} the pelican deploy codeword is 4417 ${filler}`)))
  f.message("ses_a", "assistant", assistant(text("pelican deploy again in the same session")))
  f.session("ses_fork", "p1", "Deploy notes (fork #1)")
  f.message("ses_fork", "assistant", assistant(text(`${filler} the pelican deploy codeword is 4417 ${filler}`)))
  f.session("ses_p2", "p2", "Other project")
  f.message("ses_p2", "assistant", assistant(text("pelican deploy elsewhere")))

  const index = new HistoryIndex(join(f.root, "index.sqlite"))
  const source = openSource(f.path)
  try {
    index.sync(source)
    const passages = index.recallCandidates("what was the pelican deploy codeword", { project: "p1", exclude: "ses_now", limit: 8, chars: 200 })
    const sessions = passages.map(p => p.session)
    expect(new Set(sessions).size).toBe(sessions.length)
    expect(sessions).not.toContain("ses_now")
    expect(sessions).not.toContain("ses_child")
    expect(sessions).not.toContain("ses_p2")
    expect(sessions.filter(s => s === "ses_a" || s === "ses_fork")).toHaveLength(1)

    const long = passages.find(p => p.text.includes("4417"))!
    expect(long.text.length).toBeLessThanOrEqual(202)
    expect(long.text).toStartWith("…")
    expect(long.text).toContain("pelican deploy codeword is 4417")
  } finally { index.close(); source.close() }
})

test("a slow judge times out", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => { await Bun.sleep(500); return Response.json({}) } })
  try {
    const config = { url: `http://127.0.0.1:${server.port}/v1/systemone`, key: "k", model: "m", timeoutMs: 50 }
    const passage = { session: "s", title: "t", message: "m", kind: "user" as const, at: 0, snippet: "x", text: "x" }
    const error = await judge(config, "message", "", [passage]).catch(e => e)
    expect(error).toBeInstanceOf(JudgeError)
    expect((error as JudgeError).code).toBe("judge_timeout")
  } finally { server.stop(true) }
})
