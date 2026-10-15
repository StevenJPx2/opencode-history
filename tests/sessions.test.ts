// External session API seam, including the real root-list filtering contract.
import { expect, test } from "bun:test"
import { Archive } from "../src/archive.ts"
import { SessionPool } from "../src/sessions.ts"

const MODEL = { providerID: "opencode", id: "space-bunny-free", variant: "low" }
const NAME = "opencode/space-bunny-free#low"
const signal = () => new AbortController().signal

function service() {
  const rows = new Map<string, { id: string; title: string; parentID?: string; messages: string[] }>([
    ["ses_user", { id: "ses_user", title: "Real work", messages: ["private user conversation"] }],
  ])
  const created: Array<{ id: string; parentID?: string }> = []
  const removed: string[] = []
  const calls: string[] = []
  let serial = 0
  const missing = () => Object.assign(new Error("not found"), { _tag: "SessionNotFoundError" })
  const session = {
    list: async ({ parentID }: { parentID: string | null } = { parentID: null }) => ({ data: [...rows.values()].filter(row => parentID === null ? !row.parentID : row.parentID === parentID) }),
    get: async ({ sessionID }: { sessionID: string }) => {
      const row = rows.get(sessionID)
      if (!row) throw missing()
      return row
    },
    context: async ({ sessionID }: { sessionID: string }) => {
      const row = rows.get(sessionID)
      if (!row) throw missing()
      return row.messages
    },
    create: async (input: { title: string; parentID?: string }) => {
      if (input.parentID && !rows.has(input.parentID)) throw missing()
      const id = `ses_child_${++serial}`
      rows.set(id, { ...input, id, messages: [] })
      created.push({ id, ...(input.parentID ? { parentID: input.parentID } : {}) })
      return { id, ...(input.parentID ? { parentID: input.parentID } : {}) }
    },
    generate: async ({ sessionID }: { sessionID: string }) => {
      if (!rows.has(sessionID)) throw missing()
      calls.push(sessionID)
      return { text: "OK" }
    },
    remove: async ({ sessionID }: { sessionID: string }) => {
      if (!rows.delete(sessionID)) throw missing()
      removed.push(sessionID)
    },
  }
  return { rows, created, removed, calls, session }
}

test("historian children stay out of the root list and never copy parent messages", async () => {
  const archive = new Archive(":memory:")
  const host = service()
  const pool = new SessionPool({ archive, session: host.session, models: [MODEL], log: () => {} })
  try {
    expect(await pool.ask(MODEL, "redacted evidence", NAME, signal())).toBe("OK")
    expect(host.created).toEqual([{ id: "ses_child_1", parentID: "ses_user" }])
    expect((await host.session.list()).data.map(row => row.id)).toEqual(["ses_user"])
    expect(host.rows.get("ses_child_1")!.messages).toEqual([])
  } finally { archive.close() }
})

test("the same child is reused by another instance and after a reload", async () => {
  const archive = new Archive(":memory:")
  const host = service()
  const options = { archive, session: host.session, models: [MODEL], log: () => {} }
  try {
    await new SessionPool(options).ask(MODEL, "first", NAME, signal())
    await new SessionPool(options).ask(MODEL, "second", NAME, signal())
    expect(host.created).toHaveLength(1)
    expect(host.calls).toEqual(["ses_child_1", "ses_child_1"])
  } finally { archive.close() }
})

test("a deleted parent and child are replaced under another real session", async () => {
  const archive = new Archive(":memory:")
  const host = service()
  const pool = new SessionPool({ archive, session: host.session, models: [MODEL], log: () => {} })
  try {
    await pool.ask(MODEL, "first", NAME, signal())
    host.rows.clear() // OpenCode recursively deletes children with their parent.
    host.rows.set("ses_other", { id: "ses_other", title: "More work", messages: [] })
    await pool.ask(MODEL, "second", NAME, signal())
    expect(host.created.at(-1)).toEqual({ id: "ses_child_2", parentID: "ses_other" })
    expect(host.calls).toEqual(["ses_child_1", "ses_child_2"])
  } finally { archive.close() }
})

test("without a parent, defer rather than create another visible root", async () => {
  const archive = new Archive(":memory:")
  const host = service()
  host.rows.clear()
  const pool = new SessionPool({ archive, session: host.session, models: [MODEL], log: () => {} })
  try {
    await expect(pool.ask(MODEL, "prompt", NAME, signal())).rejects.toThrow("waiting for a parent session")
    expect(host.created).toEqual([])
    expect(host.calls).toEqual([])
  } finally { archive.close() }
})

test("a host that silently ignores parentID cannot leave a visible historian root", async () => {
  const archive = new Archive(":memory:")
  const host = service()
  const session = { ...host.session, create: async ({ title }: { title: string }) => host.session.create({ title }) }
  try {
    await expect(new SessionPool({ archive, session, models: [MODEL], log: () => {} }).ask(MODEL, "p", NAME, signal()))
      .rejects.toThrow("waiting for a parent session")
    expect(host.removed).toEqual(["ses_child_1"])
    expect(host.calls).toEqual([])
  } finally { archive.close() }
})

test("only mapped, empty historian roots are removed during migration", async () => {
  const archive = new Archive(":memory:")
  const host = service()
  host.rows.set("ses_old", { id: "ses_old", title: `optmem historian: ${NAME}`, messages: [] })
  host.rows.set("ses_used", { id: "ses_used", title: "optmem historian: used", messages: ["keep me"] })
  host.rows.set("ses_unowned", { id: "ses_unowned", title: "optmem historian: unrelated", messages: [] })
  archive.db.query("INSERT INTO meta VALUES(?,?)").run("historian:session", JSON.stringify({ [NAME]: "ses_old", used: "ses_used" }))
  const pool = new SessionPool({ archive, session: host.session, models: [MODEL], log: () => {} })
  try {
    await pool.cleanup()
    expect(host.removed).toEqual(["ses_old"])
    expect(host.rows.has("ses_used")).toBe(true)
    expect(host.rows.has("ses_unowned")).toBe(true)
    await pool.ask(MODEL, "prompt", NAME, signal())
    expect(host.created[0]!.parentID).toBe("ses_user")
  } finally { archive.close() }
})

test("cleanup retains the mapping when removal fails so it can be retried", async () => {
  const archive = new Archive(":memory:")
  const host = service()
  host.rows.set("ses_old", { id: "ses_old", title: `optmem historian: ${NAME}`, messages: [] })
  archive.db.query("INSERT INTO meta VALUES(?,?)").run("historian:session", JSON.stringify({ [NAME]: "ses_old" }))
  const broken = { ...host.session, remove: async () => { throw new Error("offline") } }
  try {
    await new SessionPool({ archive, session: broken, models: [MODEL], log: () => {} }).cleanup()
    expect(archive.db.query("SELECT value FROM meta WHERE key=?").get("historian:session")).not.toBeNull()
    await new SessionPool({ archive, session: host.session, models: [MODEL], log: () => {} }).cleanup()
    expect(host.removed).toEqual(["ses_old"])
  } finally { archive.close() }
})

test("cleanup never recursively deletes a session with another child", async () => {
  const archive = new Archive(":memory:")
  const host = service()
  host.rows.set("ses_old", { id: "ses_old", title: `optmem historian: ${NAME}`, messages: [] })
  host.rows.set("ses_nested", { id: "ses_nested", title: "User work", parentID: "ses_old", messages: [] })
  archive.db.query("INSERT INTO meta VALUES(?,?)").run("historian:session", JSON.stringify({ [NAME]: "ses_old" }))
  try {
    await new SessionPool({ archive, session: host.session, models: [MODEL], log: () => {} }).cleanup()
    expect(host.removed).toEqual([])
  } finally { archive.close() }
})

test("a child containing user messages is preserved but never reused for model input", async () => {
  const archive = new Archive(":memory:")
  const host = service()
  const pool = new SessionPool({ archive, session: host.session, models: [MODEL], log: () => {} })
  try {
    await pool.ask(MODEL, "first", NAME, signal())
    host.rows.get("ses_child_1")!.messages.push("a secret the user typed")
    await pool.ask(MODEL, "second", NAME, signal())
    expect(host.calls).toEqual(["ses_child_1", "ses_child_2"])
    expect(host.rows.has("ses_child_1")).toBe(true)
  } finally { archive.close() }
})

test("concurrent instances adopt one child and clean up the losing creation", async () => {
  const archive = new Archive(":memory:")
  const host = service()
  const options = { archive, session: host.session, models: [MODEL], log: () => {} }
  try {
    await Promise.all([new SessionPool(options).ask(MODEL, "a", NAME, signal()), new SessionPool(options).ask(MODEL, "b", NAME, signal())])
    expect(new Set(host.calls).size).toBe(1)
    expect([...host.rows.values()].filter(row => row.parentID)).toHaveLength(1)
    expect(host.removed).toHaveLength(host.created.length - 1)
  } finally { archive.close() }
})

test("a model removed from the chain leaves no unused child", async () => {
  const archive = new Archive(":memory:")
  const host = service()
  try {
    await new SessionPool({ archive, session: host.session, models: [MODEL], log: () => {} }).ask(MODEL, "p", NAME, signal())
    await new SessionPool({ archive, session: host.session, models: [], log: () => {} }).cleanup()
    expect(host.removed).toEqual(["ses_child_1"])
  } finally { archive.close() }
})
