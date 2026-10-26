// Bounded, metadata-only diagnostics. Audit failure must never break the tool.
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname } from "node:path"

/** At most two files of this size are kept. */
export const AUDIT_BYTES = 1024 * 1024

export interface AuditEvent {
  session: string
  mode: "search" | "open" | "invalid"
  status: "ok" | "error"
  duration_ms: number
  scope?: "project" | "all"
  session_filter?: boolean
  results?: number
  pending?: number
  error?: "invalid_input" | "message_not_found" | "execution_failed"
}

export class AuditLog {
  private warned = false

  constructor(private readonly path: string, private readonly warn: (message: string) => void) {}

  record(event: AuditEvent): void {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), tool: "history_search", ...event }) + "\n"
      const bytes = Buffer.byteLength(line)
      if (bytes > AUDIT_BYTES) return

      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      if (existsSync(this.path) && statSync(this.path).size + bytes > AUDIT_BYTES) {
        renameSync(this.path, `${this.path}.1`)
      }
      appendFileSync(this.path, line, { mode: 0o600 })
      chmodSync(this.path, 0o600)
    } catch {
      if (!this.warned) {
        this.warned = true
        this.warn("history_search audit unavailable; tool calls still work")
      }
    }
  }
}
