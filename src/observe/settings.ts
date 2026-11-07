import { parseBool, parseInt0, parseOneOf, setting } from "../core/settings.js";

/** Observability settings (docs/design/12-observability.md, *Settings*). Phases 1–2 only. */

export const OBSERVE_LOG = setting("observe.log", true, "true or false", parseBool);

export const SNAPSHOT_MODES = ["merge", "checkpoint", "off"] as const;
export type SnapshotMode = (typeof SNAPSHOT_MODES)[number];
export const OBSERVE_SNAPSHOTS = setting<SnapshotMode>("observe.snapshots", "off", SNAPSHOT_MODES.join(", "), parseOneOf(SNAPSHOT_MODES));

export const OBSERVE_RETAIN_SESSIONS = setting("observe.retainSessions", 20, "an integer 1..10000", parseInt0(1, 10_000));
