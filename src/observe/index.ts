import { NO_EVENTS, type EventSink } from "../core/events.js";
import type { Settings } from "../core/settings.js";
import type { Document } from "../document/document.js";
import type { BlockBaker } from "../perception/render/bake.js";
import { EventBus } from "./bus.js";
import { DeltaWriter } from "./deltas.js";
import { ObserveHttp } from "./http.js";
import { EventLog, newSessionId, sessionDir } from "./log.js";
import { OBSERVE_DELTAS, OBSERVE_HTTP, OBSERVE_LOG, OBSERVE_MAX_DELTA_BYTES, OBSERVE_RETAIN_SESSIONS, OBSERVE_SNAPSHOTS } from "./settings.js";
import { SnapshotScheduler } from "./snapshots.js";
import { LogTables } from "./states.js";

/**
 * Observability for one server process (docs/design/12-observability.md): the bus, the
 * `events.ndjson` log, `deltas.bin`, time-lapse snapshots and the live viewer, configured from
 * settings. The entry point hands `sink()` to the session; `document/` and `server/` see only
 * that `EventSink`.
 */

export interface ObserveOptions {
  workspace: string;
  settings: Settings;
  version?: string;
  sessionId?: string;
  /** The current base document, for snapshots, deltas and the viewer. */
  getDoc?: () => Document | undefined;
  /**
   * A sandbox document by scope id (11), for sandbox deltas and the viewer's drill-in. Scoped
   * sessions supply it; without it, sandbox ops are logged without deltas.
   */
  getScopeDoc?: (scope: string) => Document | undefined;
  /** The block baker, for snapshots and the viewer's models (awaited off the tool-call path). */
  getBaker?: () => Promise<BlockBaker>;
  log?: (msg: string) => void;
  /** Overrides for tests. */
  flushMs?: number;
  debounceMs?: number;
  viewerDir?: string;
}

export interface Observer {
  readonly sessionId: string;
  readonly bus: EventBus;
  readonly log?: EventLog;
  readonly snapshots?: SnapshotScheduler;
  readonly deltas?: DeltaWriter;
  readonly http?: ObserveHttp;
  /** Resolves once the viewer is listening (its URL), or undefined when it is off or failed. */
  readonly ready: Promise<string | undefined>;
  /** A sink tagged with `doc`; `NO_EVENTS` when everything is off. */
  sink(doc?: string): EventSink;
  /** Stops the viewer, waits for pending snapshots, then flushes the log and deltas. */
  close(): Promise<void>;
}

export function startObserve(opts: ObserveOptions): Observer {
  const sessionId = opts.sessionId ?? newSessionId();
  const logOn = opts.settings.get(OBSERVE_LOG);
  const snapMode = opts.settings.get(OBSERVE_SNAPSHOTS);
  const retain = opts.settings.get(OBSERVE_RETAIN_SESSIONS);
  const port = opts.settings.get(OBSERVE_HTTP);
  const deltaMode = opts.settings.get(OBSERVE_DELTAS);
  const maxDeltaBytes = opts.settings.get(OBSERVE_MAX_DELTA_BYTES);
  const bus = new EventBus({ ...(opts.version ? { version: opts.version } : {}), onError: (e) => opts.log?.(`observe: subscriber failed: ${e.message}`) });
  const dirFor = (doc: string) => sessionDir(opts.workspace, doc, sessionId);
  const docFor = (tag: string) => (tag === "base" ? opts.getDoc?.() : opts.getScopeDoc?.(tag));

  const log = logOn
    ? new EventLog({ workspace: opts.workspace, sessionId, retain, ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}), ...(opts.log ? { log: opts.log } : {}) })
    : undefined;
  if (log) bus.subscribe(log.onEvent);

  const httpOn = port !== false && !!opts.getDoc;
  const deltasOn = !!opts.getDoc && (deltaMode === "on" || (deltaMode === "auto" && httpOn));
  const tables = httpOn || deltasOn ? new LogTables((e) => bus.publish("base", e)) : undefined;
  if (tables) bus.annotate(tables.annotate);
  const deltas = tables && deltasOn
    ? new DeltaWriter({ tables, dirFor, docFor, maxBytes: maxDeltaBytes, ...(opts.flushMs !== undefined ? { flushMs: opts.flushMs } : {}), ...(opts.log ? { log: opts.log } : {}) })
    : undefined;
  if (deltas) bus.annotate(deltas.annotate);

  let snapshots: SnapshotScheduler | undefined;
  if (snapMode !== "off" && opts.getDoc && opts.getBaker) {
    const base = bus.sink("base");
    snapshots = new SnapshotScheduler({
      mode: snapMode,
      dirFor,
      getDoc: opts.getDoc,
      getBaker: opts.getBaker,
      lastSeq: () => bus.lastSeq,
      publish: (e) => base.emit(e),
      ...(opts.debounceMs !== undefined ? { debounceMs: opts.debounceMs } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
    bus.subscribe(snapshots.onEvent);
  }

  let http: ObserveHttp | undefined;
  let ready: Promise<string | undefined> = Promise.resolve(undefined);
  if (tables && httpOn) {
    const h = new ObserveHttp({
      bus,
      tables,
      sessionId,
      dirFor,
      docFor,
      port: port as number,
      ...(opts.getBaker ? { getBaker: opts.getBaker } : {}),
      ...(deltas ? { deltas } : {}),
      ...(opts.version ? { version: opts.version } : {}),
      ...(opts.viewerDir ? { viewerDir: opts.viewerDir } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
    http = h;
    bus.subscribe(h.onEvent);
    ready = h.start().catch((e: Error) => {
      opts.log?.(`observe: viewer failed to start on port ${port}: ${e.message}`);
      return undefined;
    });
  }

  const on = !!log || !!snapshots || !!deltas || !!http;
  return {
    sessionId,
    bus,
    ready,
    ...(log ? { log } : {}),
    ...(snapshots ? { snapshots } : {}),
    ...(deltas ? { deltas } : {}),
    ...(http ? { http } : {}),
    sink: (doc = "base") => (on ? bus.sink(doc) : NO_EVENTS),
    async close() {
      await ready;
      await http?.close();
      // A snapshot waits for in-flight calls; at shutdown, don't let one hold up the exit for long.
      if (snapshots) await Promise.race([snapshots.idle(), new Promise((r) => setTimeout(r, 3000).unref())]);
      await log?.close();
      await deltas?.close();
    },
  };
}
