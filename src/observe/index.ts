import { NO_EVENTS, type EventSink } from "../core/events.js";
import type { Settings } from "../core/settings.js";
import type { Document } from "../document/document.js";
import type { BlockBaker } from "../perception/render/bake.js";
import { EventBus } from "./bus.js";
import { EventLog, newSessionId, sessionDir } from "./log.js";
import { OBSERVE_LOG, OBSERVE_RETAIN_SESSIONS, OBSERVE_SNAPSHOTS } from "./settings.js";
import { SnapshotScheduler } from "./snapshots.js";

/**
 * Observability for one server process (docs/design/12-observability.md): the bus, the
 * `events.ndjson` log and time-lapse snapshots, configured from settings. The entry point hands
 * `sink()` to the session; `document/` and `server/` see only that `EventSink`.
 */

export interface ObserveOptions {
  workspace: string;
  settings: Settings;
  version?: string;
  sessionId?: string;
  /** The current base document, for snapshots. */
  getDoc?: () => Document | undefined;
  /** The block baker, for snapshots (awaited off the tool-call path). */
  getBaker?: () => Promise<BlockBaker>;
  log?: (msg: string) => void;
  /** Overrides for tests. */
  flushMs?: number;
  debounceMs?: number;
}

export interface Observer {
  readonly sessionId: string;
  readonly bus: EventBus;
  readonly log?: EventLog;
  readonly snapshots?: SnapshotScheduler;
  /** A sink tagged with `doc`; `NO_EVENTS` when everything is off. */
  sink(doc?: string): EventSink;
  /** Waits for pending snapshots, then flushes the log. */
  close(): Promise<void>;
}

export function startObserve(opts: ObserveOptions): Observer {
  const sessionId = opts.sessionId ?? newSessionId();
  const logOn = opts.settings.get(OBSERVE_LOG);
  const snapMode = opts.settings.get(OBSERVE_SNAPSHOTS);
  const retain = opts.settings.get(OBSERVE_RETAIN_SESSIONS);
  const bus = new EventBus({ ...(opts.version ? { version: opts.version } : {}), onError: (e) => opts.log?.(`observe: subscriber failed: ${e.message}`) });

  const log = logOn
    ? new EventLog({ workspace: opts.workspace, sessionId, retain, ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}), ...(opts.log ? { log: opts.log } : {}) })
    : undefined;
  if (log) bus.subscribe(log.onEvent);

  let snapshots: SnapshotScheduler | undefined;
  if (snapMode !== "off" && opts.getDoc && opts.getBaker) {
    const base = bus.sink("base");
    snapshots = new SnapshotScheduler({
      mode: snapMode,
      dirFor: (doc) => sessionDir(opts.workspace, doc, sessionId),
      getDoc: opts.getDoc,
      getBaker: opts.getBaker,
      lastSeq: () => bus.lastSeq,
      publish: (e) => base.emit(e),
      ...(opts.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
    bus.subscribe(snapshots.onEvent);
  }

  const on = !!log || !!snapshots;
  return {
    sessionId,
    bus,
    ...(log ? { log } : {}),
    ...(snapshots ? { snapshots } : {}),
    sink: (doc = "base") => (on ? bus.sink(doc) : NO_EVENTS),
    async close() {
      // A snapshot waits for in-flight calls; at shutdown, don't let one hold up the exit for long.
      if (snapshots) await Promise.race([snapshots.idle(), new Promise((r) => setTimeout(r, 3000).unref())]);
      await log?.close();
    },
  };
}
