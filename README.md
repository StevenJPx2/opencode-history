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
- `fallbackModel`: fallback model, default `opencode/mimo-v2.6-flash-free`; set `false` to disable
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
- Each completed assistant reply, with its turn's user message, goes to the historian model (`model`, then `fallbackModel`). It extracts source-cited memories in the background, or none.
- Historian calls are stateless: they create no OpenCode sessions and add nothing to any session's history.
- A model that fails cools down (shared by every open project), honouring a provider's retry-after. A job whose model output stays unusable is marked `failed` after five attempts; outages and reloads do not use up attempts.
- Secrets are masked locally before any archived text or stored memory reaches a model.
- Each model request gets a bounded block of project and global memories. The `memory` tool asks the historian when that is not enough.

Existing OptMem notes, scopes, summaries and config are imported on startup. The import checks every byte, can be re-run safely, and never writes to the original store.

Semantic search is optional. To use it, run the local EmbeddingGemma 2 service and set `embeddingURL`:

```sh
uv run --script tools/embedding-server.py   # http://127.0.0.1:18791
```

## Develop

```sh
bun install
bun run check   # typecheck and tests
```

[`PLAN.md`](PLAN.md) describes project-scoped wake.
