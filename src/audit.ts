// Operational visibility for OptMem: a bounded, structured record of what the
// background pipeline did, so "is it saving?" is answerable without reading
// the archive by hand. Records carry ids, kinds and counts, never content.
import type { SQLQueryBindings } from "bun:sqlite"
import type { Archive } from "./archive.ts"

export type AuditOp = "select" | "extract" | "embed" | "capture" | "index" | "recall" | "migration"
export type AuditOutcome = "done" | "skipped" | "deferred" | "failed" | "stopped"

export interface AuditEntry {
  /** Monotonic row id: a follower resumes from here instead of a timestamp. */
  id: number
  at: number
  op: AuditOp
  outcome: AuditOutcome
  /** A job, evidence, or session id. Never message text. */
  subject: string
  phase?: string
  model?: string
  /** A fixed reason from the caller; never provider output. */
  reason?: string
  /** Items handled, memories written, passages added. */
  count: number
  durationMs?: number
}

export interface FailureSummary { reason: string; count: number }
export interface CooldownSummary { model: string; until: number; failures: number; kind: string; tag: string }
export interface WorkerState { active: boolean; locations: string[]; lastAt: number | null; releases: string[] }
export interface CaptureState { queued: number; lastAt: number | null; lastError: string | null }
export interface JobState { pending: number; running: number; done: number; failed: number }
export interface EvidenceState { count: number; lastKind: string | null; lastAt: number | null }
export interface MemoriesState { count: number; indexed: number; lastAt: number | null }
export interface Status {
  at: number
  worker: WorkerState
  captures: CaptureState
  jobs: JobState
  failures: FailureSummary[]
  cooldowns: CooldownSummary[]
  evidence: EvidenceState
  memories: MemoriesState
}

export interface AuditQuery {
  ops?: AuditOp[]
  outcomes?: AuditOutcome[]
  since?: number
  /** Exclusive id cursor: returns only rows newer than this, oldest first. */
  after?: number
  limit?: number
}

/** What a caller records: the row id is the archive's to assign. */
export type AuditRecord = Omit<AuditEntry, "id">

const MAX_AUDIT_ROWS = 5000
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 500
const DEFAULT_STALE_MS = 90_000
/** Heartbeats are how `status` tells a working worker from a dead one. */
const HEARTBEAT_KEY = "worker:heartbeat"

export function recordAudit(archive: Archive, entry: AuditRecord): void {
  archive.db.transaction(() => {
    archive.db.query(
      "INSERT INTO audit(at,op,outcome,subject,phase,model,reason,count,duration) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      entry.at, entry.op, entry.outcome, entry.subject,
      entry.phase ?? null, entry.model ?? null, entry.reason ?? null,
      entry.count, entry.durationMs ?? null,
    )
    archive.db.query("DELETE FROM audit WHERE id <= (SELECT max(id)-? FROM audit)").run(MAX_AUDIT_ROWS)
  }).immediate()
}

/** One entry per running plugin instance: which project, which deployed release. */
interface Beat { location: string; release: string; at: number }
interface Heartbeat { workers: Beat[] }

function readHeartbeat(archive: Archive): Heartbeat | null {
  const value = archive.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key=?").get(HEARTBEAT_KEY)?.value
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<Heartbeat>
    if (!Array.isArray(parsed?.workers)) return null
    return { workers: parsed.workers.filter((beat): beat is Beat =>
      typeof beat?.location === "string" && typeof beat?.release === "string" && typeof beat?.at === "number") }
  } catch { return null }
}

/** Each plugin instance beats for itself; stale instances fall off the list. */
export function workerHeartbeat(archive: Archive, location: string, options: { release?: string | undefined; at?: number } = {}): void {
  const at = options.at ?? Date.now()
  const saved = readHeartbeat(archive)
  const live = (saved?.workers ?? []).filter(beat => at - beat.at <= DEFAULT_STALE_MS && beat.location !== location)
  archive.db.query("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(HEARTBEAT_KEY, JSON.stringify({ workers: [...live, { location, release: options.release ?? "unknown", at }] } satisfies Heartbeat))
}

export function auditFeed(archive: Archive, query: AuditQuery = {}): AuditEntry[] {
  const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const filters: string[] = []
  const params: SQLQueryBindings[] = []
  if (query.ops?.length) { filters.push(`op IN (${query.ops.map(() => "?").join(",")})`); params.push(...query.ops) }
  if (query.outcomes?.length) { filters.push(`outcome IN (${query.outcomes.map(() => "?").join(",")})`); params.push(...query.outcomes) }
  if (query.since !== undefined) { filters.push("at>=?"); params.push(Number(query.since)) }
  // A cursor follows forward in time; without one, show the newest rows.
  const following = query.after !== undefined
  if (following) { filters.push("id>?"); params.push(Number(query.after)) }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : ""
  const order = following ? "ASC" : "DESC"
  const rows = archive.db.query<AuditEntry, SQLQueryBindings[]>(
    `SELECT id,at,op,outcome,subject,phase,model,reason,count,duration AS durationMs FROM audit ${where} ORDER BY id ${order} LIMIT ?`,
  ).all(...params, limit)
  return following ? rows : rows.reverse()
}

export function memoryStatus(archive: Archive, options: { at?: number; staleMs?: number } = {}): Status {
  const at = options.at ?? Date.now()
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const beat = readHeartbeat(archive)
  const live = (beat?.workers ?? []).filter(entry => at - entry.at <= staleMs)
  const lastAt = beat?.workers.reduce<number | null>((newest, entry) => newest === null || entry.at > newest ? entry.at : newest, null) ?? null
  const jobs = archive.db.query<JobState, []>(
    "SELECT count(*) FILTER (WHERE state='pending') pending, count(*) FILTER (WHERE state='running') running, count(*) FILTER (WHERE state='done') done, count(*) FILTER (WHERE state='failed') failed FROM jobs",
  ).get()!
  const evidence = archive.db.query<EvidenceState, []>(
    "SELECT count(*) count, (SELECT kind FROM evidence ORDER BY at DESC,id DESC LIMIT 1) lastKind, (SELECT max(at) FROM evidence) lastAt FROM evidence",
  ).get()!
  const memories = archive.db.query<{ count: number; indexed: number; lastAt: number | null }, []>(
    "SELECT count(*) count, (SELECT count(*) FROM vectors) AS 'indexed', (SELECT max(at) FROM memories) lastAt FROM memories",
  ).get()!
  const captures = archive.db.query<CaptureState, []>(
    "SELECT count(*) queued, (SELECT max(requested) FROM captures) lastAt, (SELECT error FROM captures WHERE error IS NOT NULL ORDER BY requested LIMIT 1) lastError FROM captures",
  ).get()!
  return {
    at,
    worker: { active: live.length > 0, locations: live.map(entry => entry.location), lastAt, releases: [...new Set(live.map(entry => entry.release))] },
    captures, jobs, evidence, memories,
    failures: archive.db.query<FailureSummary, []>(
      "SELECT error reason, count(*) count FROM jobs WHERE state='failed' AND error IS NOT NULL GROUP BY error ORDER BY count(*) DESC LIMIT 10",
    ).all(),
    cooldowns: archive.db.query<{ key: string; value: string }, []>("SELECT key,value FROM meta WHERE key LIKE 'cooldown:%'").all()
      .map(({ key, value }): CooldownSummary => {
        try {
          const parsed = JSON.parse(value) as Partial<{ until: number; failures: number; kind: string; tag: string }>
          return { model: key.slice("cooldown:".length), until: Number(parsed.until), failures: Number(parsed.failures),
            kind: String(parsed.kind), tag: String(parsed.tag ?? "unknown") }
        } catch { return { model: key.slice("cooldown:".length), until: 0, failures: 0, kind: "unknown", tag: "unknown" } }
      }),
  }
}