// One empty child per model, shared across projects. Children are excluded from
// OpenCode's top-level session lists; the v2 API does not support archiving.
import type { Archive } from "./archive.ts"
import { execFile } from "node:child_process"
import { GenerationDeferred } from "./errors.ts"
import { modelName, type Model } from "./generator.ts"

interface SessionInfo { id: string; title?: string; parentID?: string }
export interface SessionApi {
  create(input: { title: string; model: Model; parentID: string }): Promise<SessionInfo>
  list(input: { parentID: string | null; limit: number }): Promise<{ data: SessionInfo[] }>
  get(input: { sessionID: string }): Promise<SessionInfo>
  context(input: { sessionID: string }): Promise<readonly unknown[]>
  generate(input: { sessionID: string; prompt: string }, requestOptions?: { signal?: AbortSignal }): Promise<{ text: string }>
  remove(input: { sessionID: string }): Promise<unknown>
}

export interface SessionPoolOptions {
  archive: Archive
  session: SessionApi
  models: readonly Model[]
  log(message: string): void
}

const TITLE = "optmem historian: "
const LEGACY_KEY = "historian:session"
const KEY = "historian:children"
const missing = (error: unknown) => (error as { _tag?: unknown } | null)?._tag === "SessionNotFoundError"

/** Plugin hosts lack session.list. The CLI uses the service's stored auth. */
export function listSessions(executable: string, directory: string, input: { parentID: string | null; limit: number }): Promise<{ data: SessionInfo[] }> {
  const path = `/api/session?parentID=${encodeURIComponent(input.parentID ?? "null")}&limit=${Math.min(50, Math.max(1, Math.floor(input.limit)))}`
  return new Promise((resolve, reject) => {
    execFile(executable, ["api", "GET", path], { cwd: directory, timeout: 15_000, maxBuffer: 4 << 20 }, (error, stdout) => {
      // Never surface command output or API response details in memory/audit.
      if (error) { reject(new Error("Historian session listing failed")); return }
      try {
        const value: unknown = JSON.parse(stdout)
        if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) throw new Error()
        const data = value.data.map((row: unknown): SessionInfo => {
          if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string") throw new Error()
          return { id: row.id, ...("title" in row && typeof row.title === "string" ? { title: row.title } : {}),
            ...("parentID" in row && typeof row.parentID === "string" ? { parentID: row.parentID } : {}) }
        })
        resolve({ data })
      } catch { reject(new Error("Historian session listing failed")) }
    })
  })
}

export class SessionPool {
  constructor(private readonly options: SessionPoolOptions) {}

  async ask(model: Model, prompt: string, name: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const sessionID = await this.sessionFor(model, name)
    signal.throwIfAborted()
    return (await this.options.session.generate({ sessionID, prompt }, { signal })).text
  }

  private async sessionFor(model: Model, name: string): Promise<string> {
    const existing = this.read(KEY)[name]
    if (existing) {
      try {
        const info = await this.options.session.get({ sessionID: existing })
        if (info.parentID && info.title === TITLE + name && !(await this.options.session.context({ sessionID: existing })).length) return existing
        // Do not send evidence into an unrelated or user-modified session.
        this.forget(KEY, name, existing)
      } catch (error) {
        if (!missing(error)) throw error
        this.forget(KEY, name, existing)
      }
    }

    const listed = await this.options.session.list({ parentID: null, limit: 50 })
    const parent = listed.data.find(row => !row.parentID && !row.title?.startsWith(TITLE))
    if (!parent) throw new GenerationDeferred()

    // Create a linked child, not a fork: none of the parent's history is copied.
    const created = await this.options.session.create({ title: TITLE + name, model, parentID: parent.id })
    if (created.parentID !== parent.id) {
      // Fail closed if an older host ignores the parentID, as it did time.archived.
      await this.options.session.remove({ sessionID: created.id })
      throw new GenerationDeferred()
    }

    // Remote creation can race. Publish atomically; the loser deletes only its
    // own empty child and adopts the winner, including across plugin processes.
    const winner = this.options.archive.db.transaction(() => {
      const rows = this.read(KEY)
      if (rows[name]) return rows[name]
      this.write(KEY, { ...rows, [name]: created.id })
      return created.id
    }).immediate()
    if (winner !== created.id) {
      // Keep a durable cleanup entry if the server cannot remove it yet.
      this.options.archive.db.transaction(() => {
        this.write(LEGACY_KEY, { ...this.read(LEGACY_KEY), [created.id]: created.id })
      }).immediate()
      await this.removeOwned(LEGACY_KEY, created.id, created.id, TITLE + name)
    }
    return winner
  }

  /** Only remove owned, empty sessions. Never delete by a title search alone. */
  async cleanup(): Promise<void> {
    for (const [name, id] of Object.entries(this.read(LEGACY_KEY))) {
      // Race losers are keyed by id; older root sessions were keyed by model.
      await this.removeOwned(LEGACY_KEY, name, id, name.startsWith("ses_") ? undefined : TITLE + name)
    }
    const wanted = new Set(this.options.models.map(modelName))
    for (const [name, id] of Object.entries(this.read(KEY))) {
      if (!wanted.has(name)) await this.removeOwned(KEY, name, id, TITLE + name)
    }
  }

  private async removeOwned(key: string, name: string, id: string, title?: string): Promise<void> {
    try {
      const info = await this.options.session.get({ sessionID: id })
      if (title ? info.title !== title : !info.title?.startsWith(TITLE)) return
      if ((await this.options.session.context({ sessionID: id })).length) return
      if ((await this.options.session.list({ parentID: id, limit: 1 })).data.length) return
      await this.options.session.remove({ sessionID: id })
      this.forget(key, name, id)
    } catch (error) {
      if (missing(error)) this.forget(key, name, id)
      else this.options.log("historian session cleanup deferred; will retry")
    }
  }

  private forget(key: string, name: string, id: string): void {
    this.options.archive.db.transaction(() => {
      const rows = this.read(key)
      if (rows[name] !== id) return
      delete rows[name]
      this.write(key, rows)
    }).immediate()
  }

  private write(key: string, rows: Record<string, string>): void {
    this.options.archive.db.query("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(key, JSON.stringify(rows))
  }

  private read(key: string): Record<string, string> {
    const value = this.options.archive.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(key)?.value
    if (!value) return {}
    try {
      const parsed: unknown = JSON.parse(value)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    } catch { return {} }
  }
}
