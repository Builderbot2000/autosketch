import { parseBool, parseInt0, parseOneOf, setting } from "../core/settings.js";

/** Observability settings (docs/design/12-observability.md, *Settings*). */

export const OBSERVE_LOG = setting("observe.log", true, "true or false", parseBool);

export const SNAPSHOT_MODES = ["merge", "checkpoint", "off"] as const;
export type SnapshotMode = (typeof SNAPSHOT_MODES)[number];
export const OBSERVE_SNAPSHOTS = setting<SnapshotMode>("observe.snapshots", "off", SNAPSHOT_MODES.join(", "), parseOneOf(SNAPSHOT_MODES));

export const OBSERVE_RETAIN_SESSIONS = setting("observe.retainSessions", 20, "an integer 1..10000", parseInt0(1, 10_000));

/** `observe.http`: off (`false`), a port 1..65535, or `true`/`0` for a free port (returned as 0). */
export const parseHttp = (raw: string): number | false | undefined => {
  const s = raw.trim();
  if (/^\d+$/.test(s)) return parseInt0(0, 65_535)(s);
  const b = parseBool(s);
  return b === undefined ? undefined : b ? 0 : false;
};
/** On by default (a free port), so the viewer boots with every MCP session. */
export const OBSERVE_HTTP = setting<number | false>("observe.http", 0, "a port 1..65535, true (a free port) or false", parseHttp);

/** `observe.open`: open the live viewer in the default browser once it is up (MCP server only). */
export const OBSERVE_OPEN = setting("observe.open", true, "true or false", parseBool);

export const DELTA_MODES = ["auto", "on", "off"] as const;
export type DeltaMode = (typeof DELTA_MODES)[number];
/** `"auto"` turns deltas on when the viewer is enabled (12, *Block deltas*). */
export const OBSERVE_DELTAS = setting<DeltaMode>("observe.deltas", "auto", DELTA_MODES.join(", "), parseOneOf(DELTA_MODES));

/** Bytes: a plain integer or one with a K/M/G suffix (`512M`). */
export const parseBytes = (raw: string): number | undefined => {
  const m = /^(\d+)\s*([kmg]?)b?$/i.exec(raw.trim());
  if (!m) return undefined;
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2]!.toLowerCase() as "" | "k" | "m" | "g"];
  const n = Number(m[1]) * unit;
  return Number.isSafeInteger(n) ? n : undefined;
};
export const OBSERVE_MAX_DELTA_BYTES = setting("observe.maxDeltaBytes", 512 * 1024 ** 2, "bytes, e.g. 536870912 or 512M", parseBytes);
