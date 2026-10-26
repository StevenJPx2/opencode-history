// Shared by the recall replays: the index opened read-only, the same message
// sample, and the candidates each message would search, limited to the history
// that existed before it.
import { Database } from "bun:sqlite"
import { readFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { matchExpression } from "../src/history.ts"

const CANDIDATES = 400

const indexPath = process.env.HISTORY_INDEX ??
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "opencode-history/index.sqlite")
export const db = new Database(indexPath, { readonly: true, strict: true })
export const total = db.query<{ n: number }, []>("SELECT count(*) AS n FROM chunks").get()?.n ?? 0
/** Sheets quote private history, so they live outside the repo. */
export const sheetDir = process.env.TMPDIR ?? tmpdir()

export interface UserMessage { message: string; session: string; project: string; at: number; seq: number; text: string }
export interface Candidate {
  id: number; session: string; title: string; message: string; kind: string; at: number
  /** Short, for the sheet. */
  snippet: string
  /** Longer, for a judge. */
  context: string
  /** The whole chunk. */
  text: string
}

const shares = new Map<string, number>()
const countTerm = db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM chunks_fts WHERE chunks_fts MATCH ?")
/** The share of chunks containing `term`. */
export function share(term: string): number {
  let value = shares.get(term)
  if (value === undefined) {
    value = (countTerm.get(`"${term}"`)?.n ?? 0) / total
    shares.set(term, value)
  }
  return value
}

const candidateQuery = db.query<Candidate, [string, string, string, string, number]>(`
  SELECT c.id, c.session, s.title, c.message, c.kind, c.at,
    snippet(chunks_fts, 0, '«', '»', '…', 24) AS snippet, snippet(chunks_fts, 0, '', '', '…', 64) AS context, c.text
  FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN sessions s ON s.id=c.session
  WHERE chunks_fts MATCH ? AND s.project=? AND c.session<>? AND coalesce(s.parent,'')<>? AND c.at<?
  ORDER BY bm25(chunks_fts) LIMIT ${CANDIDATES}`)

/** The message's search terms and its BM25 candidates, best first. */
export function candidatesFor(message: UserMessage): { expression: string; terms: string[]; found: Candidate[] } {
  const expression = matchExpression(message.text)
  const terms = [...expression.matchAll(/"([^"]+)"/g)].map(match => match[1]!)
  const found = terms.length ? candidateQuery.all(expression, message.project, message.session, message.session, message.at) : []
  return { expression, terms, found }
}

/** The best candidate of each session, skipping text a forked session repeats. */
export function distinct(found: readonly Candidate[], limit: number): Candidate[] {
  const sessions = new Set<string>()
  const texts = new Set<string>()
  const out: Candidate[] = []
  for (const row of found) {
    const text = flat(row.snippet)
    if (sessions.has(row.session) || texts.has(text)) continue
    sessions.add(row.session)
    texts.add(text)
    out.push(row)
    if (out.length === limit) break
  }
  return out
}

/** Up to `chars` of the chunk, around the first place its rarest matching term appears. */
export function around(text: string, terms: readonly string[], chars: number): string {
  const clean = flat(text)
  if (clean.length <= chars) return clean
  const lower = clean.toLowerCase()
  // The index stems words, so a term's first letters find its other forms too.
  const hits = terms.map(term => ({ term, at: lower.indexOf(term.slice(0, 5)) })).filter(hit => hit.at >= 0)
    .sort((a, b) => share(a.term) - share(b.term))
  const center = hits[0]?.at ?? 0
  const start = Math.max(0, Math.min(Math.floor(center - chars / 3), clean.length - chars))
  return `${start > 0 ? "…" : ""}${clean.slice(start, start + chars)}${start + chars < clean.length ? "…" : ""}`
}

const previousQuery = db.query<{ text: string }, [string, number]>(
  "SELECT text FROM chunks WHERE session=? AND kind='assistant' AND seq<? ORDER BY seq DESC, part DESC LIMIT 1")
/** The end of the agent's reply just before the message, as the plugin would see it. */
export const previousReply = (message: UserMessage, chars = 600) => {
  const text = flat(previousQuery.get(message.session, message.seq)?.text ?? "")
  return text.length > chars ? `…${text.slice(-chars)}` : text
}

/** Deterministic shuffle, so every replay sees the same messages. */
function shuffled<T>(items: T[], seed = 42): T[] {
  let state = seed
  const random = () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const replayable = db.query<UserMessage, []>(`
  SELECT c.message, c.session, s.project, c.at, c.seq, c.text FROM chunks c JOIN sessions s ON s.id=c.session
  WHERE c.kind='user' AND c.part=0 AND s.parent IS NULL`).all()
  .filter(message => !/^\s*[<[/]/.test(message.text))

/**
 * The messages an earlier sheet replayed, in its order, matched by session and
 * quoted text. The index grows, so a fresh shuffle would pick other messages.
 */
function fromSheet(path: string): UserMessage[] {
  const entries = [...readFileSync(path, "utf8").matchAll(/^## \d+\..*\n\S+ · (ses_\S+)\n(?:Previous reply: .*\n)?> (.*)$/gm)]
  return entries.map(([, session, quoted]) => {
    const prefix = quoted!.replace(/…$/, "")
    const found = replayable.find(message => message.session === session && flat(message.text).startsWith(prefix))
    if (!found) throw new Error(`sheet message not found in ${session}: ${prefix.slice(0, 60)}`)
    return found
  })
}

/**
 * Top-level user messages in a fixed random order, without injected reminders,
 * monitor events or commands; or, with `REPLAY_SAMPLE` set to an earlier sheet,
 * exactly that sheet's messages.
 */
export const messages = process.env.REPLAY_SAMPLE ? fromSheet(process.env.REPLAY_SAMPLE) : shuffled(replayable)

export function flat(text: string): string { return text.replace(/\s+/g, " ").trim() }
export const clip = (text: string, limit: number) => { const line = flat(text); return line.length > limit ? `${line.slice(0, limit - 1)}…` : line }
export const day = (at: number) => new Date(at).toISOString().slice(0, 10)
export const percent = (value: number) => `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`
export function quantile(values: readonly number[], q: number): string {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]?.toFixed(0) ?? "—"
}
