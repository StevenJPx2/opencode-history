// Stateless model calls for the historian, with per-model cooldowns. OpenCode's
// `generate.text` never creates a session. Cooldowns live in the archive, so
// every plugin instance (one per open project) backs off together instead of
// each hammering a provider that is down or rate-limited.
import type { Archive } from "./archive.ts"
import { GenerationCancelled, GenerationInterrupted, GenerationUnavailable } from "./errors.ts"

export interface Model { providerID: string; id: string; variant?: string }
export type Call = (model: Model, prompt: string, signal: AbortSignal) => Promise<string>

type Failure =
  | { kind: "interrupted" }
  | { kind: "unavailable" | "rejected"; retryAfterMs: number; tag: string }

interface Cooldown { until: number; failures: number; kind: "unavailable" | "rejected"; tag: string }

const FIRST_COOLDOWN_MS = 60_000
const MAX_OUTAGE_COOLDOWN_MS = 30 * 60_000
const REJECTED_COOLDOWN_MS = 30 * 60_000
const MAX_RETRY_AFTER_MS = 6 * 60 * 60_000
/** Request faults that will not fix themselves on the next attempt. */
const REJECTED_TAGS = new Set(["InvalidRequestError", "UnauthorizedError", "ForbiddenError", "NotFoundError"])

export const modelName = (model: Model) => `${model.providerID}/${model.id}${model.variant ? `#${model.variant}` : ""}`

function classify(error: unknown): Failure {
  const message = error instanceof Error ? error.message : ""
  if (/interrupted/i.test(message)) return { kind: "interrupted" }

  const seconds = /retry-after=(\d+)s/i.exec(message)?.[1]
  const retryAfterMs = Math.min(MAX_RETRY_AFTER_MS, seconds ? Number(seconds) * 1000 : 0)
  const tag = (error as { _tag?: unknown } | null)?._tag
  // Only the tag, a fixed enumeration the provider already assigns, is kept:
  // enough to tell a quota from an outage, and never the words themselves.
  const name = typeof tag === "string" ? tag : "unknown"
  return { kind: REJECTED_TAGS.has(name) ? "rejected" : "unavailable", retryAfterMs, tag: name }
}

export class Generator {
  constructor(
    private readonly archive: Archive,
    private readonly models: readonly Model[],
    private readonly call: Call,
    private readonly now: () => number = Date.now,
  ) {}

  async generate(prompt: string, signal: AbortSignal): Promise<string> {
    const ready = this.models.filter(model => (this.cooldown(model)?.until ?? 0) <= this.now())
    for (const model of ready) {
      try {
        const text = await this.call(model, prompt, signal)
        this.archive.db.query("DELETE FROM meta WHERE key=?").run(this.key(model))
        return text
      } catch (error) {
        if (signal.aborted) throw new GenerationCancelled()

        const failure = classify(error)
        if (failure.kind === "interrupted") throw new GenerationInterrupted()

        this.coolDown(model, failure.kind, failure.retryAfterMs, failure.tag)
      }
    }
    throw new GenerationUnavailable(Math.min(...this.models.map(model => this.cooldown(model)?.until ?? this.now())))
  }

  private coolDown(model: Model, kind: Cooldown["kind"], retryAfterMs: number, tag: string): void {
    const failures = (this.cooldown(model)?.failures ?? 0) + 1
    const backoff = kind === "rejected"
      ? REJECTED_COOLDOWN_MS
      : Math.min(MAX_OUTAGE_COOLDOWN_MS, FIRST_COOLDOWN_MS * 2 ** Math.min(failures - 1, 10))
    const cooldown: Cooldown = { until: this.now() + Math.max(backoff, retryAfterMs), failures, kind, tag }
    this.archive.db.query("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(this.key(model), JSON.stringify(cooldown))
  }

  private cooldown(model: Model): Cooldown | undefined {
    const value = this.archive.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(this.key(model))?.value
    return value === undefined ? undefined : JSON.parse(value) as Cooldown
  }

  private key(model: Model): string { return `cooldown:${modelName(model)}` }
}
