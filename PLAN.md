# Project-scoped wake

One global OptMem store. `memo_wake` shows universal memories and the current
project's memories; every other memory stays reachable through `memo_recall`
and `memo_zoom`.

## Constraints from OptMem

- `~/.optmem/memo` is upstream's file and its installer overwrites it, so the
  plugin implements scoping and leaves `memo` unchanged.
- `LOG.txt` holds fixed-width 320-byte records, `#<id> <date> <text>`; memory
  `i` lives at offset `i * 320` and is never edited.
- `TREE/<size>` holds 288-byte summaries of aligned, contiguous ranges
  `[k·size, (k+1)·size)`. A summary spans whatever memories are adjacent, so
  scope cannot be read back out of a summary's text.

## Scope

Every memory has zero or more scope keys. A key names a project across all of
its worktrees, so a memory recorded in a worktree is visible from the
repository's canonical checkout and the other way round.

| Key | Holds | Wake |
|---|---|---|
| `global` | Preferences meant for every session | Always |
| A project key, such as `shop` or `orchestrator` | That project's decisions, findings and open work | When the session works in that project |
| None | Memories nobody has classified | Never |

A key is the canonical directory's basename; a colliding basename gets a
numeric suffix, and `scopes.json` maps keys to directories so they stay stable
between sessions. A memory can carry several keys when it belongs to several
projects. Relevance is one rule: **a memory is in scope when one of its keys is
`global` or one of the session's keys.** A global memory is in every session's
wake and competes for the same line budget as the project's own, so the budget
alone decides how much of each is shown.

## Storage

`SCOPE.txt` sits beside `LOG.txt`: fixed-width 128-byte records, record `i` for
memory `i`, holding a comma-separated key list padded with spaces.

- Writes are positional, so parallel sessions writing different memories never
  collide and need no lock. A crash can only leave a partial trailing record,
  which the next write trims.
- The plugin owns this file and may rewrite a record; `LOG.txt` and `TREE/`
  stay untouched.
- Reads past the end, and gaps left by concurrent appends, read as no scope.

## Tools

```ts
memo_note({ text: "Shop: Workers only, no Node target" })            // scope = this project
memo_note({ text: "Prefers bullets over run-on lists", scope: "global" })
memo_note({ text: "Gate events through orchestrator.gate", scope: "orchestrator,feeds" })
memo_scope({ id: 142, scope: "Studio" })                          // reclassify one memory
memo_wake({})                                                         // this project plus global
memo_wake({ scope: "all" })                                           // memo's own global view
```

`memo_note` reads the new id from memo's `Saved as #<id>.` line and writes the
scope record. An unknown key is refused, naming the keys the registry knows, so
a typo cannot silently leave a memory invisible. `memo_recall`, `memo_zoom`,
`memo_nap` and `memo_forget` work on the whole store.

## Scoped wake

The plugin renders the view from `LOG.txt`, `TREE/` and `SCOPE.txt`:

1. Tile `[0, T)` with aligned blocks whose detail decays with age, as memo's
   `cover` does.
2. A block whose memories are all in scope stands for the view, as its
   summary, or as the raw memory when it is a single one.
3. A mixed-scope block splits into its halves, and an out-of-scope single drops
   out. A block whose summary is not built splits too.
4. The decay factor is searched until the view fits `WAKE_LINES`, and leftover
   budget goes to the newest block. A view that still overshoots keeps the
   present.

Output keeps memo's shape, so the injected instructions and the Orchestrator rules
that watch for its footers keep working: `Not awake yet. Call memo_wake with
part N and snapshot T.`, `You are awake.`, and the paging header naming the
scope.

The pending-compression queue is handled by the background worker. Scoped wake
omits its prompts because they can quote another project's memories.

At startup the plugin checks the store's shape: `LOG.txt` whole records, a
parseable first record, whole `TREE/` records. Scoped wake reports an error when
the layout is unreadable. `scope: "all"` explicitly requests unfiltered wake.

## Deployment

OpenCode loads the plugin from this repository through an absolute path in
`~/.config/opencode/opencode.jsonc`, deployed from the dotfiles repository. A
local plugin directory is loaded from its `index.ts`.

## Testing

- Unit tests over a seeded store in OptMem's layout: interleaved projects,
  strict scope isolation, unbuilt summaries, unscoped memories, empty stores,
  and scope record round-trips.
- Contract tests against the real `memo` in a temporary `MEMORY_DIR`: each scope
  form, wake from two projects, `scope: "all"`, `memo_scope`, an unknown scope,
  and cross-project `memo_recall`.
- One test asserts all seven tools register as direct tools rather than behind
  Code Mode, so scoping cannot hide them.

## Open questions

- **Other-project hint.** Whether wake ends with a count such as "34 memories
  from other projects", or stays silent.
