// Read-only view of the live archive: `bun run status`, `bun run audit --follow`.
// Nothing here writes: the same questions the agent asks through memory_status.
import { Archive } from "../src/archive.ts"
import { auditFeed, memoryStatus, type AuditOp } from "../src/audit.ts"

const path = process.env.OPTMEM_ARCHIVE ?? `${process.env.HOME}/.local/share/optmem/archive.sqlite`
const args = process.argv.slice(2)
const archive = new Archive(path)
let timer: ReturnType<typeof setInterval> | undefined
try {
  if (args[0] === "audit") {
    const OPS: AuditOp[] = ["capture","select","extract","embed","recall","index","migration"]
    const named = args.slice(1).filter(arg => !arg.startsWith("--"))
    const unknown = named.filter(arg => !OPS.includes(arg as AuditOp))
    if (unknown.length) throw new Error(`Unknown operation(s): ${unknown.join(", ")}. Known: ${OPS.join(", ")}`)
    const ops = named as AuditOp[]
    let cursor: number | undefined
    const print = () => {
      // Without a cursor show the newest events; with one, read forward from it.
      for (const entry of auditFeed(archive, cursor === undefined ? { ops, limit: 50 } : { ops, after: cursor, limit: 200 })) {
        cursor = entry.id
        console.log(`${new Date(entry.at).toISOString()} ${entry.op} ${entry.outcome}${entry.count ? ` x${entry.count}` : ""} ${entry.subject}${entry.reason ? ` (${entry.reason})` : ""}`)
      }
    }
    print()
    // Ref'd on purpose: nothing else keeps the process alive while following.
    if (args.includes("--follow")) timer = setInterval(print, 2_000)
  } else {
    const status = memoryStatus(archive)
    const ago = (at: number | null) => at === null ? "never" : `${Math.round((Date.now() - at) / 1000)}s ago`
    console.log(`worker      ${status.worker.active ? "alive" : "NOT RUNNING"} (last beat ${ago(status.worker.lastAt)}${status.worker.releases.length ? `, release ${status.worker.releases.join(", ")}` : ""}${status.worker.locations.length > 1 ? `, ${status.worker.locations.length} projects` : ""})`)
    console.log(`captures    ${status.captures.queued} queued, last ${ago(status.captures.lastAt)}${status.captures.lastError ? `, error: ${status.captures.lastError}` : ""}`)
    console.log(`jobs        ${status.jobs.done} done, ${status.jobs.pending} pending, ${status.jobs.running} running, ${status.jobs.failed} failed`)
    console.log(`evidence    ${status.evidence.count} records, last ${status.evidence.lastKind ?? "none"} ${ago(status.evidence.lastAt)}`)
    console.log(`memories    ${status.memories.count} written, ${status.memories.indexed} indexed, last ${ago(status.memories.lastAt)}`)
    for (const cooldown of status.cooldowns) console.log(`cooldown    ${cooldown.model} until ${new Date(cooldown.until).toISOString()} (${cooldown.failures} failures, ${cooldown.tag})`)
    for (const failure of status.failures) console.log(`failed      ${failure.count}x ${failure.reason}`)
  }
} finally { clearInterval(timer); archive.close() }