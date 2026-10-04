/**
 * Host RPC contract for the omp-settings plugin.
 *
 * Every method runs on the machine that invoked the command, because `omp`
 * and its `~/.omp/agent/config.yml` are host-local. The server side never
 * touches `node:fs` for omp state.
 *
 * Values crossing this boundary are JSON: exactly what omp's own config
 * schema accepts. The schema is recursive rather than a fixed union because
 * real settings go deeper than scalars — `bashInterceptor.patterns` is an
 * array of records — and a narrow union makes `list` fail wholesale on one
 * exotic key.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * Any JSON value. Used to validate omp output at the RPC boundary rather
 * than to shape it.
 */
export const settingValueSchema: z.ZodType<unknown> = z.json();

export const settingEntrySchema = z.object({
  key: z.string(),
  type: z.string(),
  description: z.string(),
  /** Absent when the setting has never been set explicitly. */
  value: z.union([settingValueSchema, z.null()]).optional(),
  /**
   * Allowed members for an `enum` key, so a UI can offer a real choice.
   *
   * `omp config list --json` reports the type but not the members; only the
   * plain-text listing prints them (`display.shimmer = classic (classic|kitt|
   * disabled)`). The host parses them out of that text, so an enum without a
   * parsed set here means the text listing was unparseable, not that the key
   * has no choices.
   */
  options: z.array(z.string()).optional(),
});

export const hostContract = defineRpcContract({
  /** Every known setting with its schema type and current value. */
  list: {
    input: z.object({
      /** Case-insensitive substring filter over key and description. */
      filter: z.string().optional(),
    }).strict(),
    output: z.object({
      entries: z.array(settingEntrySchema),
      /** Absolute path of the omp agent dir backing these settings. */
      configPath: z.string(),
    }).strict(),
  },
  get: {
    input: z.object({ key: z.string().min(1) }).strict(),
    output: z.object({
      key: z.string(),
      value: settingValueSchema,
    }).strict(),
  },
  /** Whole-value write. omp rejects unknown keys and invalid enum members. */
  set: {
    input: z.object({
      key: z.string().min(1),
      value: settingValueSchema,
    }).strict(),
    output: z.object({
      key: z.string(),
      value: settingValueSchema,
      /** The value before the write, or null when unset. */
      previous: settingValueSchema.nullable(),
    }).strict(),
  },
  /** Restore the built-in default for one key. */
  reset: {
    input: z.object({ key: z.string().min(1) }).strict(),
    output: z.object({
      key: z.string(),
      value: settingValueSchema,
    }).strict(),
  },
  /** omp version and config location, for diagnostics. */
  info: {
    input: z.null(),
    output: z.object({
      version: z.string(),
      configPath: z.string(),
    }).strict(),
  },
});

export type OmpHostContract = typeof hostContract;

/**
 * Contract the frontend bundle calls through `useRpc`.
 *
 * The frontend cannot reach `hostContract` directly: `useRpc` only calls
 * methods this plugin registered on `bb.rpc`, and a host entry is not one of
 * them. These four methods are that bridge — each one resolves the target
 * host exactly as the CLI does and forwards to the host entry, so the UI and
 * the CLI can never drift apart in host selection or write semantics.
 *
 * `ui_list` returns the same entries as the host so the UI can render one
 * control per omp type: a dropdown for an enum (via `options`), a switch for
 * a boolean, a number field for a number, and a JSON editor for array/record.
 */
export const uiContract = defineRpcContract({
  ui_list: {
    input: z.object({
      /** Case-insensitive substring filter over key and description. */
      filter: z.string().optional(),
    }).strict(),
    output: z.object({
      entries: z.array(settingEntrySchema),
      configPath: z.string(),
    }).strict(),
  },
  ui_set: {
    input: z.object({
      key: z.string().min(1),
      value: settingValueSchema,
    }).strict(),
    output: z.object({
      key: z.string(),
      value: settingValueSchema,
      previous: settingValueSchema.nullable(),
    }).strict(),
  },
  ui_reset: {
    input: z.object({ key: z.string().min(1) }).strict(),
    output: z.object({
      key: z.string(),
      value: settingValueSchema,
    }).strict(),
  },
  ui_info: {
    input: z.null(),
    output: z.object({
      version: z.string(),
      configPath: z.string(),
    }).strict(),
  },
});
