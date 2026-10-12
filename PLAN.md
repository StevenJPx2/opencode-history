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

Every memory has a scope:

| Scope | Holds | Wake |
|---|---|---|
| `global` | Preferences meant for every session | Always |
| Project keys, e.g. `shop` or `orchestrator,feeds` | That project's decisions, findings and open work | When the session is in one of the projects |
| Unclassified | Memories without a record | Never |

A project key is the basename of the project's canonical directory
(`ctx.location.project.canonical`), so every worktree of a repository shares
it. `scopes.json` in the memory directory maps each key to its canonical path,
and a colliding basename gets a numeric suffix. A session outside any project
wakes with `global` only.

## Storage

`SCOPE.txt` sits beside `LOG.txt`: fixed-width 128-byte records, record `i`
for memory `i`, holding a comma-separated key list padded with spaces.

- Writes are positional (`pwrite` at `i * 128`), so parallel sessions writing
  different memories never collide and need no lock.
- Writing past the end leaves zero-filled gaps, which read as unclassified.
- The plugin owns this file and may rewrite a record; `LOG.txt` and `TREE/`
  stay untouched.

## Tools

```ts
memo_note({ text: "Shop: Workers only, no Node target" })            // scope = current project
memo_note({ text: "Prefers bullets over run-on lists", scope: "global" })
memo_note({ text: "Gate events through orchestrator.gate", scope: "orchestrator,feeds" })
memo_scope({ id: 142, scope: "studio" })                          // reclassify one memory
memo_wake({})                                                         // scoped view
memo_wake({ scope: "all" })                                           // memo's own global view
```

`memo_note` reads the new id from memo's `Saved as #<id>.` line and writes the
record. `memo_recall`, `memo_zoom`, `memo_nap` and `memo_forget` keep working on
the whole store.

## Scoped wake

The plugin renders the view itself from `LOG.txt`, `TREE/` and `SCOPE.txt`:

1. Cover `[0, T)` with aligned blocks, detail decaying with age, as memo's
   `cover` does.
2. A block whose memories are at least 60% in scope is emitted: its summary,
   or the raw memory for a single.
3. A block under 60% splits into its halves; out-of-scope singles drop out.
4. A block whose summary is not built yet splits too, so wake never refuses.
5. The decay factor is binary-searched until the emitted lines fit
   `WAKE_LINES`; `global` memories take at most 16 of those lines, oldest
   coarsened first.

Output keeps memo's footers (`Not awake yet. Run: …`, `You are awake.`) and
paging, so the injected instructions and the Orchestrator rules still apply.

At startup the plugin checks the store's shape (record sizes, a parseable first
record). On a mismatch it falls back to memo's own `wake` and says so.

## Deployment

OpenCode loads the plugin from this repository through an absolute path in
`~/.config/opencode/opencode.jsonc`, deployed from the dotfiles repository.

## Testing

- Unit tests over a synthetic `LOG.txt`, `TREE/` and `SCOPE.txt`: interleaved
  projects, the 60% rule, unbuilt summaries, the `global` cap, paging.
- A contract test against the real `memo` in a temporary `MEMORY_DIR`: note
  with each scope form, nap, then wake from two projects.

## Open questions

- **Existing memories.** All 207 are unclassified. Recommended: one
  classification pass, where the agent proposes a scope per memory for review
  and writes the approved records. Otherwise nothing from before the change
  appears at wake until reclassified.
- **Other-project hint.** Whether wake ends with a count such as "34 memories
  from other projects", or stays silent.
