// bb-plugin-omp-settings — host entry.
//
// The host side owns the real `omp` binary: every method shells out to
// `omp config ...` on the machine that invoked the call. Nothing here reads or
// writes omp's config file directly, so omp keeps its own schema validation
// and its own file locking.
import { spawn } from "node:child_process";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk/host";
import { hostContract, settingValueSchema } from "./contract.js";

/** The `omp` executable, resolved from PATH (on Windows that is `omp.exe`). */
const OMP_BINARY = "omp";

/**
 * One `omp` invocation costs a process spawn, and `config list --json` is the
 * slowest at roughly two seconds. Cap every call so a wedged child cannot pin
 * the worker forever.
 */
const CALL_TIMEOUT_MS = 60_000;

/**
 * One entry of `omp config list --json`. `value` is absent when the setting has
 * no effective value; `redacted` marks credential-bearing keys whose value the
 * listing hides.
 */
type OmpSettingEntry = {
  value?: unknown;
  type: string;
  description: string;
  redacted?: boolean;
};

type OmpSnapshot = Record<string, OmpSettingEntry>;

/**
 * Run one `omp` invocation and resolve with its stdout.
 *
 * `args` is always an array and `shell` stays false: on Windows a concatenated
 * command line would re-split values on spaces and quotes. `label` names the
 * operation for error messages without echoing the value being written.
 */
function runOmp(args: readonly string[], signal: AbortSignal, label: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    // `signal` makes Node kill the child on cancellation too; the listener
    // below settles first so the caller sees a clear "cancelled" error.
    const child = spawn(OMP_BINARY, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (error: Error | null, output: string): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(output);
    };
    const onAbort = (): void => {
      child.kill();
      settle(new Error(`omp ${label} was cancelled`), "");
    };
    timer = setTimeout(() => {
      // Settle here rather than waiting for `close`: a child that ignores the
      // kill must not leave the caller hanging.
      child.kill();
      settle(new Error(`omp ${label} timed out after ${CALL_TIMEOUT_MS} ms`), "");
    }, CALL_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => settle(new Error(`failed to run omp ${label}: ${error.message}`), ""));
    child.on("close", (code) => {
      if (code === 0) {
        settle(null, stdout);
        return;
      }
      // omp's own stderr carries the actionable text (unknown key, the valid
      // enum members); surface it verbatim rather than inventing a message.
      const detail = stderr.trim() || stdout.trim();
      settle(new Error(`omp ${label} exited with code ${code}${detail ? `: ${detail}` : ""}`), "");
    });

    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

// `set` and `reset` rewrite one YAML file through the CLI. Serializing every
// call keeps one call's read-modify-write from interleaving with another's.
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readSnapshot(signal: AbortSignal): Promise<OmpSnapshot> {
  const stdout = await runOmp(["config", "list", "--json"], signal, "config list --json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("omp config list --json did not return JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("omp config list --json did not return a JSON object");
  }
  return parsed as OmpSnapshot;
}

async function readConfigPath(signal: AbortSignal): Promise<string> {
  return (await runOmp(["config", "path"], signal, "config path")).trim();
}

/**
 * Allowed members for an enum key, in the order omp prints them.
 *
 * The `--json` listing reports each key's type but not its members; only the
 * plain-text listing prints them (`display.shimmer = classic
 * (classic|kitt|disabled)`). Keys whose final group is a bare type name have
 * no choices and are left out of the map, so the contract omits `options`
 * for them rather than emitting an empty list.
 */
async function readEnumOptions(signal: AbortSignal): Promise<Map<string, string[]>> {
  return parseEnumOptions(await runOmp(["config", "list"], signal, "config list"));
}

/** `omp config get` prints bare text for scalars and JSON text for arrays/records. */
function parseValueText(text: string): unknown {
  const trimmed = text.trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    // `null` never round-trips through the contract, so keep the literal text.
    return parsed === null ? trimmed : parsed;
  } catch {
    return trimmed;
  }
}

/** Bare text for strings (avoids quoting hazards); JSON for every other shape. */
function renderValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * True when omp's value survives the wire contract intact.
 *
 * `settingValueSchema` is full JSON, so this holds for every value the
 * current omp schema produces. It stays a runtime check rather than an
 * assumption: the daemon validates every handler result, and a future omp
 * key holding a non-JSON shape must degrade one entry, not fail the call.
 */
function isCarryable(value: unknown): boolean {
  return settingValueSchema.safeParse(value).success;
}

/**
 * The value to put on the wire where the contract requires one. A value the
 * contract cannot carry becomes its JSON text, which keeps the call working and
 * the data readable — and `omp config set` accepts that same text back.
 */
function toWireValue(value: unknown): unknown {
  return isCarryable(value) ? value : JSON.stringify(value);
}

/**
 * The value omp reports for one key. The snapshot is authoritative and typed,
 * so it wins; `omp config get` is consulted only when the snapshot cannot
 * answer — an unset key, or a credential-bearing key the listing redacts.
 */
async function readValue(key: string, snapshot: OmpSnapshot, signal: AbortSignal): Promise<unknown> {
  const entry = snapshot[key];
  if (entry !== undefined && entry.value !== undefined) return entry.value;
  return parseValueText(await runOmp(["config", "get", key], signal, `config get ${key}`));
}

/** `omp --version` prints `omp/18.6.0`; the contract wants the bare version. */
function parseVersion(text: string): string {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== "")?.trim() ?? "";
  const match = /^omp\/(.+)$/.exec(line);
  return match?.[1] ?? line;
}

/**
 * Allowed members per enum key, in the order omp prints them, parsed from the
 * plain-text `omp config list` output.
 *
 * Entry lines sit under a `[category]` header and look like
 * `  <key> = <value> (<type>)`. The value may contain spaces, `=`, quotes,
 * brackets, or commas (`["a","b"]`, `{"k":"v"}`), so the separator is the
 * LAST ` = ` and the group is the FINAL balanced `(...)` at the end of the
 * line. A group with a pipe is a member list; a bare type name is not.
 * Ambiguous lines are skipped — a missing option list degrades one row and
 * must never throw or corrupt another key.
 */
function parseEnumOptions(text: string): Map<string, string[]> {
  const options = new Map<string, string[]>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    // Entry lines are the only indented lines; headers, title, and blanks
    // are not, and even when they contain ` = ` they carry no key.
    if (!line.startsWith("  ")) continue;
    const separator = line.lastIndexOf(" = ");
    if (separator <= 2) continue;
    const key = line.slice(0, separator).trim();
    const tail = line.slice(separator + 3);
    // Walk back from the end to the matching `(` of the final group; the
    // value itself may contain parentheses, so the first `(` is not the
    // anchor.
    let depth = 0;
    let open = -1;
    for (let i = tail.length - 1; i >= 0; i--) {
      const char = tail[i];
      if (char === ")") depth++;
      else if (char === "(") {
        depth--;
        if (depth === 0) {
          open = i;
          break;
        }
      }
    }
    // No balanced group at the line end (the value ended with `)`): the line
    // is ambiguous, so leave this key out.
    if (open <= 0) continue;
    const group = tail.slice(open + 1, tail.length - 1);
    if (!group.includes("|")) continue;
    const members = group.split("|");
    // An empty key or member means the line did not match the expected shape;
    // emitting it would corrupt a row.
    if (key === "" || members.some((member) => member === "")) continue;
    options.set(key, members);
  }
  return options;
}

const handlers: ExperimentalHostRpcHandlers<typeof hostContract> = {
  async list(input, context) {
    return serialize(async () => {
      const [snapshot, configPath, enumOptions] = await Promise.all([
        readSnapshot(context.signal),
        readConfigPath(context.signal),
        readEnumOptions(context.signal),
      ]);
      const needle = input.filter?.toLowerCase();
      const entries = Object.entries(snapshot)
        .filter(
          ([key, entry]) =>
            needle === undefined ||
            key.toLowerCase().includes(needle) ||
            entry.description.toLowerCase().includes(needle),
        )
        .map(([key, entry]) => {
          const base = { key, type: entry.type, description: entry.description };
          // `value` is optional here, so a value the contract cannot carry is
          // omitted rather than sent raw (which would fail the whole call).
          const row =
            entry.value === undefined || !isCarryable(entry.value)
              ? base
              : { ...base, value: entry.value };
          const members = enumOptions.get(key);
          // Attach `options` only when the key actually has members; a
          // memberless row stays byte-identical to the pre-options output.
          return members === undefined ? row : { ...row, options: members };
        })
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      return { entries, configPath };
    });
  },

  async get(input, context) {
    return serialize(async () => {
      const snapshot = await readSnapshot(context.signal);
      const value = await readValue(input.key, snapshot, context.signal);
      return { key: input.key, value: toWireValue(value) };
    });
  },

  async set(input, context) {
    return serialize(async () => {
      // One snapshot answers both "does the key exist" and "what was it"; a
      // separate `get` here would double the spawn cost for the same answer.
      const before = await readSnapshot(context.signal);
      const prior = before[input.key]?.value;
      // `previous` is nullable, so an unset or uncarryable prior value is null.
      const previous = prior === undefined || !isCarryable(prior) ? null : prior;
      // `--` ends option parsing so a value like `-1` is not read as a flag.
      await runOmp(
        ["config", "set", input.key, "--", renderValue(input.value)],
        context.signal,
        `config set ${input.key}`,
      );
      // Verify by re-reading: report what the config now holds, not what we asked for.
      const after = await readSnapshot(context.signal);
      if (after[input.key] === undefined) {
        throw new Error(`omp config set ${input.key} reported success but the key is missing from the config`);
      }
      const value = await readValue(input.key, after, context.signal);
      return { key: input.key, value: toWireValue(value), previous };
    });
  },

  async reset(input, context) {
    return serialize(async () => {
      await runOmp(["config", "reset", input.key], context.signal, `config reset ${input.key}`);
      const snapshot = await readSnapshot(context.signal);
      const value = await readValue(input.key, snapshot, context.signal);
      return { key: input.key, value: toWireValue(value) };
    });
  },

  async info(_input, context) {
    return serialize(async () => {
      const [versionText, configPath] = await Promise.all([
        runOmp(["--version"], context.signal, "--version"),
        readConfigPath(context.signal),
      ]);
      return { version: parseVersion(versionText), configPath };
    });
  },
};

export default experimental_defineHostEntry({ contract: hostContract, handlers });
