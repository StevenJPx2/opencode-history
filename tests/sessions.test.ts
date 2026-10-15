// The historian asks its model through a session: one per model, archived on
// creation, never messaged, reused across calls, and deleted when a model
// leaves the chain.
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Archive } from "../src/archive.ts"
import { importTranscript } from "../src/capture.ts"
import { removeRoot, startHost } from "./host.ts"

const turn = JSON.stringify({ info: { id: "ses_pool" }, messages: [
  { id: "u", type: "user", text: "Shall the historian keep a session per model?", time: { created: 10 } },
  { id: "a", type: "assistant", content: [{ type: "text", text: "Decision confirmed: the historian keeps one archived session per model." }], time: { created: 11, completed: 12 } },
] })

const LUNA = { providerID: "openai", id: "gpt-6-luna", variant: "xhigh" }
const BUNNY = { providerID: "opencode", id: "space-bunny-free" }
const silence = JSON.stringify({ memories: [] })

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && !check()) await Bun.sleep(10)
  return check()
}

function seeded(): string {
  const root = mkdtempSync(join(tmpdir(), "optmem-pool-"))
  const archive = new Archive(join(root, "archive.sqlite"))
  importTranscript(archive, archive.project(join(root, "alpha")), turn, "ses_pool")
  archive.close()
  return root
}

test("the historian asks through a session and never through the stateless route", async () => {
  const root = seeded()
  const host = await startHost({ root, models: [LUNA], script: { "openai/gpt-6-luna#xhigh": [silence, silence] } })
  try {
    expect(await until(() => host.sessions.generated.length > 0, 500)).toBe(true)
    expect(host.sessions.errors).toEqual([])
    expect(host.stateless).toBe(0)
    expect(host.sessions.prompted).toEqual([])
    expect(host.sessions.created).toHaveLength(1)
    expect(host.sessions.created[0]!.title).toContain("optmem")
  } finally { host.dispose(); await Bun.sleep(20); removeRoot(root) }
})

test("each model gets its own session, archived on creation, and only one", async () => {
  const root = seeded()
  const host = await startHost({ root, models: [LUNA, BUNNY], script: {
    "openai/gpt-6-luna#xhigh": [Object.assign(new Error("usage limit"), { _tag: "RateLimitError" })],
    "opencode/space-bunny-free": [silence],
  } })
  try {
    // Luna is asked first and refuses, so the chain needs its own session too.
    expect(await until(() => host.sessions.created.length === 2, 2000)).toBe(true)
    expect(host.sessions.created.map(entry => `${entry.model!.providerID}/${entry.model!.id}`)).toEqual([
      "openai/gpt-6-luna", "opencode/space-bunny-free",
    ])
    // Archived the moment each was created: a transport, not a conversation.
    expect(host.sessions.archived).toEqual(host.sessions.created.map(entry => entry.id))
    expect(host.sessions.generated.map(entry => entry.sessionID)).toEqual(["ses_historian_1", "ses_historian_2"])
    expect(host.sessions.prompted).toEqual([])
    expect(host.stateless).toBe(0)
  } finally { host.dispose(); await Bun.sleep(20); removeRoot(root) }
})

test("a session survives a reload, and one for a model that leaves the chain is deleted", async () => {
  const root = seeded()
  const first = await startHost({ root, models: [BUNNY], script: { "opencode/space-bunny-free": [silence] } })
  try {
    expect(await until(() => first.sessions.created.length === 1)).toBe(true)
  } finally { first.dispose(); await Bun.sleep(20) }

  const same = await startHost({ root, directory: join(root, "beta"), models: [BUNNY], script: { "opencode/space-bunny-free": [silence] } })
  try {
    // The session id lives in the archive, so a new instance does not create one.
    expect(same.sessions.created).toEqual([])
  } finally { same.dispose(); await Bun.sleep(20) }

  const changed = await startHost({ root, directory: join(root, "gamma"), models: [{ providerID: "opencode", id: "mimo-v2.6-flash-free" }], script: { "opencode/mimo-v2.6-flash-free": [silence] } })
  try {
    // The bunny model left the chain, so its session is not left behind.
    expect(await until(() => changed.sessions.removed.includes("ses_historian_1"), 2000)).toBe(true)
  } finally { changed.dispose(); await Bun.sleep(20); removeRoot(root) }
})

test("two instances racing for the same model keep one session and delete the other", async () => {
  const root = seeded()
  const script = { "opencode/space-bunny-free": [silence, silence, silence, silence, silence, silence] }
  const alpha = await startHost({ root, models: [BUNNY], script })
  const beta = await startHost({ root, directory: join(root, "beta"), models: [BUNNY], script })
  try {
    expect(await until(() => alpha.sessions.created.length + beta.sessions.created.length > 0)).toBe(true)
    const asked = [...alpha.sessions.generated, ...beta.sessions.generated]
    expect(await until(() => asked.length > 0, 2000)).toBe(true)
    // Whether or not they raced, every session created is either the one in use
    // or was deleted again: never a leftover.
    const created = [...alpha.sessions.created, ...beta.sessions.created]
    const removed = new Set([...alpha.sessions.removed, ...beta.sessions.removed])
    const used = new Set(asked.map(entry => entry.sessionID))
    for (const entry of created) expect(used.has(entry.id) || removed.has(entry.id)).toBe(true)
    expect(used.size).toBe(1)
  } finally { alpha.dispose(); beta.dispose(); await Bun.sleep(20); removeRoot(root) }
})

test("every plugin instance shares one session per model", async () => {
  const root = seeded()
  const script = { "opencode/space-bunny-free": [silence, silence, silence, silence] }
  const alpha = await startHost({ root, models: [BUNNY], script })
  const beta = await startHost({ root, directory: join(root, "beta"), models: [BUNNY], script })
  try {
    expect(await until(() => alpha.sessions.created.length === 1)).toBe(true)
    // Fresh evidence, so whichever instance claims it asks through the shared session.
    const archive = new Archive(join(root, "archive.sqlite"))
    importTranscript(archive, archive.project(join(root, "gamma")), turn.replace("ses_pool", "ses_pool2"), "ses_pool2")
    archive.close()

    const asked = () => [...alpha.sessions.generated, ...beta.sessions.generated]
    expect(await until(() => asked().length > 0, 2000)).toBe(true)
    expect([...alpha.sessions.created, ...beta.sessions.created]).toHaveLength(1)
    expect(new Set(asked().map(entry => entry.sessionID))).toEqual(new Set(["ses_historian_1"]))
  } finally { alpha.dispose(); beta.dispose(); await Bun.sleep(20); removeRoot(root) }
})