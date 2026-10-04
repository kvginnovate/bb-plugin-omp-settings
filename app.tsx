// bb-plugin-omp-settings — frontend entry.
//
// One sidebar page that lists and edits every omp setting. Every read and
// write goes through the `ui_*` RPC bridge (contract.ts, registered on
// `bb.rpc` by server.ts): `useRpc` can only reach those four methods, so
// this bundle never talks to host.ts or the omp binary itself.
//
// The control is chosen by the entry's `type` — one control per omp type:
// a toggle for booleans, a select for enums (a free-text input when the
// parsed `options` are absent), a number field for numbers, a text input
// for strings, and a JSON editor for arrays/records because those are
// whole-value writes that replace the current value entirely.
import "./app.css";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { definePluginApp, useRpc, type StandardSchemaV1InferOutput } from "@get-bb/plugin-sdk/app";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { Toaster, toast } from "sonner";
import { uiContract } from "./contract";

// `useRpc` reaches the plugin's OWN `bb.rpc` methods, never `hostContract`:
// server.ts registers `uiContract` and forwards each call to the host entry.
// Typing the client from `hostContract` would make every `ui_*` call fail to
// compile, so the frontend contract is the only correct source here.
type OmpRpc = typeof uiContract;
type SettingEntry = StandardSchemaV1InferOutput<
  (typeof uiContract)["ui_list"]["output"]
>["entries"][number];
type SettingType =
  | "boolean"
  | "number"
  | "enum"
  | "string"
  | "array"
  | "record";

type TypeFilter = "all" | "modified" | SettingType;

/** Search debounce: one `ui_list` per 250 ms, not one per keystroke — each
 * call shells out to `omp config list` on the host. */
const SEARCH_DEBOUNCE_MS = 250;

function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

function formatValue(value: unknown): string {
  if (value === undefined) return "unset";
  if (value === null) return "null";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 42 ? `${text.slice(0, 41)}…` : text;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Secret-bearing keys get a badge, never a hidden value: omp already
 * redacts these in its own output, so the row still renders what the
 * server returns — it just warns that the value is shown in the control
 * only and never reaches a log. The patterns mirror omp's own naming so
 * we don't flag legitimate non-secret settings.
 */
function looksLikeSecret(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.startsWith("auth.") ||
    lower.includes("token") ||
    lower.includes("secret") ||
    lower.includes("credential")
  );
}

/**
 * `ui_list` returns flat keys; omp's own listing groups them under
 * `[category]` headings. The leading dotted segment is the stable
 * grouping omp actually uses — e.g. `statusLine.transparent` →
 * `statusLine` — so no categories are invented beyond that.
 */
function categoryOf(key: string): string {
  const dot = key.indexOf(".");
  return dot > 0 ? key.slice(0, dot) : "general";
}

function isModified(entry: SettingEntry): boolean {
  return entry.value !== undefined;
}

/** Map an entry's free-form type string onto the omp type union. */
function switchType(type: string): SettingType | "unknown" {
  if (
    type === "boolean" ||
    type === "number" ||
    type === "enum" ||
    type === "string" ||
    type === "array" ||
    type === "record"
  ) {
    return type;
  }
  return "unknown";
}

/* ------------------------------------------------------------------ */
/* Refresh channel                                                    */
/* ------------------------------------------------------------------ */
// The host renders `headerContent` as an opaque component with the panel's
// `{ subPath }` — it cannot receive callbacks from the page — so the
// header and the page share one module-level channel: the header's refresh
// button bumps it, and both sides re-run their fetches from the bump.

type RefreshListener = () => void;
const refreshListeners = new Set<RefreshListener>();
let refreshEvent = 0;

function bumpRefresh(): void {
  refreshEvent += 1;
  for (const listener of refreshListeners) listener();
}

function useRefreshEvent(): number {
  const [event, setEvent] = useState(refreshEvent);
  useEffect(() => {
    const listener = () => setEvent(refreshEvent);
    refreshListeners.add(listener);
    return () => {
      refreshListeners.delete(listener);
    };
  }, []);
  return event;
}

/* ------------------------------------------------------------------ */
/* Data hooks                                                         */
/* ------------------------------------------------------------------ */

interface SettingsData {
  entries: SettingEntry[];
  configPath: string;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function useOmpSettings(filter: string): SettingsData {
  const rpc = useRpc<OmpRpc>();
  const [entries, setEntries] = useState<SettingEntry[]>([]);
  const [configPath, setConfigPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const refreshEvent = useRefreshEvent();

  useEffect(() => {
    let stopped = false;
    setLoading(true);
    setError(null);
    const trimmed = filter.trim();
    rpc
      .call("ui_list", { filter: trimmed })
      .then((result) => {
        if (stopped) return;
        setEntries(result.entries);
        setConfigPath(result.configPath);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (stopped) return;
        setError(errorMessage(err));
        setLoading(false);
      });
    return () => {
      stopped = true;
    };
    // `tick` drives the manual refresh; `refreshEvent` drives the header's.
    // Neither clears the search text or the type filter.
  }, [rpc, filter, tick, refreshEvent]);

  const refresh = useCallback(() => setTick((previous) => previous + 1), []);
  return { entries, configPath, loading, error, refresh };
}

/**
 * Header diagnostics: omp version + total setting count, re-fetched on the
 * refresh channel so the compact header stays honest after any write.
 */
function useOmpInfo() {
  const rpc = useRpc<OmpRpc>();
  const [version, setVersion] = useState<string | null>(null);
  const [entries, setEntries] = useState<SettingEntry[] | null>(null);
  const refreshEvent = useRefreshEvent();

  useEffect(() => {
    let stopped = false;
    rpc
      .call("ui_info", null)
      .then((result) => {
        if (!stopped) setVersion(result.version);
      })
      .catch(() => undefined);
    rpc
      .call("ui_list", {})
      .then((result) => {
        if (!stopped) setEntries(result.entries);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [rpc, refreshEvent]);

  return { version, entries };
}

/* ------------------------------------------------------------------ */
/* Header content                                                     */
/* ------------------------------------------------------------------ */
/**
 * Rendered at the trailing edge of the host's shared title bar. The host
 * paints the panel title itself, so this deliberately adds no heading —
 * just the compact version badge, modified-count summary, and refresh.
 *
 * Receives the panel's `{ subPath }` props from the host (ignored) and
 * drives the shared refresh channel directly.
 */
function SettingsHeader() {
  const refreshEvent = useRefreshEvent();
  const { version, entries } = useOmpInfo();
  const modifiedCount = useMemo(
    () => (entries ? entries.filter(isModified).length : null),
    [entries],
  );

  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
        {version === null ? "omp …" : `omp ${version}`}
      </span>
      {entries !== null ? (
        <span>
          {entries.length} settings · {modifiedCount} modified
        </span>
      ) : null}
      <button
        type="button"
        onClick={bumpRefresh}
        title="Reload settings from omp"
        className="inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-muted hover:text-foreground"
      >
        <svg
          className="h-4 w-4 shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      </button>
    </div>
  );
}

/** Wrapper so the host's `{ subPath }` props type-check without the header
 * using them. */
function SettingsHeaderSlot({ subPath: _subPath }: { subPath: string }) {
  return <SettingsHeader />;
}

/* ------------------------------------------------------------------ */
/* Controls — one per omp type                                        */
/* ------------------------------------------------------------------ */

interface ControlProps {
  entry: SettingEntry;
  pending: boolean;
  onCommit: (value: unknown, display: string) => void;
}

/** boolean → a toggle switch, committed on change so the row is honest
 * instantly; the pending flag guards against double commits. */
function BooleanControl({ entry, pending, onCommit }: ControlProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={entry.value === true}
      aria-label={entry.key}
      disabled={pending}
      onClick={() => onCommit(entry.value !== true, String(entry.value !== true))}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-50",
        entry.value === true ? "bg-primary" : "bg-muted",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full transition-all",
          entry.value === true
            ? "left-4 bg-primary-foreground"
            : "left-0.5 bg-foreground/60",
        )}
      />
    </button>
  );
}

/**
 * enum → a select of `options` when the host parsed the allowed members
 * out of omp's plain-text listing. A missing `options` on an enum means
 * that parse produced nothing — fall back to a free-text input (the same
 * control a string key gets) because omp still validates the member on
 * write and the key remains editable.
 */
function EnumControl({ entry, pending, onCommit }: ControlProps) {
  const [draft, setDraft] = useState<string>(
    entry.value === undefined ? "" : String(entry.value),
  );
  const options = entry.options;
  const commit = () => {
    if (draft === "") return;
    onCommit(draft, draft);
  };

  if (options && options.length > 0) {
    return (
      <select
        value={entry.value === undefined ? "" : String(entry.value)}
        disabled={pending}
        onChange={(event) => onCommit(event.target.value, event.target.value)}
        className="max-w-48 rounded-md border border-border bg-background p-1.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
        aria-label={entry.key}
      >
        <option value="" disabled>
          (unset)
        </option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type="text"
      value={draft}
      disabled={pending}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      placeholder="(unset)"
      className="w-44 rounded-md border border-border bg-background p-1.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
      aria-label={`${entry.key} — enum members unavailable, free text`}
      title="Allowed members are unavailable; omp validates the value on save"
    />
  );
}

/** number → a number field; an empty or NaN draft never commits, so an
 * invalid draft cannot overwrite a valid value. */
function NumberControl({ entry, pending, onCommit }: ControlProps) {
  const [draft, setDraft] = useState<string>(
    entry.value === undefined ? "" : String(entry.value),
  );
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") return;
    const parsed = Number(trimmed);
    if (Number.isNaN(parsed)) return;
    onCommit(parsed, String(parsed));
  };
  return (
    <input
      type="number"
      value={draft}
      disabled={pending}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      className="w-28 rounded-md border border-border bg-background p-1.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
      aria-label={entry.key}
    />
  );
}

/** string → a text input committed on blur/Enter. */
function StringControl({ entry, pending, onCommit }: ControlProps) {
  const [draft, setDraft] = useState<string>(
    entry.value === undefined ? "" : String(entry.value),
  );
  const commit = () => {
    if (draft === "" && entry.value === undefined) return;
    onCommit(draft, draft);
  };
  return (
    <input
      type="text"
      value={draft}
      disabled={pending}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
      }}
      placeholder="(unset)"
      className="w-52 rounded-md border border-border bg-background p-1.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
      aria-label={entry.key}
    />
  );
}

/**
 * array / record → a JSON editor. These keys are whole-value writes, so
 * the editor replaces the entire value: the current value is shown as
 * pretty JSON before editing, and Save is enabled only after `JSON.parse`
 * of the draft succeeds — a malformed document never reaches the server.
 */
function JsonControl({ entry, pending, onCommit }: ControlProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const current = entry.value;

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => {
          setDraft(
            current === undefined ? "" : JSON.stringify(current, null, 2),
          );
          setEditing(true);
        }}
        className="max-w-56 truncate rounded-md border border-border bg-background px-2 py-1 font-mono text-xs text-foreground hover:bg-muted"
        title={`${entry.key} = ${formatValue(current)} — click to edit as JSON`}
      >
        {formatValue(current)}
      </button>
    );
  }

  let parseOk = true;
  let parsed: unknown = null;
  try {
    parsed = draft === "" ? null : JSON.parse(draft);
  } catch {
    parseOk = false;
  }

  return (
    <div className="flex w-full max-w-md flex-col gap-1.5">
      <textarea
        value={draft}
        spellCheck={false}
        rows={4}
        onChange={(event) => setDraft(event.target.value)}
        className="w-full resize-y rounded-md border border-border bg-background p-2 font-mono text-xs leading-5 text-foreground outline-none focus:border-primary"
        aria-label={`${entry.key} as JSON`}
      />
      {!parseOk ? (
        <p className="text-xs text-destructive">Invalid JSON — fix before saving.</p>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={!parseOk || pending}
          onClick={() => {
            setEditing(false);
            onCommit(parsed, draft === "" ? "(cleared)" : "updated JSON");
          }}
          className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setEditing(false);
            setDraft("");
          }}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function renderControl(props: ControlProps) {
  switch (switchType(props.entry.type)) {
    case "boolean":
      return <BooleanControl {...props} />;
    case "enum":
      return <EnumControl {...props} />;
    case "number":
      return <NumberControl {...props} />;
    case "string":
      return <StringControl {...props} />;
    case "array":
    case "record":
      return <JsonControl {...props} />;
    default:
      // An unrecognized type still gets the whole-value JSON editor so the
      // row stays usable; omp validates the write regardless.
      return <JsonControl {...props} />;
  }
}

/* ------------------------------------------------------------------ */
/* Settings row                                                       */
/* ------------------------------------------------------------------ */

interface SettingsRowProps {
  entry: SettingEntry;
  /** `old → new` transition captured at commit time, for display only. */
  previous: unknown;
  pending: boolean;
  inlineError: string | null;
  onCommit: (key: string, value: unknown, display: string, previous: unknown) => void;
  onReset: (key: string, previous: unknown) => void;
}

const SettingsRow = memo(function SettingsRow({
  entry,
  previous,
  pending,
  inlineError,
  onCommit,
  onReset,
}: SettingsRowProps) {
  const secret = looksLikeSecret(entry.key);
  const commit = useCallback(
    (value: unknown, display: string) =>
      onCommit(entry.key, value, display, previous),
    [entry.key, previous, onCommit],
  );
  const reset = useCallback(() => onReset(entry.key, previous), [
    entry.key,
    previous,
    onReset,
  ]);

  return (
    <div className="px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-[13px] text-foreground">
              {entry.key}
            </span>
            <span className="rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
              {entry.type}
            </span>
            {secret ? (
              <span
                className="rounded bg-amber-500/15 px-1 py-px text-[10px] font-medium tracking-wide text-amber-600 dark:text-amber-400"
                title="Secret-bearing key: the value is shown in this control only, never in logs or toasts"
              >
                secret
              </span>
            ) : null}
            {isModified(entry) ? (
              <span className="rounded bg-primary/10 px-1 py-px text-[10px] font-medium text-primary">
                set
              </span>
            ) : null}
          </div>
          {entry.description ? (
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {entry.description}
            </p>
          ) : null}
        </div>
        <div className="flex w-full items-center justify-between gap-2 md:w-auto md:shrink-0">
          <div className="flex min-w-0 flex-1 items-center justify-end md:justify-start">
            {renderControl({ entry, pending, onCommit: commit })}
          </div>
          <button
            type="button"
            onClick={reset}
            disabled={pending}
            title="Restore the omp factory default for this key — not the value from your last change"
            className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
          >
            Reset to default
          </button>
        </div>
      </div>
      {previous !== undefined ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          previous: {formatValue(previous)}
        </p>
      ) : null}
      {inlineError ? (
        <p className="mt-1 text-xs text-destructive">{inlineError}</p>
      ) : null}
    </div>
  );
});

/* ------------------------------------------------------------------ */
/* Category section                                                   */
/* ------------------------------------------------------------------ */

interface CategorySectionProps {
  name: string;
  entries: SettingEntry[];
  pendingKeys: ReadonlySet<string>;
  previousValues: ReadonlyMap<string, unknown>;
  rowErrors: ReadonlyMap<string, string>;
  onCommit: SettingsRowProps["onCommit"];
  onReset: SettingsRowProps["onReset"];
}

function CategorySection({
  name,
  entries,
  pendingKeys,
  previousValues,
  rowErrors,
  onCommit,
  onReset,
}: CategorySectionProps) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="rounded-lg border border-border bg-background">
      <button
        type="button"
        onClick={() => setCollapsed((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-muted/50"
        aria-expanded={!collapsed}
      >
        <svg
          className={cn(
            "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
            !collapsed ? "" : "-rotate-90",
          )}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        <span className="text-sm font-semibold text-foreground">{name}</span>
        <span className="ml-auto rounded-full bg-muted px-2 py-px text-[11px] text-muted-foreground">
          {entries.length}
        </span>
      </button>
      {collapsed ? null : (
        <div className="divide-y divide-border pb-1">
          {entries.map((entry) => (
            <SettingsRow
              key={entry.key}
              entry={entry}
              pending={pendingKeys.has(entry.key)}
              previous={previousValues.get(entry.key)}
              inlineError={rowErrors.get(entry.key) ?? null}
              onCommit={onCommit}
              onReset={onReset}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */

const TYPE_FILTERS: readonly [TypeFilter, string][] = [
  ["all", "All"],
  ["modified", "Modified"],
  ["boolean", "Boolean"],
  ["enum", "Enum"],
  ["string", "String"],
  ["number", "Number"],
  ["array", "Array"],
  ["record", "Record"],
];

function SettingsPage({ subPath: _subPath }: { subPath: string }) {
  const rpc = useRpc<OmpRpc>();
  const [searchText, setSearchText] = useState("");
  const [filter, setFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Map<string, string>>(new Map());
  const [previousValues, setPreviousValues] = useState<Map<string, unknown>>(
    new Map(),
  );

  // The server already filters key + description case-insensitively; the
  // local `filter` state is the debounced copy passed to `ui_list`.
  useEffect(() => {
    const timer = setTimeout(() => setFilter(searchText), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText]);

  const { entries, loading, error, refresh } = useOmpSettings(filter);

  const recordPrevious = useCallback((key: string, value: unknown) => {
    setPreviousValues((prev) => {
      const next = new Map(prev);
      next.set(key, value);
      return next;
    });
  }, []);

  const setInlineError = useCallback((key: string, message: string) => {
    setRowErrors((prev) => {
      const next = new Map(prev);
      next.set(key, message);
      return next;
    });
  }, []);

  const clearInlineError = useCallback((key: string) => {
    setRowErrors((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const markPending = useCallback((key: string, pending: boolean) => {
    setPendingKeys((prev) => {
      const next = new Set(prev);
      if (pending) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  /**
   * A commit: `ui_set`, record the old value for the transition display,
   * then a full refresh so enum `options` and the modified set stay
   * truthful — the host verifies the write by re-reading, and the fresh
   * `ui_list` is the source of truth. The refresh deliberately keeps the
   * current search text and type filter; it does not snap the view back.
   */
  const handleCommit = useCallback(
    (key: string, value: unknown, display: string, previous: unknown) => {
      clearInlineError(key);
      recordPrevious(key, previous);
      markPending(key, true);
      rpc
        .call("ui_set", { key, value })
        .then((result) => {
          toast.success(`${key}: ${display} → ${formatValue(result.value)}`, {
            duration: 4000,
          });
          void refresh();
        })
        .catch((err: unknown) => {
          // Surface the failure both inline on this row and as a toast —
          // never a silent revert.
          setInlineError(key, errorMessage(err));
          toast.error(`${key}: ${errorMessage(err)}`, { duration: 6000 });
        })
        .finally(() => markPending(key, false));
    },
    [clearInlineError, markPending, recordPrevious, refresh, rpc, setInlineError],
  );

  /**
   * A reset: `ui_reset` restores the **omp factory default** for the key —
   * not "the value before my last change" — so the row's button is
   * labelled "Reset to default" and its tooltip says so.
   */
  const handleReset = useCallback(
    (key: string, previous: unknown) => {
      clearInlineError(key);
      recordPrevious(key, previous);
      markPending(key, true);
      rpc
        .call("ui_reset", { key })
        .then((result) => {
          toast.success(
            `${key} reset to default: ${formatValue(result.value)}`,
            { duration: 4000 },
          );
          void refresh();
        })
        .catch((err: unknown) => {
          setInlineError(key, errorMessage(err));
          toast.error(`${key}: reset failed — ${errorMessage(err)}`, {
            duration: 6000,
          });
        })
        .finally(() => markPending(key, false));
    },
    [clearInlineError, markPending, recordPrevious, refresh, rpc, setInlineError],
  );

  const modifiedCount = useMemo(
    () => entries.filter(isModified).length,
    [entries],
  );

  const filtered = useMemo(() => {
    return entries.filter((entry) => {
      if (typeFilter === "modified") return isModified(entry);
      if (typeFilter !== "all") return entry.type === typeFilter;
      return true;
    });
  }, [entries, typeFilter]);

  const categories = useMemo(() => {
    const grouped = new Map<string, SettingEntry[]>();
    for (const entry of filtered) {
      const name = categoryOf(entry.key);
      const bucket = grouped.get(name);
      if (bucket) bucket.push(entry);
      else grouped.set(name, [entry]);
    }
    return [...grouped.entries()].map(([name, items]) => ({
      name,
      entries: items,
    }));
  }, [filtered]);

  let body;
  if (loading && error === null) {
    // ~530 settings take several seconds: the host runs two `omp config
    // list` invocations. A real loading state, not a blank page.
    body = (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Listing ~530 omp settings — this takes a few seconds.
        </p>
        {[0, 1, 2, 3, 4].map((index) => (
          <div key={index} className="h-10 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  } else if (error !== null) {
    body = (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={refresh}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          Retry
        </button>
      </div>
    );
  } else if (filtered.length === 0) {
    body = (
      <p className="text-sm text-muted-foreground">
        No settings match the current filter.
      </p>
    );
  } else {
    body = (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search key or description…"
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground outline-none focus:border-primary md:w-72"
            aria-label="Search settings"
          />
          <div className="flex flex-wrap items-center gap-1">
            {TYPE_FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setTypeFilter(value)}
                className={cn(
                  "rounded-md px-2 py-1 text-xs font-medium",
                  typeFilter === value
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="ml-auto text-xs text-muted-foreground">
            {filtered.length} of {entries.length} settings ·{" "}
            {modifiedCount} modified
          </span>
        </div>
        {categories.map((category) => (
          <CategorySection
            key={category.name}
            name={category.name}
            entries={category.entries}
            pendingKeys={pendingKeys}
            previousValues={previousValues}
            rowErrors={rowErrors}
            onCommit={handleCommit}
            onReset={handleReset}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-4 md:p-5">
      {/* The settings list is a wide table-like surface, so max-w-5xl
          instead of the host's classic max-w-3xl page body. */}
      <div className="mx-auto w-full max-w-5xl">{body}</div>
      <Toaster richColors position="bottom-right" />
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "settings",
    title: "omp settings",
    icon: "Sliders",
    path: "settings",
    component: SettingsPage,
    headerContent: SettingsHeaderSlot as ComponentType<{ subPath: string }>,
  });
});
