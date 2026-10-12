# opencode-optmem

[OptMem](https://github.com/VictorTaelin/OptMem) permanent memory as native
OpenCode tools.

- `memo_wake`, `memo_note`, `memo_nap`, `memo_recall`, `memo_zoom` and
  `memo_forget` run `~/.optmem/memo` directly, so notes are passed exactly as
  written.
- OptMem's instructions are added to every top-level session.
- Subagent sessions get neither the instructions nor the tools.
- Without `~/.optmem/memo` installed, the plugin does nothing.

## Install

Install OptMem itself, then point OpenCode at this repository:

```sh
curl -fsSL https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh
```

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": ["/path/to/opencode-optmem"]
}
```

Options, through the object form of the plugin entry:

- `memo`: path to the tool, default `~/.optmem/memo`
- `memoryDir`: the store, default `$MEMORY_DIR` or `~/.optmem/memory`

## Develop

```sh
bun install
bun run check   # typecheck and tests
```

[`PLAN.md`](PLAN.md) describes project-scoped wake.
