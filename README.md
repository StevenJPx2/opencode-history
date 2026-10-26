# opencode-history

Searchable session history for OpenCode agents, read from OpenCode's own
database. No extra memory store and no background services; the only model
call is the optional recall judge.

- `history_search` finds earlier sessions by keyword (SQLite FTS5, BM25) and
  quotes the matching passages: what you typed, what the agent replied, and
  compaction summaries. Tool calls, tool output and reasoning are never searched.
  It searches the current project by default; `scope: "all"` searches every
  project, and `session` searches inside one session. Each result names its
  message, and `open` with that `msg_…` ID returns the whole message, read fresh
  from OpenCode.
- Each top-level session gets a short `<recent_work>` block: the project's five
  latest sessions, each with its date, title, ID, and either the `## Objective`
  of its latest compaction summary or its first user message. Everything in it
  is quoted, nothing generated. It is built at the session's first request and
  then frozen, so every request of that session carries identical text and the
  provider's prompt cache stays valid. Subagents get no block.
- Per-turn recall: before your message is admitted, the plugin finds up to 8
  candidate passages from earlier sessions in the project and asks a hosted
  judge whether each would help. Up to 3 it accepts arrive as a
  `<history_recall>` synthetic message just before yours. See Recall below.

## How it works

OpenCode's database (`~/.local/share/opencode/opencode.db`) is opened
read-only. It has no full-text index, so the plugin keeps a sidecar index at
`~/.local/share/opencode-history/index.sqlite`. Everything in it is derived and
can be deleted at any time; the plugin rebuilds it.

- The first build indexes all history in the background, a page of messages at
  a time, so it never holds OpenCode's event loop for long (about 30 s of work
  for 1,800 sessions). Searches meanwhile say how many sessions are not yet indexed.
- Afterwards each search first brings the index up to date, which normally takes
  about 20 ms.
- Change detection uses each session's highest message `seq`, because OpenCode
  does not always update a session's `time_updated` when its messages change.
- At startup the plugin checks that OpenCode's tables have the columns it reads,
  and refuses to load otherwise. All knowledge of OpenCode's tables is in
  `src/history.ts`.

## Install

Stage a fixed release, then point OpenCode at it:

```sh
bun run stage-release
```

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": ["/absolute/path/printed/by/stage-release"]
}
```

Do not load a working checkout in your daily OpenCode configuration: editing it
can hot-reload the plugin during active tasks. `stage-release` copies runtime
files and installs locked dependencies into a separate, content-addressed
release under `~/.local/share/opencode-history/releases`, and never changes an
existing one.

Options, through the object form of the plugin entry:

- `database`: OpenCode's database, default `$XDG_DATA_HOME/opencode/opencode.db`
- `index`: the sidecar index, default `$XDG_DATA_HOME/opencode-history/index.sqlite`
- `audit`: a JSONL path, default `audit.jsonl` beside the index; `false` disables it
- `recall`: `false` turns per-turn recall off

## Recall

Recall runs only when `TYPESAFE_API_KEY` is in OpenCode's environment; it calls
TypeSafe's Jev at `/v1/systemone`. `TYPESAFE_BASE_URL` and
`TYPESAFE_DEFAULT_MODEL` override the endpoint and model.

- **What is sent:** your message, the last 600 characters of the agent's
  previous reply, and up to 8 passages of 800 characters from earlier sessions
  in the same project. Nothing is redacted.
- **What is attached:** passages the judge rates at p ≥ 0.7, at most 3, as one
  synthetic message saved in the session's history. The agent can `open` each
  passage's `msg_…` ID with `history_search`.
- **Cost:** your message waits for the search and the judge, about 0.3 s.
  The judge gets 2.5 s; a timeout, error or malformed answer attaches nothing,
  and your message is always admitted.
- **Skipped:** subagent sessions, blank messages, and messages starting with
  `<`, `[` or `/` (injected reminders, monitor events, commands).

## Tool availability and audit

If Chauffeur manages your tools, keep `history_search` in `base` in its
`tool-exposure.json`. A local `base` list replaces the shipped list, so it must
include the tool too. This prevents prompt-based tool hiding; it does not
override OpenCode's own agent permissions.

Each executed `history_search` call writes one small audit row: timestamp,
calling session ID, search/open mode, requested scope and whether a session
filter was used, duration, result count and indexing backlog, or an error
category (`invalid_input`, `message_not_found`, `execution_failed`). Queries,
target IDs, passages and raw error messages are never logged. Calls rejected
by OpenCode before plugin execution are not visible to this audit.

Each recall the judge is asked about, or that finds no candidates, writes a
`history_recall` row: session ID, duration, candidate count and attached count,
or an error category (`judge_failed`, `judge_timeout`, `execution_failed`).
Messages and passages are never logged.

The log rotates at 1 MiB to `audit.jsonl.1`, keeping only that previous file.
Files are owner-readable/writable; audit failures never fail a tool call.
The default path is `~/.local/share/opencode-history/audit.jsonl`.

## Develop

```sh
bun install
bun run check                 # typecheck and tests
bun run history-sync          # build or refresh the index by hand, with progress
bun tools/live-check.ts       # end-to-end in an isolated OpenCode with a free model
```

[`PLAN.md`](PLAN.md) records the recall design and its evidence, and work on hold.

## License

MIT. See [LICENSE](LICENSE).
