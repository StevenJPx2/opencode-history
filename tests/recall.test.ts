import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Archive } from "../src/archive.ts"
import { GenerationUnavailable } from "../src/errors.ts"
import { removeRoot, startHost, type Host } from "./host.ts"

/** Two projects' memories plus one global preference, in a fresh archive. */
function seeded() {
  const root = mkdtempSync(join(tmpdir(), "optmem-recall-"))
  const archive = new Archive(join(root, "archive.sqlite"))
  const alpha = archive.project(join(root, "alpha"))
  const beta = archive.project(join(root, "beta"))
  const note = (id: string, text: string, scope: string) => {
    archive.capture({ id, project: scope, session: "s", message: id, kind: "user", at: 1, text, payload: JSON.stringify({ id }) }, false)
    archive.remember({ id, text, at: 1, status: "confirmed", scopes: [scope], sources: [id] })
  }
  note("alpha-code", "Alpha release code is amber-otter.", alpha)
  note("beta-code", "Beta release code is violet-kestrel.", beta)
  note("global-pref", "User prefers concise answers.", "global")
  archive.close()
  return root
}

const injected = async (host: Host, question: string) =>
  (await host.context("ses_work", question)).system.map(part => part.text).join("\n")

const ask = (host: Host, input: Record<string, string>) =>
  host.tools.get("memory")!.execute(input, { sessionID: "ses_work", signal: new AbortController().signal }).then(result => result.content)

test("injection carries this project's and global memories, never another project's", async () => {
  const root = seeded()
  const host = await startHost({ root })
  try {
    const block = await injected(host, "what is the release code?")
    expect(block).toContain("amber-otter")
    expect(block).toContain("User prefers concise answers.")
    expect(block).not.toContain("violet-kestrel")
  } finally { host.dispose(); await Bun.sleep(20); removeRoot(root) }
})

test("injection stays within its size budget however many memories match", async () => {
  const root = seeded()
  const archive = new Archive(join(root, "archive.sqlite"))
  const alpha = archive.project(join(root, "alpha"))
  for (let i = 0; i < 200; i++) {
    const id = `bulk-${i}`
    const text = `release note ${i} ${"detail ".repeat(60)}`
    archive.capture({ id, project: alpha, session: "s", message: id, kind: "user", at: 2, text, payload: JSON.stringify({ id }) }, false)
    archive.remember({ id, text, at: 2, status: "confirmed", scopes: [alpha], sources: [id] })
  }
  archive.close()
  const host = await startHost({ root })
  try {
    expect((await injected(host, "release")).length).toBeLessThanOrEqual(6000)
  } finally { host.dispose(); await Bun.sleep(20); removeRoot(root) }
})

test("the memory tool answers with citations from the evidence it was given", async () => {
  const root = seeded()
  const host = await startHost({ root, generate: async () => JSON.stringify({ answer: "It is amber-otter.", citations: ["alpha-code"] }) })
  try {
    const answer = JSON.parse(await ask(host, { question: "amber-otter release code" }))
    expect(answer.answer).toBe("It is amber-otter.")
    expect(answer.citations).toEqual(["alpha-code"])
  } finally { host.dispose(); await Bun.sleep(20); removeRoot(root) }
})

test("the memory tool rejects an answer citing evidence it was never given", async () => {
  const root = seeded()
  const host = await startHost({ root, generate: async () => JSON.stringify({ answer: "Invented.", citations: ["made-up-id"] }) })
  try {
    const result = JSON.parse(await ask(host, { question: "amber-otter release code" }))
    expect(result.answer).toBeUndefined()
    expect(result.notice).toContain("not a synthesized answer")
  } finally { host.dispose(); await Bun.sleep(20); removeRoot(root) }
})

test("the memory tool still returns evidence when every model is unavailable", async () => {
  const root = seeded()
  const host = await startHost({ root, generate: async () => { throw new GenerationUnavailable(Date.now() + 60_000) } })
  try {
    const result = JSON.parse(await ask(host, { question: "amber-otter release code" }))
    expect(result.notice).toContain("not a synthesized answer")
    expect(JSON.stringify(result.memories)).toContain("amber-otter")
  } finally { host.dispose(); await Bun.sleep(20); removeRoot(root) }
})

test("another project's memory needs an explicit all-scope lookup", async () => {
  const root = seeded()
  const host = await startHost({ root, generate: async () => { throw new GenerationUnavailable(Date.now() + 60_000) } })
  try {
    expect(await ask(host, { question: "violet-kestrel" })).not.toContain("violet-kestrel")
    expect(await ask(host, { question: "violet-kestrel", scope: "all" })).toContain("violet-kestrel")
  } finally { host.dispose(); await Bun.sleep(20); removeRoot(root) }
})
