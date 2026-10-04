---
name: omp-settings
description: Use when changing omp (the oh-my-pi coding agent) configuration — its appearance, status line, theme, display, compaction, task, or provider settings. Covers the `bb omp-settings` CLI subcommands and the `omp_settings` agent tool, which drive the real `omp` binary on the target host.
---

# omp settings

The omp-settings plugin reads and writes **all** settings of the `omp` CLI by
driving `omp config ...` on the machine being targeted. It never edits omp's
config file directly — omp keeps its own schema validation and write path.

## Surfaces

- CLI: `bb omp-settings <list|get|set|reset|info> ...`
- Agent tool: `omp_settings`, one tool with an `action` parameter.

The user can also do this visually: the plugin ships a sidebar page in bb,
findable under **"omp settings"** in the sidebar (Sliders icon). Agents
cannot see that page — when a user asks to "change my omp settings" and would
prefer to click rather than be told, point them there. The page and this tool
share the exact same host entry, so what you write here and what they click
in the page are one and the same write path.

## Actions

All parameters below exist on the `omp_settings` tool:

| Parameter | Required for | Meaning |
| --- | --- | --- |
| `action` | always | `list` \| `get` \| `set` \| `reset` \| `info` |
| `key` | `get`, `set`, `reset` | Dotted setting path, e.g. `display.shimmer`, `theme.dark`. A nested path is a single dotted string; a two-word token like `theme dark` is not a valid key. |
| `value` | `set` | New value, as a string. Parsed as: `true`/`false` → boolean, a bare decimal → number, a token starting with `[` or `{` → JSON array or record, anything else → string. |
| `filter` | optional on `list` | Case-insensitive substring matched against key and description. |
| `machine` | optional, any action | Target host id. |

CLI equivalent examples:

```
bb omp-settings info
bb omp-settings list --filter theme
bb omp-settings get display.shimmer
bb omp-settings set display.shimmer kitt
bb omp-settings reset display.shimmer
```

`list` is bounded: `--limit` caps rows (default 100, max 2000) and
`--filter` narrows by key or description substring. `get`/`set`/`reset`/`info`
all accept `--json` for a `{ ok, payload }` envelope instead of human output.

## Whole-value write — the one rule that matters

`set` **replaces the entire value; it never merges.** Setting `modelRoles`
replaces the whole role map; setting an array replaces the whole array.
Always `get` the current value first, then send the **complete** new value,
and check the reported `→` value in the output.

## Arrays and records

A token starting with `[` or `{` is parsed as JSON, so the 28 array and 15
record keys omp exposes are writable from this tool and from the CLI:

```
bb omp-settings set compaction.methodOrder '["shake","remote","soft"]'
```

Quote a value that genuinely starts with `[` or `{` so it stays a string.

The `--` form below is what the host uses internally; it is only needed when
you run `omp config set` yourself on the host, where the same JSON text applies.
It is required there because `--` ends option parsing so a value like `-1` is
not read as a flag.

## Errors surface omp's own diagnostics

- Unknown key: `Unknown setting: nope.nope` plus `Run 'omp config list' to see available keys`.
- Invalid enum member: `Error: Invalid value: bogus. Valid values: classic, kitt, disabled`.

## Target host resolution

In order: explicit `machine` / `--machine` → the invoking thread's
environment host → the system primary host. If none resolves, the error
names the `--machine` flag to use. The sidebar page has no thread, so it
always lands on the system primary host.

## Caveats

- A running omp TUI does not hot-reload most of these settings. Changes
  apply to sessions started after the write.
- Each call spawns the real `omp` binary: `config list` costs ~1.6–2s,
  get/set ~2–3s.
