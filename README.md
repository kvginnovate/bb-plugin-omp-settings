# bb-plugin-omp-settings

BB plugin that reads and writes **all** settings of the `omp` CLI (the
oh-my-pi coding agent) on a target host. Three surfaces, one pipeline — every
surface drives the real `omp` binary on the targeted machine; the plugin never
edits `~/.omp/agent/config.yml` itself:

| Surface | Where you find it | What it does |
| --- | --- | --- |
| **Sidebar page** | The bb sidebar entry titled **"omp settings"** (Sliders icon) | Every setting on one page, with the right control per type, search, and filters |
| **CLI** | `bb omp-settings <list\|get\|set\|reset\|info>` | The same five operations from a terminal or an agent thread |
| **Agent tool** | `omp_settings` | The same five operations inside an agent thread |

Quick taste:

```
bb omp-settings list --filter theme
bb omp-settings set display.shimmer kitt
```

## Architecture — three layers

- **`app.tsx`** — the frontend entry (declared in `package.json` under `bb` as
  `"app": "./app.tsx"`). It registers one nav panel slot —
  `app.slots.navPanel({ id: "settings", title: "omp settings", icon: "Sliders",
  path: "settings", … })` — and the whole page does all of its work through
  four RPC calls: `ui_list`, `ui_set`, `ui_reset`, `ui_info` (the `uiContract`
  in `contract.ts`).
- **`server.ts`** — the BB server entry. Owns the `bb omp-settings` CLI and the
  `omp_settings` agent tool, and registers the `bb.rpc` bridge:
  `bb.rpc.register(uiContract, …)` with `experimental_discoverable: true` (so
  the bridge is also exercisable via `bb plugin rpc list`/`call`). Each `ui_*`
  handler reuses the exact same host actions the CLI and tool use.
- **`host.ts`** — the BB host entry, running on the target machine. Spawns the
  real `omp` binary (`shell: false`, argv array, 60 s timeout, abort-aware) and
  serializes every call through one promise queue so a read-modify-write can
  never interleave with another call. It writes with `omp config set <key> --
  <value>` — the plugin never edits `config.yml` itself. That is deliberate:
  omp owns its schema validation and its own file locking.

**Why the indirection?** Two reasons, and this is the part a reader is most
likely to find surprising:

1. The sidebar bundle runs inside the BB process, while `omp` and its config
   are host-local — the server process cannot read `~/.omp/agent/config.yml`
   on the machine being targeted.
2. `useRpc` in a plugin frontend can only reach methods the plugin itself
   registered on `bb.rpc`; a host entry is not one of them, so the page can
   never call `hostContract` directly. `uiContract` is the bridge: four
   methods that resolve the target host exactly the way the CLI does and
   forward to the host entry. The page and the CLI therefore cannot drift
   apart in host selection or write semantics.

Two implementation notes worth knowing:

- **Enum members.** `omp config list --json` reports `type: "enum"` but not
  the allowed members; only the plain-text listing prints them
  (`display.shimmer = classic (classic|kitt|disabled)`). So the host's `list`
  handler runs both invocations and parses the members out of the text
  output. About 90 enum keys carry the result as an optional `options: string[]`
  on each entry, which is what the page's dropdowns render.
- **`app.css` is deliberately tiny** — just the `.omp-settings-scroll` scroll
  container. The semantic color tokens (`--background`, `--foreground`,
  `--muted`, `--border`, `--primary`, `--destructive`) are provided by the bb
  host and consumed exactly the way other installed plugin frontends do;
  redefining them locally would replace the user's real theme with an
  approximation.

## The sidebar page

Open bb and find the sidebar entry **"omp settings"** in the plugin's nav
panel (Sliders icon). That one page lists every omp setting on the target
host, with one control per omp type:

| omp type | Control |
| --- | --- |
| `boolean` | a toggle, committed on change |
| `enum` | a dropdown of the parsed `options` (~90 keys have them); a free-text input when no members are available |
| `number` | a number field; an empty or non-numeric draft never commits |
| `string` | a text input, committed on blur/Enter |
| `array` / `record` | a JSON editor that shows the current value as pretty JSON; Save is enabled only once the draft parses |

Arrays and records get a JSON editor for one reason: `set` is a **whole-value
write** — it replaces the value, it never merges — so the editor starts from
the current value, and a malformed document can never reach the server.

**Search.** The search box filters key and description (case-insensitive
substring, server-side). It is debounced ~250 ms — not one request per
keystroke, because each `ui_list` runs `omp config list` **twice** on the host
(JSON + text) and costs roughly 4 s.

**Filters.** All / Modified / Boolean / Enum / String / Number / Array /
Record. "Modified" is a meaningful state here: an entry with no `value` has
never been explicitly set, so the filter shows exactly the settings someone
actually touched.

**Grouping.** `ui_list` returns flat dotted keys; the page groups them into
collapsible sections by the leading dotted segment — `statusLine.transparent`
falls under `statusLine`, keys without a dot under `general`. No invented
categories.

**Writes.** Each commit calls `ui_set`, and the row reports the value **from
the response** — the host re-reads the config after the write and returns what
actually landed — showing the `previous` → new transition in a toast.
Failures surface as an inline row error plus a toast; never a silent revert.

**Reset.** Each row has "Reset to default", which calls `ui_reset` and
restores the **omp factory default** for the key — not "the value before my
last change". There is deliberately no reset-all.

**Header.** The page header shows `omp <version>` (from `ui_info`), the total
settings count with the modified count, and a refresh button. It deliberately
does not repeat the panel title — the host renders that.

**Load and error states.** First load fetches ~530 settings in ~4 s and shows
a real loading state; a failed load shows the error with a Retry button.
Refreshes (including the one after every write) keep the current search text
and type filter — they never snap the view back.

**Credential-ish keys.** Keys matching omp's own naming (`auth.*`, keys
containing `token`, `secret`, `credential`) get a badge rather than a hidden
value: omp already redacts them in its output, and the badge warns that the
value is shown only in the control and never reaches a log.

## Install

From this directory:

```
bb plugin install .
```

Dev loop — rebuilds and reloads on every save:

```
bb plugin dev
```

Release build (required for npm/git installs):

```
bb plugin build
```

## CLI reference

All subcommands accept two shared options:

| Option | Meaning |
| --- | --- |
| `--machine <hostId>` | Target host. Omit to resolve from the invoking thread's environment, else the system primary host. |
| `--json` | Emit a `{ ok, payload }` JSON envelope instead of the human output. |

| Command | Positionals / options |
| --- | --- |
| `list` | `--filter <substr>`, `--limit <n>` (default 100, max 2000) |
| `get` | `key` |
| `set` | `key`, `value` |
| `reset` | `key` |
| `info` | none |

One real example each (values observed live on a Windows host):

```
bb omp-settings info
omp 18.6.0
config: ~/.omp/agent
```

```
bb omp-settings list --filter theme
key        type  value       description
…
3 setting(s). Config: ~/.omp/agent
```

```
bb omp-settings get display.shimmer
display.shimmer = "classic"
```

```
bb omp-settings set display.shimmer kitt
display.shimmer: "classic" → "kitt"
```

```
bb omp-settings reset display.shimmer
display.shimmer reset → "classic"
```

```
bb omp-settings get theme.dark --json
{"ok":true,"payload":{"key":"theme.dark","value":"titanium"}}
```

### `list` is bounded

A typical install exposes ~530 keys (types: boolean, number, enum, string,
array, record). `--limit` (default 100) caps the table and `--filter` narrows
by case-insensitive substring over key and description, because an unbounded
listing would blow the CLI's 1 MiB output ceiling. Truncated output ends with
`… N more. Narrow with --filter or raise --limit.`

The sidebar page does **not** need that bound: it prints nothing — it
grouped-renders all ~530 entries as collapsible sections and streams the
search filter through to `ui_list`, so the page is the surface to use when
you want the full picture.

### `set` value parsing — arrays and records

The `set` value is parsed as: `true`/`false` → boolean, a bare decimal →
number, a token starting with `[` or `{` → JSON array or record, anything
else → string. Quote a value that genuinely starts with `[` or `{` so it stays
a string.

```
bb omp-settings set compaction.methodOrder '["shake","remote","soft"]'
```

Running `omp config set <key> -- '<json>'` yourself on the target host takes
the same JSON text. The `--` is required there: it ends option parsing so a
value like `-1` is not read as a flag.

## Agent tool

`omp_settings` — one tool, five actions via the `action` parameter:

| Parameter | Required for |
| --- | --- |
| `action` | always: `list` \| `get` \| `set` \| `reset` \| `info` |
| `key` | `get`, `set`, `reset` (dotted path, one string) |
| `value` | `set` |
| `filter` | optional on `list` |
| `machine` | optional, any action |

A bundled skill (`skills/omp-settings/SKILL.md`) is imported into agent
threads automatically and tells agents how to reach for this tool. Agents
cannot see the sidebar page — the skill tells them to point the human at it
when the user would prefer to do this visually.

## Constraints to know

**Whole-value write.** `set` replaces the entire value; it never merges.
Setting `modelRoles` replaces the whole role map; setting an array
replaces the whole array. Send the complete new value, and check the
reported `→` in the output — the host re-reads the config after the write
and returns the observed value. This is also why arrays and records get a
JSON editor in the page instead of a text box.

**`omp` must be installed and on `PATH` on the target machine.** If it is
missing, every call fails with omp's spawn error.

**Host resolution order.** Explicit `--machine` / tool `machine` arg →
the invoking thread's environment host → the system primary host. If none
resolves, the error tells you to add `--machine <hostId>`. The **page has no
thread**, so it always lands on the system primary host — the machine running
the omp install the user is configuring.

**No hot reload.** A running omp TUI does not hot-reload most of these
settings. Changes apply to sessions started after the write.

**Real spawn cost.** Each call shells out to `omp`: `config list` costs
~1.6–2 s, get/set ~2–3 s. That is why one `config list` snapshot doubles as
the "does the key exist" and "previous value" answer for `set` — and why
`ui_list` (two `config list` invocations: JSON + text) takes ~4 s.

## Troubleshooting

- `Unknown setting: nope.nope` / `Run 'omp config list' to see available keys` —
  omp's own stderr, surfaced verbatim. Double-check the dotted key.
- `Error: Invalid value: bogus. Valid values: classic, kitt, disabled` —
  an enum key got a member that omp rejects; pick one from the list.
- `omp host call '…' failed on <hostId>` with a spawn error — the `omp`
  binary is missing from the target host's `PATH`, or the host daemon is
  down. Pin the target with `--machine <hostId>`.
- `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` printed on some
  commands (seen on this Windows host) is **pre-existing BB CLI shutdown
  noise**, reproducible with any built-in plugin command (e.g.
  `bb tasks --help`) and unrelated to this plugin. Do not debug it as
  plugin breakage.
