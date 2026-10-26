// Builds or refreshes the history index from OpenCode's database, reporting progress.
// The plugin does this itself in the background; this is for a first build or a check.
//   bun tools/history-sync.ts [opencode.db] [index.sqlite]
import { homedir } from "node:os"
import { join } from "node:path"
import { HistoryIndex, openSource } from "../src/history.ts"

const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share")
const source = openSource(process.argv[2] ?? join(data, "opencode/opencode.db"))
const index = new HistoryIndex(process.argv[3] ?? join(data, "opencode-history/index.sqlite"))
const started = performance.now()
let totals = { sessions: 0, chunks: 0 }
try {
  for (;;) {
    const report = index.sync(source, { budgetMs: 2000 })
    totals = { sessions: totals.sessions + report.sessions, chunks: totals.chunks + report.chunks }
    console.log(`${totals.sessions} sessions, ${totals.chunks} chunks, ${report.remaining} remaining, ${((performance.now() - started) / 1000).toFixed(1)}s`)
    if (report.remaining === 0) break
  }
  index.db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')")
} finally {
  index.close()
  source.close()
}
