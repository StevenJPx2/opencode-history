# opencode-history

Searchable session history for OpenCode agents, read from OpenCode's own
database. No extra memory store, no model calls, no background services.

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

## Develop

```sh
bun install
bun run check                 # typecheck and tests
bun run history-sync          # build or refresh the index by hand, with progress
bun tools/live-check.ts       # end-to-end in an isolated OpenCode with a free model
```

[`PLAN.md`](PLAN.md) records work that is deliberately on hold.

## License

MIT. See [LICENSE](LICENSE).
