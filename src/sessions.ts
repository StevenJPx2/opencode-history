// The historian's model calls go through sessions: OpenCode's free tier refuses
// the sessionless generate route, and a session answers without recording a
// single message. Each model gets one archived session, created once and
// reused by every plugin instance, deleted when the model leaves the chain.
import type { Archive } from "./archive.ts"
import type { Model } from "./generator.ts"

export interface SessionApi {
  create(input: { title: string; model: Model }): Promise<{ id: string }>
  generate(input: { sessionID: string; prompt: string }, requestOptions?: { signal?: AbortSignal }): Promise<{ text: string }>
  update(input: { sessionID: string; time?: { archived?: number } }): Promise<unknown>
  remove(input: { sessionID: string }): Promise<unknown>
}

export interface SessionPoolOptions {
  archive: Archive
  session: SessionApi
  models: readonly Model[]
  log(message: string): void
  /** Overrides the clock, for tests. */
  now?: () => number
}

const TITLE = "optmem historian"
const KEY = "historian:session"

export class SessionPool {
  private readonly known = new Map<string, string>()

  constructor(private readonly options: SessionPoolOptions) {
    for (const [key, value] of Object.entries(this.read())) this.known.set(key, value)
    // A model that left the chain must not leave an empty session behind.
    void this.reap()
  }

  /** Ask one model through its own archived session. */
  async ask(model: Model, prompt: string, name: string, signal: AbortSignal): Promise<string> {
    const sessionID = await this.sessionFor(model, name)
    // The signal reaches the model call, so a reload can interrupt it.
    return (await this.options.session.generate({ sessionID, prompt }, { signal })).text
  }

  private async sessionFor(model: Model, name: string): Promise<string> {
    const existing = this.known.get(name) ?? this.read()[name]
    if (existing !== undefined) return this.remember(name, existing)

    const created = await this.options.session.create({ title: `${TITLE}: ${name}`, model })
    // Archived on arrival: the session is a transport, not a conversation.
    await this.options.session.update({ sessionID: created.id, time: { archived: (this.options.now ?? Date.now)() } })

    // Another instance may have created one while this one was running. Keep a
    // single session per model: the loser deletes its own and adopts the winner's.
    const winner = this.read()[name]
    if (winner !== undefined && winner !== created.id) {
      await this.options.session.remove({ sessionID: created.id }).catch(() => undefined)
      return this.remember(name, winner)
    }
    this.remember(name, created.id)
    this.options.log(`historian session ready for ${name}`)
    return created.id
  }

  /** Deletes sessions for models that are no longer configured. */
  async reap(): Promise<void> {
    const wanted = new Set(this.options.models.map(modelName))
    for (const [name, sessionID] of [...this.known]) {
      if (wanted.has(name)) continue
      this.known.delete(name)
      this.forget(name)
      try {
        await this.options.session.remove({ sessionID })
      } catch (error) {
        // Already gone is the expected case; never block setup on cleanup.
        this.options.log(`could not remove the historian session for ${name}`)
        void error
      }
    }
  }

  private remember(name: string, sessionID: string): string {
    this.known.set(name, sessionID)
    this.options.archive.db.query("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(KEY, JSON.stringify({ ...this.read(), [name]: sessionID }))
    return sessionID
  }

  private forget(name: string): void {
    const { [name]: _dropped, ...rest } = this.read()
    this.options.archive.db.query("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(KEY, JSON.stringify(rest))
  }

  private read(): Record<string, string> {
    const value = this.options.archive.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(KEY)?.value
    if (!value) return {}
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    } catch { return {} }
  }
}

const modelName = (model: Model) => `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`