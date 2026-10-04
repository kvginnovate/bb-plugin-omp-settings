// bb-plugin-omp-settings — headless server entry.
//
// Three surfaces share one set of helpers:
//   - the `bb omp-settings` CLI (defineCli / cliCommand),
//   - the `omp_settings` native agent tool,
//   - a host RPC client that drives the real `omp` binary on the
//     invoking machine (contract.ts / host.ts).
//
// The server never touches `node:fs` for omp state: every read and write is
// forwarded to the host entry through bb.hosts.experimental_client.
import {
  cliCommand,
  defineCli,
  PluginCliError,
  type BbPluginApi,
  type ExperimentalHostClient,
  type PluginAgentToolContext,
  type PluginAgentToolResult,
  type PluginCliOption,
  type PluginCliResult,
  type StandardSchemaV1InferInput,
  type StandardSchemaV1InferOutput,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, uiContract } from "./contract.js";

// ---------------------------------------------------------------------------
// Value + formatting helpers
// ---------------------------------------------------------------------------

// Value parsing. `true`/`false` become booleans and a bare decimal becomes a
// number. A token that starts a JSON array or object is parsed as such, so the
// 28 array and 15 record keys omp exposes are writable from here too instead
// of only from `omp config set` on the host. Anything else stays a string.
// omp's own CLI has the same ambiguity — it reads JSON text for a record key —
// so a string that genuinely starts with `[` or `{` needs the quoted form
// (`'"["'`).
function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return Number(raw);
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not valid JSON after all: keep it as the string it looks like.
    }
  }
  return raw;
}

function valueCell(value: unknown): string {
  if (value === null || value === undefined) return "(unset)";
  return JSON.stringify(value);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: unknown }).code;
    return typeof code === "string" && code !== err.name ? `${err.message} [${code}]` : err.message;
  }
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

// Options shared by every subcommand. `as const` keeps the `type`
// discriminants literal so cliCommand's generics infer precise value
// types per option (a Record<string, PluginCliOption> annotation would
// erase them).
const hostOptions = {
  machine: {
    type: "string",
    description: "Target host id. Omit to resolve from the thread's environment, else the system primary host.",
  },
  json: {
    type: "boolean",
    description: "Emit a `{ ok, payload }` JSON envelope on stdout instead of the human output.",
  },
} as const satisfies Record<string, PluginCliOption>;

// ---------------------------------------------------------------------------
// Output formatting — one function per command, shared by CLI and tool.
// The tool path always renders compact text (json: false, small limit).
// ---------------------------------------------------------------------------

type Entry = { key: string; type: string; description: string; value?: unknown };

function formatList(entries: Entry[], configPath: string, json: boolean, limit?: number): string {
  const shown = limit !== undefined ? entries.slice(0, limit) : entries;
  if (json) {
    return JSON.stringify({
      ok: true,
      payload: { configPath, total: entries.length, entries: shown, truncated: limit !== undefined && entries.length > limit },
    });
  }
  if (entries.length === 0) return "No omp settings found.";
  const keyW = Math.min(34, Math.max(...shown.map((e) => e.key.length)) + 2);
  const typeW = Math.min(14, Math.max(...shown.map((e) => e.type.length)) + 2);
  const valW = Math.min(30, Math.max(...shown.map((e) => valueCell(e.value).length)) + 2);
  const lines: string[] = [];
  lines.push(`${"key".padEnd(keyW)}${"type".padEnd(typeW)}${"value".padEnd(valW)}description`);
  for (const e of shown) {
    lines.push(
      `${truncate(e.key, keyW).padEnd(keyW)}${truncate(e.type, typeW).padEnd(typeW)}${truncate(valueCell(e.value), valW).padEnd(valW)}${truncate(e.description, 60)}`,
    );
  }
  if (limit !== undefined && entries.length > limit) {
    lines.push(`… ${entries.length - limit} more. Narrow with --filter or raise --limit.`);
  }
  lines.push(`\n${entries.length} setting(s). Config: ${configPath}`);
  return lines.join("\n");
}

function formatGet(key: string, value: unknown, json: boolean): string {
  if (json) return JSON.stringify({ ok: true, payload: { key, value } });
  return `${key} = ${valueCell(value)}`;
}

function formatSet(key: string, value: unknown, previous: unknown, json: boolean): string {
  if (json) return JSON.stringify({ ok: true, payload: { key, value, previous } });
  return `${key}: ${valueCell(previous)} → ${valueCell(value)}`;
}

function formatReset(key: string, value: unknown, json: boolean): string {
  if (json) return JSON.stringify({ ok: true, payload: { key, value } });
  return `${key} reset → ${valueCell(value)}`;
}

function formatInfo(version: string, configPath: string, json: boolean): string {
  if (json) return JSON.stringify({ ok: true, payload: { version, configPath } });
  return `omp ${version}\nconfig: ${configPath}`;
}

// ---------------------------------------------------------------------------
// Host-boundary actions. Input/output types are inferred per method from
// `hostContract` at each call site, so no per-method aliases exist here.
// ---------------------------------------------------------------------------
// The tool and the CLI both hand us a shape with an optional thread id and
// signal; the tool's context just has required fields, which is assignable.
type ResolvableCtx = { threadId?: string; signal?: AbortSignal };

type ToolArgs = {
  action: "list" | "get" | "set" | "reset" | "info";
  key?: string;
  value?: string;
  filter?: string;
  machine?: string;
};

class OmpActions {
  private constructor(
    private readonly sdk: BbPluginApi["sdk"],
    private readonly host: ExperimentalHostClient<typeof hostContract>,
  ) {}

  static create(bb: BbPluginApi): OmpActions {
    const host = bb.hosts.experimental_client({ contract: hostContract });
    return new OmpActions(bb.sdk, host);
  }

  private throwHostError(method: string, hostId: string, err: unknown): never {
    const reason = describeError(err);
    throw new PluginCliError(`omp host call '${method}' failed on ${hostId}: ${reason}`, {
      code: "host_call_failed",
      hint: "Check that the host daemon is online and the omp binary is installed. Add `--machine <hostId>` to pin the target.",
    });
  }

  /**
   * Host resolution, in order:
   *   1. explicit machine flag,
   *   2. thread → environment → host,
   *   3. system primary host.
   * A thread whose environment vanished falls through to (3); if that is
   * also absent we fail with a hint naming `--machine`.
   */
  async resolveHost(opts: { hostId?: string; ctx: ResolvableCtx }): Promise<string> {
    if (opts.hostId) return opts.hostId;
    const { threadId, signal } = opts.ctx;
    if (threadId) {
      try {
        const thread = await this.sdk.threads.get({ threadId, signal });
        const environmentId = thread.environmentId;
        if (environmentId) {
          const env = await this.sdk.environments.get({ environmentId, signal });
          if (env.hostId) return env.hostId;
        }
      } catch (err) {
        // Aborted: stop immediately; anything else means the thread or its
        // environment is gone — fall back to the primary host.
        if (signal?.aborted) throw err;
      }
    }
    const cfg = await this.sdk.system.config({ signal });
    if (cfg.primaryHostId) return cfg.primaryHostId;
    throw new PluginCliError(
      "No target host: no --machine flag, no thread environment host, and no system primary host.",
      { code: "host_resolution_failed", hint: "Add `--machine <hostId>` to target a host explicitly." },
    );
  }

  /**
   * One thin host call. `host.call` resolves with the validated output and
   * rejects on transport or host-side failure (the failure branch of the RPC
   * result); the catch converts that rejection into a `PluginCliError` so
   * both the CLI's `--json` envelope and the tool's error string stay well
   * formed. `M` keeps input/output inference precise per method.
   */
  async callHost<M extends keyof typeof hostContract & string>(
    method: M,
    input: StandardSchemaV1InferInput<(typeof hostContract)[M]["input"]>,
    hostId: string,
    signal?: AbortSignal,
  ): Promise<StandardSchemaV1InferOutput<(typeof hostContract)[M]["output"]>> {
    try {
      return await this.host.call(method, input, { hostId, signal });
    } catch (err) {
      this.throwHostError(method, hostId, err);
    }
  }

  /** Agent tool path: one compact line, no table, no JSON. */
  async run(action: ToolArgs["action"], args: ToolArgs, ctx: ResolvableCtx): Promise<string> {
    const hostId = await this.resolveHost({ hostId: args.machine, ctx });
    switch (action) {
      case "list": {
        const out = await this.callHost("list", { filter: args.filter }, hostId, ctx.signal);
        // Cap the transcript to a few rows; the host already applied the filter.
        return formatList(out.entries, out.configPath, false, 8);
      }
      case "get": {
        const out = await this.callHost("get", { key: args.key! }, hostId, ctx.signal);
        return formatGet(out.key, out.value, false);
      }
      case "set": {
        const out = await this.callHost("set", { key: args.key!, value: parseValue(args.value!) }, hostId, ctx.signal);
        return formatSet(out.key, out.value, out.previous, false);
      }
      case "reset": {
        const out = await this.callHost("reset", { key: args.key! }, hostId, ctx.signal);
        return formatReset(out.key, out.value, false);
      }
      case "info": {
        const out = await this.callHost("info", null, hostId, ctx.signal);
        return formatInfo(out.version, out.configPath, false);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export default function plugin(bb: BbPluginApi) {
  const actions = OmpActions.create(bb);

  // No bb.settings.define: the host entry hardcodes the `omp` binary, so an
  // ompCommand setting on this side would not be honored end-to-end.

  // -- CLI -------------------------------------------------------------------
  bb.cli.register(
    defineCli({
      name: "omp-settings",
      summary: "Read and write omp agent settings on the target host.",
      description:
        "Drives the local omp CLI on the target machine. Without --machine, the host is " +
        "resolved from the invoking thread's environment, falling back to the system " +
        "primary host. Values cross the host boundary as JSON: `true`/`false` parse to " +
        "booleans, a bare decimal parses to a number, and a token starting with " +
        "`[` or `{` is parsed as JSON so array and record keys are writable here. " +
        "Everything else stays a string — quote a value that genuinely starts with " +
        "`[` or `{`. `set` replaces the whole value; it does not merge.",
      commands: {
        list: cliCommand({
          summary: "List omp settings (key, type, value, description).",
          description:
            "Bounded table; use --filter to narrow by key or description substring and " +
            "--limit to cap rows. With --json, the entries array is capped the same " +
            "way and a `truncated` flag is added. Nested keys are single dotted " +
            "strings — a two-word token like `theme dark` is not a valid key.",
          options: {
            ...hostOptions,
            filter: {
              type: "string",
              description: "Case-insensitive substring matched against key and description.",
            },
            limit: {
              type: "integer",
              min: 1,
              max: 2000,
              default: 100,
              description: "Max rows in the human table. With --json, caps entries.length and sets `truncated`.",
            },
          },
          run: async (input, ctx): Promise<PluginCliResult> => {
            const hostId = await actions.resolveHost({ hostId: input.options.machine, ctx });
            const out = await actions.callHost("list", { filter: input.options.filter }, hostId, ctx.signal);
            const text = formatList(out.entries, out.configPath, input.options.json, input.options.limit);
            return { exitCode: 0, stdout: text };
          },
        }),
        get: cliCommand({
          summary: "Show the current value of one omp setting.",
          positionals: [{ name: "key", description: "Setting key (dotted path).", required: true }],
          options: hostOptions,
          run: async (input, ctx): Promise<PluginCliResult> => {
            const hostId = await actions.resolveHost({ hostId: input.options.machine, ctx });
            const out = await actions.callHost("get", { key: input.positionals.key }, hostId, ctx.signal);
            const text = formatGet(out.key, out.value, input.options.json);
            return { exitCode: 0, stdout: text };
          },
        }),
        set: cliCommand({
          summary: "Write one omp setting (whole-value write, not a merge).",
          description:
            "Parses the value before the call: `true`/`false` → boolean, a bare decimal " +
            "→ number, a token starting with `[` or `{` → JSON array or record, " +
            "anything else → string (quote a value that genuinely starts with `[` or " +
            "`{`). The host rejects unknown keys and invalid enum members; the error " +
            "is surfaced verbatim.",
          positionals: [
            { name: "key", description: "Setting key (dotted path).", required: true },
            { name: "value", description: "New value. Quote multi-word values.", required: true },
          ],
          unexpectedPositionalHint:
            "Both key and value are single tokens. Quote a multi-word value: " +
            "bb omp-settings set \"some.key\" \"dark theme\"",
          options: hostOptions,
          run: async (input, ctx): Promise<PluginCliResult> => {
            const hostId = await actions.resolveHost({ hostId: input.options.machine, ctx });
            const parsed = parseValue(input.positionals.value);
            const out = await actions.callHost("set", { key: input.positionals.key, value: parsed }, hostId, ctx.signal);
            const text = formatSet(out.key, out.value, out.previous, input.options.json);
            return { exitCode: 0, stdout: text };
          },
        }),
        reset: cliCommand({
          summary: "Reset one omp setting to its built-in default.",
          positionals: [{ name: "key", description: "Setting key (dotted path).", required: true }],
          options: hostOptions,
          run: async (input, ctx): Promise<PluginCliResult> => {
            const hostId = await actions.resolveHost({ hostId: input.options.machine, ctx });
            const out = await actions.callHost("reset", { key: input.positionals.key }, hostId, ctx.signal);
            const text = formatReset(out.key, out.value, input.options.json);
            return { exitCode: 0, stdout: text };
          },
        }),
        info: cliCommand({
          summary: "Show the omp version and config path on the target host.",
          options: hostOptions,
          run: async (input, ctx): Promise<PluginCliResult> => {
            const hostId = await actions.resolveHost({ hostId: input.options.machine, ctx });
            const out = await actions.callHost("info", null, hostId, ctx.signal);
            const text = formatInfo(out.version, out.configPath, input.options.json);
            return { exitCode: 0, stdout: text };
          },
        }),
      },
    }),
  );

  // -- Agent tool ------------------------------------------------------------
  const toolSchema = z
    .object({
      action: z.enum(["list", "get", "set", "reset", "info"]),
      key: z.string().optional(),
      value: z.string().optional(),
      filter: z.string().optional(),
      machine: z.string().optional(),
    })
    .refine(
      (a) =>
        (a.action !== "get" || (a.key ?? "").trim() !== "") &&
        (a.action !== "set" || ((a.key ?? "").trim() !== "" && (a.value ?? "") !== "")) &&
        (a.action !== "reset" || (a.key ?? "").trim() !== ""),
      {
        message: "get/set/reset require a non-empty key (set also requires value); list/info take no key.",
      },
    );

  bb.agents.registerTool({
    name: "omp_settings",
    description:
      "Read or write omp agent settings on a target host. Actions: list (optional " +
      "`filter`), get / reset (with `key`), set (with `key` + `value`), info. " +
      "`set` replaces the whole value — it does not merge into records or arrays. " +
      "Use `machine` to pin a target host.",
    parameters: toolSchema,
    presentation: {
      label: {
        pending: "Updating omp settings",
        completed: "omp settings call finished",
      },
    },
    instructions:
      "Prefer this tool over hand-editing ~/.omp/agent/config.yml: it drives the " +
      "omp CLI, so omp itself validates keys and enum members. Actions: " +
      "list (no key; optional filter), get (key), set (key + value), reset (key), " +
      "info (no key). `value` parses as boolean/number/string, and as JSON when it " +
      "starts with `[` or `{`. `set` writes the whole value — it replaces, never " +
      "merges, a record or array; to append to an array you must send the complete " +
      "new array. Nested paths are a single dotted string (`a.b.c`). A running omp " +
      "TUI does not hot-reload most of these; changes take effect for sessions " +
      "started after the write. If the host cannot be resolved, the error names the " +
      "machine flag to use.",
    async execute(args: ToolArgs, ctx: PluginAgentToolContext): Promise<PluginAgentToolResult> {
      try {
        return await actions.run(args.action, args, ctx);
      } catch (err) {
        if (err instanceof PluginCliError) {
          const text = err.hint ? `${err.message} (${err.hint})` : err.message;
          return { content: [{ type: "text", text }], isError: true };
        }
        return { content: [{ type: "text", text: `Unexpected error: ${describeError(err)}` }], isError: true };
      }
    },
  });

  // -- Frontend bridge --------------------------------------------------------
  // `useRpc` in app.tsx can only call methods registered here; it cannot reach
  // hostContract. These handlers reuse `actions`, so the UI resolves its target
  // host and writes settings by exactly the same path as the CLI and the tool.
  //
  // The UI has no thread to resolve from, so this lands on the system primary
  // host — the machine running the omp install the user is configuring.
  // No abort signal here: the rpc handler context does not carry one, and each
  // `omp` call is already bounded by the host entry's own 60s timeout.
  bb.rpc.register(uiContract, {
    async ui_list(input) {
      const hostId = await actions.resolveHost({ ctx: {} });
      return actions.callHost("list", { filter: input.filter }, hostId);
    },
    async ui_set(input) {
      const hostId = await actions.resolveHost({ ctx: {} });
      return actions.callHost("set", { key: input.key, value: input.value }, hostId);
    },
    async ui_reset(input) {
      const hostId = await actions.resolveHost({ ctx: {} });
      return actions.callHost("reset", { key: input.key }, hostId);
    },
    async ui_info() {
      const hostId = await actions.resolveHost({ ctx: {} });
      return actions.callHost("info", null, hostId);
    },
  }, {
    // Discoverable so `bb plugin rpc list`/`call` can exercise the same bridge
    // the page uses, instead of leaving it testable only through a browser.
    experimental_discoverable: true,
    experimental_description: "Read and write omp settings for the omp settings page.",
  });
}
