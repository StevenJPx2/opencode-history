// Offline replay of the keyword recall bar over the existing index. Each past
// user message is replayed against only the history that existed before it.
// Read-only: the index is opened without writing and no model is called.
//   bun tools/replay-recall.ts [sample=60] [stats=1000] [sheet path]
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { candidatesFor, clip, day, db, messages, percent, quantile, share, sheetDir, total, type Candidate, type UserMessage } from "./replay-common.ts"

/** A word is rare when it appears in fewer than this share of chunks. */
const RARE = 0.01
const MIN_SHARED = 2
const MAX_PASSAGES = 3

const sample = Number(process.argv[2] ?? 60)
const statsSize = Number(process.argv[3] ?? 1000)
const sheet = process.argv[4] ?? join(sheetDir, "recall-replay.md")

interface Passage extends Candidate { shared: string[] }
type Reason = "fired" | "no terms" | "no candidates" | "below bar"
interface Replay { message: UserMessage; terms: string[]; reason: Reason; passages: Passage[]; ms: number }

const containing = db.query<{ id: number }, [string, string]>(
  "SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))")

function replay(message: UserMessage): Replay {
  const started = performance.now()
  const { terms, found } = candidatesFor(message)
  const done = (reason: Reason, passages: Passage[] = []): Replay =>
    ({ message, terms, reason, passages, ms: performance.now() - started })
  if (!terms.length) return done("no terms")
  if (!found.length) return done("no candidates")

  const ids = JSON.stringify(found.map(row => row.id))
  const shared = new Map<number, string[]>()
  for (const term of terms) {
    for (const { id } of containing.all(`"${term}"`, ids)) shared.set(id, [...(shared.get(id) ?? []), term])
  }

  const best = new Map<string, Passage>()
  for (const row of found) {
    const words = shared.get(row.id) ?? []
    const passes = words.length >= MIN_SHARED && words.some(word => share(word) < RARE)
    if (passes && !best.has(row.session)) best.set(row.session, { ...row, shared: words })
  }
  const passages = [...best.values()].slice(0, MAX_PASSAGES)
  return done(passages.length ? "fired" : "below bar", passages)
}

const replays = messages.slice(0, Math.max(sample, statsSize)).map(replay)

const measured = replays.slice(0, statsSize)
const reasons = new Map<Reason, number>()
for (const run of measured) reasons.set(run.reason, (reasons.get(run.reason) ?? 0) + 1)
const fired = measured.filter(run => run.reason === "fired")
const times = measured.map(run => run.ms)

console.log(`index: ${total} chunks; ${messages.length} replayable user messages; ${measured.length} replayed`)
for (const [reason, count] of reasons) console.log(`  ${reason}: ${count} (${percent(count / measured.length)})`)
console.log(`  passages per fired message: ${(fired.reduce((n, run) => n + run.passages.length, 0) / (fired.length || 1)).toFixed(2)}`)
console.log(`  time per message: p50 ${quantile(times, 0.5)} ms, p95 ${quantile(times, 0.95)} ms, max ${quantile(times, 1)} ms`)

const rows = replays.slice(0, sample).map((run, i) => {
  const terms = run.terms.map(term => `${term} (${percent(share(term))})`).join(", ") || "—"
  const passages = run.passages.map(p =>
    `   - ${day(p.at)} · ${clip(p.title || "Untitled", 80)} · ${p.session} · shared: ${p.shared.join(", ")}\n     > ${clip(p.snippet, 300)}`)
  return [
    `## ${i + 1}. ${run.reason}`,
    `${day(run.message.at)} · ${run.message.session}`,
    `> ${clip(run.message.text, 400)}`,
    `Terms (share of chunks): ${terms}`,
    ...(passages.length ? ["Would attach:", ...passages] : []),
    run.reason === "fired" ? "Label: [ ] useful  [ ] noise" : "Label: [ ] correct skip  [ ] missed",
  ].join("\n")
})
db.close()
writeFileSync(sheet, `# Recall replay\n\nBar: ≥${MIN_SHARED} shared words, ≥1 in <${percent(RARE)} of chunks; ≤${MAX_PASSAGES} passages.\n\n${rows.join("\n\n")}\n`, { mode: 0o600 })
console.log(`labeling sheet (${Math.min(sample, replays.length)} messages): ${sheet}`)
