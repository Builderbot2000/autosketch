import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { LoggedEvent } from "../core/events.js";

/**
 * Reads finished session logs (docs/design/12-observability.md, *Event stream*): the
 * `events.ndjson` files the log writer (`log.ts`) leaves in `<workspace>/<doc>/observe/<session>/`.
 * Used by `autosketch observe <path>` (`offline.ts`) and by the eval harness's log join
 * (`test/eval/join.ts`, 12 *Metrics and evals*). Read-only; nothing here is reachable from a tool.
 */

export interface ParsedLog {
  /** Events in `seq` order, deduplicated by `seq`. */
  events: LoggedEvent[];
  /** Events the writer reported dropping (`observe.dropped` markers). */
  dropped: number;
}

/** Parses `events.ndjson` text. Malformed lines (a torn last write, say) are skipped. */
export function parseEventLog(text: string, into = new Map<number, LoggedEvent>()): { events: Map<number, LoggedEvent>; dropped: number } {
  let dropped = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: LoggedEvent & { count?: number };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e.kind as string) === "observe.dropped") dropped += e.count ?? 0;
    else if (typeof e.seq === "number") into.set(e.seq, e);
  }
  return { events: into, dropped };
}

const sorted = (m: Map<number, LoggedEvent>): LoggedEvent[] => [...m.values()].sort((a, b) => a.seq - b.seq);

/** Every event in a workspace's logs (`<ws>/<doc>/observe/<session>/events.ndjson`), in `seq` order. */
export async function readWorkspaceEvents(workspace: string): Promise<ParsedLog> {
  const events = new Map<number, LoggedEvent>();
  let dropped = 0;
  for (const doc of await safeReaddir(workspace))
    for (const session of await safeReaddir(join(workspace, doc, "observe"))) {
      let text: string;
      try {
        text = await readFile(join(workspace, doc, "observe", session, "events.ndjson"), "utf8");
      } catch {
        continue;
      }
      dropped += parseEventLog(text, events).dropped;
    }
  return { events: sorted(events), dropped };
}

/** One session folder's log, plus what else the folder holds. */
export interface SessionLog extends ParsedLog {
  dir: string;
  /** The folder name, which is the session id. */
  sessionId: string;
  /** Bytes in `deltas.bin`, 0 when there is none. */
  deltaBytes: number;
  /** Time-lapse snapshot files (`snapshots/<seq>.png`), by seq ascending. */
  snapshots: { seq: number; file: string }[];
}

export async function readSessionLog(dir: string): Promise<SessionLog> {
  const { events, dropped } = parseEventLog(await readFile(join(dir, "events.ndjson"), "utf8"));
  let deltaBytes = 0;
  try {
    deltaBytes = (await stat(join(dir, "deltas.bin"))).size;
  } catch {
    /* no deltas */
  }
  const snapshots = (await safeReaddir(join(dir, "snapshots")))
    .map((file) => ({ file, m: /^(\d+)\.png$/.exec(file) }))
    .filter((s) => s.m)
    .map((s) => ({ seq: Number(s.m![1]), file: s.file }))
    .sort((a, b) => a.seq - b.seq);
  return { dir, sessionId: basename(dir), events: sorted(events), dropped, deltaBytes, snapshots };
}

/**
 * Finds the session folder a user means: the folder itself (it holds `events.ndjson`), a
 * document's `observe/` folder, or a document folder (`<workspace>/<doc>`); for the last two, the
 * newest session (session ids sort by time, `log.ts`).
 */
export async function resolveSessionDir(path: string): Promise<string> {
  const p = resolve(path);
  if (await isFile(join(p, "events.ndjson"))) return p;
  for (const observe of [p, join(p, "observe")]) {
    const sessions = [];
    for (const name of await safeReaddir(observe)) if (await isFile(join(observe, name, "events.ndjson"))) sessions.push(name);
    if (sessions.length) return join(observe, sessions[sessions.length - 1]!);
  }
  throw new Error(`no session log at ${p}: expected a folder with events.ndjson, a document's observe/ folder, or a document folder`);
}

async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}
