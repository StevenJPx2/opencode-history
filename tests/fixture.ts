// A minimal OpenCode database: the two tables this plugin reads, as OpenCode
// v2.0.29 creates them, minus columns the plugin never reads.
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const DDL = `
  CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL DEFAULT '',
    directory text NOT NULL, title text, version text NOT NULL DEFAULT '2', time_created integer NOT NULL, time_updated integer NOT NULL);
  CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
  CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message (session_id, seq);`

const roots: string[] = []

export interface Fixture {
  readonly root: string
  readonly path: string
  readonly db: Database
  session(id: string, project: string, title: string, parent?: string): void
  /** Appends a message; `at` defaults to a clock that only moves forward. */
  message(session: string, type: string, data: unknown, at?: number): string
}

export function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "history-"))
  roots.push(root)
  const path = join(root, "opencode.db")
  const db = new Database(path, { create: true })
  db.exec(DDL)
  const seqs = new Map<string, number>()
  let clock = Date.UTC(2026, 9, 1)

  return {
    root,
    path,
    db,
    session(id, project, title, parent) {
      db.query("INSERT INTO session_v2(id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?,?,?,?,?,?,?)")
        .run(id, project, parent ?? null, `/work/${project}`, title, clock, clock)
    },
    message(session, type, data, at) {
      const seq = seqs.get(session) ?? 0
      seqs.set(session, seq + 1)
      const time = at ?? (clock += 60_000)
      const id = `msg_${session}_${seq}`
      db.query("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)").run(id, session, type, seq, time, time, JSON.stringify(data))
      return id
    },
  }
}

export const assistant = (...content: unknown[]) => ({ content })
export const text = (value: string) => ({ type: "text", text: value })

export function removeFixtures(): void {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}
