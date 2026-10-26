// Search over OpenCode's own session history.
//
// OpenCode's database is the source of truth and is only ever opened read-only.
// It has no full-text index, so this file keeps a rebuildable sidecar: one row
// per chunk of user text, assistant text and compaction summary, with FTS5 over
// it. Reasoning and tool calls are never indexed. Deleting the sidecar loses
// nothing: sessions are re-read and recent-work blocks are rebuilt on demand.
//
// OpenCode does not reliably bump a session's `time_updated` when its messages
// change, so change detection uses each session's highest message `seq`, read
// from OpenCode's own (session_id, seq) index. The last indexed message is
// re-read with every change, which picks up an assistant reply that completed
// after it was first indexed.
//
// Every fact this plugin relies on about OpenCode's tables lives in this file.
import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"

export type ChunkKind = "user" | "assistant" | "compaction"

export interface Hit {
  readonly session: string
  readonly title: string
  readonly message: string
  readonly kind: ChunkKind
  readonly at: number
  readonly snippet: string
}

export interface SyncReport {
  readonly sessions: number
  readonly chunks: number
  readonly removed: number
  readonly remaining: number
}

export interface SearchOptions {
  /** OpenCode project ID; undefined searches every project. */
  readonly project?: string
  /** Search inside this one session only. */
  readonly session?: string
  /** Leave this session out, normally the one asking. */
  readonly exclude?: string
  readonly limit?: number
}

export interface SessionInfo { readonly project: string; readonly parent: string | null }

export interface RecentSession {
  readonly id: string
  readonly title: string
  readonly at: number
  /** The latest compaction summary's objective, or else the first user message. */
  readonly gist: { readonly kind: "objective" | "first ask"; readonly text: string } | undefined
}

/** Sessions created by the retired unified-mode historian hold copied evidence, not work. */
const EXCLUDED_TITLE = "optmem historian:"
const CHUNK_CHARS = 1500
const CHUNK_OVERLAP = 200
const MAX_TERMS = 32
const INDEX_VERSION = 3
/** Messages per indexing step; bounds how long one step holds the host's event loop. */
const PAGE_MESSAGES = 50

const REQUIRED = {
  session_v2: ["id", "project_id", "parent_id", "title", "directory", "time_created", "time_updated"],
  session_message: ["id", "session_id", "type", "seq", "time_created", "data"],
} as const

// Common English function words and the conversational filler of prompts to an
// agent. On the evaluation set, dropping them kept every hit and cut query time by two thirds.
const STOPWORDS = new Set(`a about above after again against all am an and any are as at be because been before being below between both but by
can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its itself
just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their them then
there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours
yourself please let lets us ok okay yes also might maybe like want need know think see look use using get got make sure one thing things something
really still actually going go way done`.split(/\s+/))

export class SourceSchemaError extends Error {
  override readonly name = "SourceSchemaError"
}

/** Opens OpenCode's database read-only and refuses a layout this code does not know. */
export function openSource(path: string): Database {
  const db = new Database(path, { readonly: true, strict: true })
  try {
    for (const [table, columns] of Object.entries(REQUIRED)) {
      const present = new Set(db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map(row => row.name))
      const missing = columns.filter(column => !present.has(column))
      if (missing.length) throw new SourceSchemaError(`OpenCode table ${table} lacks ${missing.join(", ")}`)
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** Windows of at most `size` characters, overlapping, cut at whitespace when one is near. */
export function chunk(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP): string[] {
  const clean = text.trim()
  if (clean.length <= size) return clean ? [clean] : []

  const out: string[] = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length)
    if (end < clean.length) {
      const space = clean.lastIndexOf(" ", end)
      if (space > start + size * 0.6) end = space
    }
    out.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return out
}

/** An FTS5 expression from free text: content words only, each quoted, so no input is query syntax. */
export function matchExpression(query: string): string {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []
  const content = words.filter(word => !STOPWORDS.has(word))
  // A query of nothing but common words still means something; search them rather than nothing.
  const terms = [...new Set(content.length ? content : words)].slice(0, MAX_TERMS)
  return terms.map(term => `"${term}"`).join(" OR ")
}

interface SourceSession { id: string; project: string; parent: string | null; title: string; created: number; updated: number; seq: number }
interface SourceMessage { id: string; type: ChunkKind; seq: number; at: number; text: string | null }

const SOURCE_SESSIONS = `
  SELECT s.id, s.project_id AS project, s.parent_id AS parent, coalesce(s.title,'') AS title,
    s.time_created AS created, s.time_updated AS updated, coalesce(m.seq,-1) AS seq
  FROM session_v2 s LEFT JOIN (SELECT session_id, max(seq) AS seq FROM session_message GROUP BY session_id) m ON m.session_id=s.id`

// Text is extracted inside SQLite so tool output, often megabytes, never crosses into JS.
const MESSAGE_TEXT = `CASE WHEN NOT json_valid(m.data) THEN NULL
    WHEN m.type='user' THEN json_extract(m.data,'$.text')
    WHEN m.type='compaction' THEN json_extract(m.data,'$.summary')
    ELSE (SELECT group_concat(json_extract(c.value,'$.text'), char(10)||char(10)) FROM json_each(m.data,'$.content') c
          WHERE json_extract(c.value,'$.type')='text') END`
const INDEXED_TYPES = "('user','assistant','compaction')"

const SOURCE_MESSAGES = `
  SELECT m.id, m.type, m.seq, m.time_created AS at, ${MESSAGE_TEXT} AS text
  FROM session_message m WHERE m.session_id=? AND m.seq>=? AND m.type IN ${INDEXED_TYPES} ORDER BY m.seq LIMIT ?`

export interface FullMessage {
  readonly id: string
  readonly session: string
  readonly title: string
  readonly kind: ChunkKind
  readonly at: number
  readonly text: string
}

/** One searchable message in full, read fresh from OpenCode, or undefined if it is unknown or holds no text. */
export function readMessage(source: Database, messageID: string): FullMessage | undefined {
  const row = source.query<FullMessage & { text: string | null }, [string]>(`
    SELECT m.id, m.session_id AS session, coalesce(s.title,'') AS title, m.type AS kind, m.time_created AS at, ${MESSAGE_TEXT} AS text
    FROM session_message m JOIN session_v2 s ON s.id=m.session_id WHERE m.id=? AND m.type IN ${INDEXED_TYPES}`).get(messageID)
  return row?.text?.trim() ? { ...row, text: row.text } : undefined
}

/** The session's project and parent, straight from OpenCode, or undefined for an unknown ID. */
export function sessionInfo(source: Database, sessionID: string): SessionInfo | undefined {
  return source.query<SessionInfo, [string]>("SELECT project_id AS project, parent_id AS parent FROM session_v2 WHERE id=?").get(sessionID) ?? undefined
}

/** The project's latest top-level sessions by last message, newest first. */
export function recentSessions(source: Database, project: string, exclude: string, limit: number): RecentSession[] {
  const rows = source.query<{ id: string; title: string; at: number }, [string, string, string, number]>(`
    SELECT s.id, coalesce(s.title,'') AS title, max(m.time_created) AS at
    FROM session_v2 s JOIN session_message m ON m.session_id=s.id
    WHERE s.project_id=? AND s.parent_id IS NULL AND s.id<>? AND coalesce(s.title,'') NOT LIKE ? || '%'
    GROUP BY s.id ORDER BY at DESC LIMIT ?`).all(project, exclude, EXCLUDED_TITLE, limit)
  const summary = source.query<{ text: string | null }, [string]>(`SELECT json_extract(data,'$.summary') AS text FROM session_message
    WHERE session_id=? AND type='compaction' AND json_valid(data) ORDER BY seq DESC LIMIT 1`)
  const first = source.query<{ text: string | null }, [string]>(`SELECT json_extract(data,'$.text') AS text FROM session_message
    WHERE session_id=? AND type='user' AND json_valid(data) ORDER BY seq LIMIT 1`)

  return rows.map(row => {
    const objective = objectiveOf(summary.get(row.id)?.text ?? "")
    const ask = (first.get(row.id)?.text ?? "").split("\n").map(line => line.trim()).find(Boolean)
    const gist = objective ? { kind: "objective" as const, text: objective } : ask ? { kind: "first ask" as const, text: ask } : undefined
    return { id: row.id, title: row.title, at: row.at, gist }
  })
}

/** The body of a compaction summary's `## Objective` section, as one line. */
export function objectiveOf(summary: string): string | undefined {
  const match = /^##\s*Objective\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(summary)
  const text = match?.[1]?.split("\n").map(line => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean).join(" ")
  return text || undefined
}

export class HistoryIndex {
  readonly db: Database

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new Database(path, { create: true, strict: true })
    if (path !== ":memory:") chmodSync(path, 0o600)
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
    // Everything here is derived from OpenCode, so a layout change rebuilds rather than migrates.
    this.db.transaction(() => {
      if (this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version === INDEX_VERSION) return
      // Includes tables only older layouts had, so a rebuild leaves nothing behind.
      this.db.exec(`DROP TABLE IF EXISTS chunks_fts; DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS sessions;
        DROP TABLE IF EXISTS blocks; DROP TABLE IF EXISTS notes_fts; DROP TABLE IF EXISTS note_scopes; DROP TABLE IF EXISTS notes;
        DROP TABLE IF EXISTS meta; PRAGMA user_version=${INDEX_VERSION};`)
    }).immediate()
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY, project TEXT NOT NULL, parent TEXT, title TEXT NOT NULL,
        created INTEGER NOT NULL, updated INTEGER NOT NULL, seq INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS chunks(
        id INTEGER PRIMARY KEY, session TEXT NOT NULL, message TEXT NOT NULL, seq INTEGER NOT NULL,
        kind TEXT NOT NULL, at INTEGER NOT NULL, part INTEGER NOT NULL, text TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS chunks_session ON chunks(session, seq);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='porter unicode61');
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text); END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text); END;
      CREATE TABLE IF NOT EXISTS blocks(session TEXT PRIMARY KEY, text TEXT NOT NULL, created INTEGER NOT NULL) STRICT;
    `)
  }

  /**
   * Brings the index up to date, a page of messages at a time, until `budgetMs`
   * has passed; at least one page always runs. `remaining` counts sessions that
   * still wait, including one left part-way.
   */
  sync(source: Database, options: { budgetMs?: number; page?: number } = {}): SyncReport {
    const started = performance.now()
    const budget = options.budgetMs ?? Number.POSITIVE_INFINITY
    const current = source.query<SourceSession, []>(SOURCE_SESSIONS).all().filter(row => !row.title.startsWith(EXCLUDED_TITLE))
    const known = new Map(this.db.query<{ id: string; title: string; seq: number }, []>("SELECT id, title, seq FROM sessions").all()
      .map(row => [row.id, row]))
    const removed = this.removeMissing(new Set(current.map(row => row.id)), [...known.keys()])
    const changed = current.filter(row => known.get(row.id)?.seq !== row.seq || known.get(row.id)?.title !== row.title)

    let chunks = 0
    let sessions = 0
    let pages = 0
    sessions: for (const session of changed) {
      let from = known.get(session.id)?.seq
      for (;;) {
        if (pages > 0 && performance.now() - started > budget) break sessions
        const page = this.syncPage(source, session, from, options.page ?? PAGE_MESSAGES)
        pages++
        chunks += page.chunks
        if (page.next === undefined) break
        from = page.next
      }
      sessions++
    }
    return { sessions, chunks, removed, remaining: changed.length - sessions }
  }

  private removeMissing(present: ReadonlySet<string>, known: readonly string[]): number {
    const gone = known.filter(id => !present.has(id))
    if (!gone.length) return 0

    this.db.transaction(() => {
      for (const id of gone) {
        this.db.query("DELETE FROM chunks WHERE session=?").run(id)
        this.db.query("DELETE FROM sessions WHERE id=?").run(id)
      }
    }).immediate()
    return gone.length
  }

  /**
   * Indexes up to `page` messages from the last indexed one on (inclusive, since
   * it may have completed since). Returns the seq to continue from, or undefined
   * when the session is fully indexed. A part-way session records the seq it
   * reached, so it stays "changed" and the next pass resumes there.
   */
  private syncPage(source: Database, session: SourceSession, indexedSeq: number | undefined, page: number): { chunks: number; next: number | undefined } {
    const from = Math.max(indexedSeq ?? 0, 0)
    // Two or more, so a page always ends past the message it starts on.
    const size = Math.max(2, page)
    const rows = source.query<SourceMessage, [string, number, number]>(SOURCE_MESSAGES).all(session.id, from, size + 1)
    const more = rows.length > size
    const messages = more ? rows.slice(0, size) : rows
    // Part-way, record the last message indexed: it is below the session's max
    // seq, so the session still reads as changed and resumes from there.
    const reached = more ? messages.at(-1)!.seq : session.seq
    let inserted = 0
    this.db.transaction(() => {
      this.db.query("DELETE FROM chunks WHERE session=? AND seq>=?").run(session.id, from)
      const insert = this.db.query("INSERT INTO chunks(session, message, seq, kind, at, part, text) VALUES (?,?,?,?,?,?,?)")
      for (const message of messages) {
        chunk(message.text ?? "").forEach((text, part) => {
          insert.run(session.id, message.id, message.seq, message.type, message.at, part, text)
          inserted++
        })
      }
      this.db.query(`INSERT INTO sessions VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project=excluded.project,
        parent=excluded.parent, title=excluded.title, updated=excluded.updated, seq=excluded.seq`)
        .run(session.id, session.project, session.parent, session.title, session.created, session.updated, reached)
    }).immediate()
    return { chunks: inserted, next: more ? reached : undefined }
  }

  /** The best chunk of each of the `limit` best-matching sessions, best first. */
  search(query: string, options: SearchOptions = {}): Hit[] {
    const expression = matchExpression(query)
    if (!expression) return []

    const limit = Math.min(Math.max(Math.floor(options.limit ?? 8), 1), 50)
    const project = options.project ?? null
    const session = options.session ?? null
    const rows = this.db.query<Hit, [string, string | null, string | null, string | null, string | null, string]>(`
      SELECT c.session, s.title, c.message, c.kind, c.at, snippet(chunks_fts, 0, '«', '»', '…', 40) AS snippet
      FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN sessions s ON s.id=c.session
      WHERE chunks_fts MATCH ? AND (? IS NULL OR s.project=?) AND (? IS NULL OR c.session=?) AND c.session<>?
      ORDER BY bm25(chunks_fts) LIMIT 400`).all(expression, project, project, session, session, options.exclude ?? "")

    // Within one session, several passages are the point; across sessions, one each.
    if (session !== null) return rows.slice(0, limit)
    const best = new Map<string, Hit>()
    for (const row of rows) if (!best.has(row.session)) best.set(row.session, row)
    return [...best.values()].slice(0, limit)
  }

  /** The block first built for `session`, so every request of that session carries identical text. */
  frozenBlock(session: string, build: () => string): string {
    const known = this.db.query<{ text: string }, [string]>("SELECT text FROM blocks WHERE session=?").get(session)
    if (known) return known.text

    const text = build()
    this.db.query("INSERT OR IGNORE INTO blocks VALUES (?,?,?)").run(session, text, Date.now())
    // A concurrent instance may have stored its block first; every request must see that one.
    return this.db.query<{ text: string }, [string]>("SELECT text FROM blocks WHERE session=?").get(session)?.text ?? text
  }

  close(): void {
    this.db.close()
  }
}
