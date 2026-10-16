import { spawn } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Archive, digest, type Evidence } from "./archive.ts"
import { recordAudit } from "./audit.ts"
import { transcriptText } from "./passages.ts"

export interface Transcript { info: {id: string; parentID?: string}; messages: Array<Record<string, unknown>> }
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Preserve complete exports, then source-linked, bounded passages for processing. */
export function importTranscript(archive: Archive, project: string, raw: string, sessionID?: string): number {
  const parsed: unknown = JSON.parse(raw)
  const data = record(parsed)
  const info = record(data.info)
  if (typeof info.id !== "string" || !Array.isArray(data.messages) || (sessionID && info.id !== sessionID)) throw new Error("Invalid full transcript export")

  const session = info.id
  let added = 0
  archive.db.transaction(() => {
    // Full original export retained even for irrelevant/system/partial messages.
    const root = `transcript:${session}:${digest(raw)}`
    const created = record(info.time).created
    const at = typeof created === "number" && Number.isFinite(created) ? created : 0
    archive.capture({id:root,project,session,message:root,kind:"transcript",at,text:"",payload:raw},false)
    for (const value of data.messages as unknown[]) {
      const message = record(value)
      if (typeof message.id !== "string" || typeof message.type !== "string") throw new Error("Invalid transcript message")

      const payload = JSON.stringify(message)
      const time = record(message.time)
      const at = typeof time.created === "number" && Number.isFinite(time.created) ? time.created : 0
      const id = `message:${session}:${message.id}:${digest(payload)}`
      const text = transcriptText(message)
      // A session moved to another project keeps its earlier messages where
      // they happened; only identical content may adopt the earlier project.
      const prior = archive.evidence(id)
      const scope = prior && prior.kind === "original" && prior.session === session && prior.payload === payload ? prior.project : project
      archive.capture({id,project:scope,session,message:message.id,kind:"original",at,text:"",payload},false)
      // Never extract an in-flight assistant response. Durable event capture
      // retains intermediate states; a later completed export supplies passages.
      if (message.type === "assistant" && time.completed === undefined) continue
      if (!["user","assistant","shell"].includes(message.type) || !text.trim()) continue

      for (let start = 0; start < text.length; start += 7600) {
        const end = Math.min(text.length,start+8000)
        const passage: Evidence = {id:`passage:${id}:${start}`,project:scope,session,message:message.id,
          kind:message.type,at,text:text.slice(start,end),payload:JSON.stringify({original:id,start,end})}
        if (archive.capture(passage)) added++
      }
    }
  }).immediate()
  return added
}

/**
 * CLI export is the documented full-history API; context is not a substitute.
 *
 * The child writes into a real file rather than a pipe: the CLI truncates its
 * own output on a pipe, which silently loses the tail of long conversations.
 */
export async function exportTranscript(executable: string, sessionID: string, directory: string, signal: AbortSignal, server?: string, spool = tmpdir()): Promise<string> {
  const file = join(spool, `optmem-export-${process.pid}-${randomUUID()}.json`)
  mkdirSync(spool, {recursive:true, mode:0o700})
  // Transcripts can hold anything the user typed: owner-only, removed on the way out.
  const handle = openSync(file, "wx", 0o600)
  try {
    const code = await new Promise<number|null>((resolve,reject) => {
      const child = spawn(executable, ["session","export",sessionID,...server ? ["--server",server] : []],
        {cwd:directory, stdio:["ignore",handle,"ignore"], signal, timeout:60_000, killSignal:"SIGKILL"})
      child.on("error", reject)
      child.on("close", exit => resolve(exit))
    })
    if (code !== 0) throw new Error("Full transcript export failed")
    return readFileSync(file, "utf8")
  } catch {
    // Never let CLI output or detail reach the log or the audit feed.
    throw new Error("Full transcript export failed")
  } finally { closeSync(handle); rmSync(file, {force:true}) }
}

export class CaptureQueue {
  private active: Promise<void> | undefined
  private stopped = false
  private readonly controller = new AbortController()
  constructor(private readonly archive: Archive, private readonly read: typeof exportTranscript,
    private readonly executable: string, private readonly log: (message:string) => void, private readonly server?: string) {}

  request(session: string, project: string, directory: string): void {
    this.archive.db.query(`INSERT INTO captures(session,project,directory,requested) VALUES(?,?,?,?)
      ON CONFLICT(session) DO UPDATE SET project=excluded.project,directory=excluded.directory,requested=excluded.requested`)
      .run(session,project,directory,Date.now())
  }

  pass(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.active) return this.active

    this.active = this.work().finally(() => { this.active = undefined })
    return this.active
  }

  private async work(): Promise<void> {
    for (let i=0;i<8 && !this.stopped;i++) {
      const job = this.archive.db.transaction(() => {
        const now = Date.now()
        const row = this.archive.db.query<{session:string;project:string;directory:string;requested:number}, [number,number]>(
          "SELECT session,project,directory,requested FROM captures WHERE ready<=? AND lease<=? ORDER BY requested LIMIT 1").get(now,now)
        if (!row) return null

        const token = crypto.randomUUID()
        this.archive.db.query("UPDATE captures SET token=?,lease=? WHERE session=?").run(token,now+90_000,row.session)
        return {...row,token}
      }).immediate()
      if (!job) return

      let stage: "export" | "import" = "export"
      try {
        const raw = await this.read(this.executable,job.session,job.directory,this.controller.signal,this.server)
        stage = "import"
        this.archive.db.transaction(() => {
          const owned = this.archive.db.query("SELECT 1 FROM captures WHERE session=? AND token=? AND lease>?").get(job.session,job.token,Date.now())
          if (!owned) return

          const passages = importTranscript(this.archive,job.project,raw,job.session)
          this.archive.db.query("DELETE FROM captures WHERE session=? AND token=? AND requested=?").run(job.session,job.token,job.requested)
          this.archive.db.query("UPDATE captures SET token=NULL,lease=0 WHERE session=? AND token=?").run(job.session,job.token)
          // Silence here is the signal that conversations stopped being saved.
          recordAudit(this.archive, {at: Date.now(), op:"capture", outcome:"done", subject:job.session, count:passages})
        }).immediate()
      } catch {
        // After shutdown the archive may be closed; the expired lease retries it.
        if (this.stopped) return

        // Fixed text only: the stage, never the error's own words.
        const reason = stage === "export" ? "Full export failed; queued for retry" : "Transcript import failed; queued for retry"
        this.archive.db.query("UPDATE captures SET token=NULL,lease=0,ready=?,error=? WHERE session=? AND token=?")
          .run(Date.now()+60_000,reason,job.session,job.token)
        this.log(`conversation ${stage} failed; queued for retry`)
        recordAudit(this.archive, {at: Date.now(), op:"capture", outcome:"deferred", subject:job.session, reason, count:0})
      }
    }
  }
  async stop(): Promise<void> { this.stopped = true; this.controller.abort(); await this.active }
}
