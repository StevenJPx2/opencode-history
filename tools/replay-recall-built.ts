// Replays sampled user messages through the plugin's own recall code: its
// candidate search, judge call and choice. The plugin's index is copied to a
// temporary file first, since opening it can write. Sends message text and
// quoted passages to the judge's API.
//   TYPESAFE_API_KEY=… bun tools/replay-recall-built.ts [sample=60] [sheet path]
import { rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { HistoryIndex, type Passage } from "../src/history.ts"
import { CANDIDATES, chosen, judge, judgeConfig, PASSAGE_CHARS, PREVIOUS_CHARS, recallText } from "../src/recall.ts"
import { clip, day, db, messages, percent, previousReply, quantile, sheetDir } from "./replay-common.ts"

const sample = Number(process.argv[2] ?? 60)
const sheet = process.argv[3] ?? join(sheetDir, "recall-replay-built.md")
const config = judgeConfig(process.env, 10_000)
if (!config) throw new Error("Set TYPESAFE_API_KEY")

const copy = join(sheetDir, `recall-replay-index-${process.pid}.sqlite`)
writeFileSync(copy, db.serialize(), { mode: 0o600 })
const index = new HistoryIndex(copy)

interface Run { number: number; message: string; candidates: Passage[]; probabilities: number[]; attached: Passage[]; ms?: number; error?: string }
const runs: Run[] = []
try {
  for (const [i, message] of messages.slice(0, sample).entries()) {
    const candidates = index.recallCandidates(message.text, { project: message.project, exclude: message.session, limit: CANDIDATES, chars: PASSAGE_CHARS, before: message.at })
    const run: Run = { number: i + 1, message: message.text, candidates, probabilities: [], attached: [] }
    if (candidates.length) {
      const started = performance.now()
      try {
        run.probabilities = await judge(config, message.text, previousReply(message, PREVIOUS_CHARS), candidates)
        run.attached = chosen(candidates, run.probabilities)
        run.ms = performance.now() - started
      } catch (error) {
        run.error = error instanceof Error ? error.message : "unknown error"
      }
    }
    runs.push(run)
  }
} finally {
  index.close()
  db.close()
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${copy}${suffix}`, { force: true })
}

const fired = runs.filter(run => run.attached.length)
const failed = runs.filter(run => run.error)
console.log(`built path: ${runs.length} messages; ${runs.filter(run => run.candidates.length).length} had candidates; ${failed.length} failed`)
console.log(`  attached: ${fired.length} of ${runs.length} messages (${percent(fired.length / (runs.length || 1))}): #${fired.map(run => run.number).join(", #")}`)
console.log(`  passages per attaching message: ${(fired.reduce((n, run) => n + run.attached.length, 0) / (fired.length || 1)).toFixed(2)}`)
const times = runs.flatMap(run => run.ms === undefined ? [] : [run.ms])
console.log(`  judge time: p50 ${quantile(times, 0.5)} ms, p95 ${quantile(times, 0.95)} ms`)

const rows = runs.map(run => [
  `## ${run.number}. ${run.error ? `error (${run.error})` : run.attached.length ? "attach" : run.candidates.length ? "skip" : "no candidates"}`,
  `> ${clip(run.message, 400)}`,
  ...run.candidates.map((p, i) => `   - p=${run.probabilities[i]?.toFixed(2) ?? "—"} · ${day(p.at)} · ${clip(p.title || "Untitled", 80)} · ${p.session}`),
  ...(run.attached.length ? ["", "```", recallText(run.attached), "```"] : []),
].join("\n"))
writeFileSync(sheet, `# Recall replay: built path\n\n${rows.join("\n\n")}\n`, { mode: 0o600 })
console.log(`sheet: ${sheet}`)
