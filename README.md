# opencode-optmem

[OptMem](https://github.com/VictorTaelin/OptMem) permanent memory as native
OpenCode tools.

- `memo_note`, `memo_nap`, `memo_recall`, `memo_zoom`, `memo_forget` and
  `memo_scope` run `~/.optmem/memo` directly, so notes are passed exactly as
  written. The plugin renders project-scoped `memo_wake` views itself; use
  `scope: "all"` to request memo's unfiltered view.
- OptMem's instructions are added to every top-level session.
- Subagent sessions get neither the instructions nor the tools.
- Due memory blocks are compressed automatically with `ctx.generate.text`; they
  stay pending if the model is unavailable or cannot produce a short enough line.
- Without `~/.optmem/memo` installed, the plugin does nothing.

## Install

Install OptMem itself, then stage a fixed release:

```sh
curl -fsSL https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh
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
files and installs locked dependencies in a separate, content-addressed release.
It does not activate the release or change an existing one. Switch the configured
path only for an intentional deployment. Keep the embedding LaunchAgent pointed
at that release's `tools/embedding-server.py` too, with `uv run --frozen --script`.
Previous release directories remain available for rollback.

Options, through the object form of the plugin entry:

- `memo`: path to the tool, default `~/.optmem/memo`
- `memoryDir`: the store, default `$MEMORY_DIR` or `~/.optmem/memory`
- `compression`: set `false` to disable background compression, enabled by default
- `model`: primary model (`provider/id#variant`), default `openai/gpt-6-luna#xhigh`
- `fallbackModels`: fallback chain, tried in order; each entry may be `provider/id#variant` or a `{providerID, id}` reference. `fallbackModel` accepts one model the same way, and both may be set at once
- `fallbackModel: false`: no fallbacks at all; otherwise an unset option means the default `opencode/mimo-v2.6-flash-free`
- `backstopSeconds`: check for pending blocks from other sessions, default `300`
- `blocksPerPass`: maximum blocks in one pass, default `8`; full passes continue
- `attemptsPerBlock`: retry count for an overlong model response, default `3`
- `compressDelayMs`: debounce notes before starting a pass, default `2000`

OpenCode must have at least one configured model available. The plugin skips
unavailable models, tries the primary first, and falls back if generation fails
or cannot meet the byte limit. The worker sends due memory blocks from the
global store to these models for compression.

## Unified memory (opt-in)

Set `"mode": "unified"` in the plugin options to replace the `memo_*` tools with automatic memory:

- Full session exports are archived in `~/.local/share/optmem/archive.sqlite` (option `archivePath`).
- Each completed assistant reply, with its turn's user message, goes to the historian model. The `model` answers first, then each entry of the fallback chain in order; duplicates are dropped and any model OpenCode cannot run is skipped and logged. It extracts source-cited memories in the background, or none.
- Outgoing evidence keeps user/assistant text and each tool's name/status, but drops tool arguments, results, and error details. This also applies to already-queued passages and on-demand recall; complete originals and source IDs are preserved in the archive.
- Historian calls add nothing to any session's history. Each model in the chain is asked through one reusable session, shared by every project and deleted when the model leaves the chain. These sessions stay empty, but are currently visible: OpenCode 2.0.12's `session.update` ignores the attempted `time.archived` field. Automatic hiding is not yet supported by this implementation.
- A model that fails cools down (shared by every open project), honouring a provider's retry-after, so a model in the chain that is down is skipped for the rest of its cooldown and the next one answers. A job whose model output stays unusable is marked `failed` after five attempts; outages and reloads do not use up attempts.
- Secrets are masked locally before any archived text or stored memory reaches a model.
- Each model request gets a bounded block of project and global memories. The `memory` tool asks the historian when that is not enough.

Existing OptMem notes, scopes, summaries and config are imported on startup. The import checks every byte, can be re-run safely, and never writes to the original store.

Semantic search is optional. To use it, run the local EmbeddingGemma 2 service and set `embeddingURL`:

```sh
uv run --script tools/embedding-server.py   # http://127.0.0.1:18791
```

## Checking it is working

Unified mode records what the background pipeline did, so you do not have to
query the archive by hand:

```sh
bun run status                    # worker, captures, queue, failures, cooldowns
bun run audit                     # the recent operation feed
bun run audit --follow extract    # stream one kind of event
```

- `status` reports whether a worker is beating (and which deployed release it is), how many conversations are queued to export, queued/running/done/failed jobs, grouped failure reasons, and model cooldowns with the provider's error tag for each.
- Each operation records an id, an outcome, a count, a duration and a fixed reason. Prompts, passages and tool output are never recorded.
- The agent can ask the same questions from inside a session with the `memory_status` tool.
- The feed keeps the last 5000 records and is followable with an exclusive id cursor, so nothing repeats.

Both commands are read-only. They read `OPTMEM_ARCHIVE` when set, otherwise the
live `archivePath`.

## Develop

```sh
bun install
bun run check   # typecheck and tests
```

[`PLAN.md`](PLAN.md) describes project-scoped wake.
