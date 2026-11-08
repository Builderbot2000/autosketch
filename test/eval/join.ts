import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoggedEvent } from "../../src/core/events.js";
import { resultTokens, type Transcript } from "./transcript.js";

/**
 * Joins the server's event log (docs/design/12-observability.md, `events.ndjson`) with the Agent
 * SDK transcript on tool-call order (12, *Metrics and evals*). The server never sees model
 * tokens and the transcript never sees scopes, ops or refusals; the joined table has both.
 *
 * Matching: Autosketch tool calls are taken in transcript order, and each one is paired with the
 * earliest unmatched logged call of the same tool (`call.start` order). Same-tool order is all
 * that has to agree, so parallel calls to different tools that the SDK ran out of order still
 * pair correctly. Leftovers on either side are counted, not guessed.
 */

/** Image tokens for a picture of this many pixels (Anthropic's documented estimate, w × h / 750). */
export const imageTokens = (pixels: number): number => Math.ceil(pixels / 750);

/** Every event in a workspace's logs (`<ws>/<doc>/observe/<session>/events.ndjson`), in `seq` order. */
export async function readEvents(workspace: string): Promise<{ events: LoggedEvent[]; dropped: number }> {
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
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let e: LoggedEvent & { count?: number };
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if ((e.kind as string) === "observe.dropped") dropped += e.count ?? 0;
        else if (typeof e.seq === "number") events.set(e.seq, e);
      }
    }
  return { events: [...events.values()].sort((a, b) => a.seq - b.seq), dropped };
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}

export interface LoggedCall {
  call: number;
  tool: string;
  scope?: string;
  /** Envelope `doc` of the call events ("base" until scoped sessions route calls). */
  doc: string;
  seq: number;
  ms?: number;
  ok?: boolean;
  chars: number;
  images: number;
  pixels: number;
  refused?: string;
}

export function loggedCalls(events: readonly LoggedEvent[]): LoggedCall[] {
  const calls = new Map<number, LoggedCall>();
  for (const e of events) {
    if (e.kind === "call.start") calls.set(e.call, { call: e.call, tool: e.tool, ...(e.scope ? { scope: e.scope } : {}), doc: e.doc, seq: e.seq, chars: 0, images: 0, pixels: 0 });
    else if (e.kind === "call.end") {
      const c = calls.get(e.call);
      if (c) Object.assign(c, { ms: e.ms, ok: e.ok, chars: e.chars, images: e.images, pixels: e.pixels });
    } else if (e.kind === "call.refused") {
      const c = calls.get(e.call);
      if (c) c.refused = e.code;
    }
  }
  return [...calls.values()].sort((a, b) => a.seq - b.seq);
}

export interface JoinedCall {
  order: number;
  /** Autosketch tool name, or the full name for other tools (Task). */
  tool: string;
  thread: string;
  ok?: boolean;
  /** From the log; absent when the call has no logged counterpart. */
  logged?: LoggedCall;
  /** Context tokens the result added (see `resultTokens`). */
  tokens?: number;
}

export interface Join {
  calls: JoinedCall[];
  /** Autosketch calls in the transcript with no logged call (log off, dropped, or server crash). */
  unmatchedTranscript: number;
  /** Logged calls the transcript doesn't show. */
  unmatchedLog: number;
}

export function joinCalls(t: Transcript, events: readonly LoggedEvent[]): Join {
  const logged = loggedCalls(events);
  const used = new Set<number>();
  let unmatchedTranscript = 0;
  const pairs = t.calls.map((c) => {
    if (!c.tool) return undefined;
    const hit = logged.find((l) => !used.has(l.call) && l.tool === c.tool);
    if (!hit) {
      unmatchedTranscript++;
      return undefined;
    }
    used.add(hit.call);
    return hit;
  });
  const tokens = resultTokens(t, (c) => {
    const l = pairs[c.order];
    return l ? imageTokens(l.pixels) : c.resultImages * 800;
  });
  const calls = t.calls.map((c, i): JoinedCall => ({
    order: c.order,
    tool: c.tool ?? c.name,
    thread: c.thread,
    ...(c.ok !== undefined ? { ok: c.ok } : {}),
    ...(pairs[i] ? { logged: pairs[i] } : {}),
    ...(tokens[i] !== undefined ? { tokens: tokens[i] } : {}),
  }));
  return { calls, unmatchedTranscript, unmatchedLog: logged.length - used.size };
}

/** One delegated job (11): a scope from fork to merge or abandon, with its joined cost. */
export interface JobRow {
  scope: string;
  parent: string;
  depth: number;
  brief: string;
  outcome: "merged" | "abandoned" | "open";
  ops: number;
  calls: number;
  refusals: number;
  responseChars: number;
  imageTokens: number;
  /** Result tokens of the job's calls, where the join could attribute them. */
  tokens: number;
  wallMs?: number;
}

export interface SessionStats {
  forks: number;
  merges: number;
  abandons: number;
  maxDepth: number;
  refusals: Record<string, number>;
  /** Most jobs open at once. */
  maxParallel: number;
  /** Briefs forked more than once (12: over-eager forking shows as repeated briefs). */
  repeatedBriefs: number;
}

/**
 * The per-job and per-session tables of 12, *Metrics and evals*. A call belongs to a job when the
 * log tags it with the scope (the call's `scope` argument or its event `doc`).
 */
export function jobTable(events: readonly LoggedEvent[], joined: Join): { jobs: JobRow[]; session: SessionStats } {
  const jobs = new Map<string, JobRow & { t0: number }>();
  const refusals: Record<string, number> = {};
  let open = 0, maxParallel = 0, merges = 0, abandons = 0;
  for (const e of events) {
    if (e.kind === "scope.fork") {
      jobs.set(e.scope, { scope: e.scope, parent: e.parent, depth: e.depth, brief: e.brief, outcome: "open", ops: 0, calls: 0, refusals: 0, responseChars: 0, imageTokens: 0, tokens: 0, t0: e.t });
      maxParallel = Math.max(maxParallel, ++open);
    } else if (e.kind === "scope.merge" || e.kind === "scope.abandon") {
      const j = jobs.get(e.scope);
      if (j && j.outcome === "open") {
        j.outcome = e.kind === "scope.merge" ? "merged" : "abandoned";
        j.wallMs = e.t - j.t0;
        open--;
      }
      if (e.kind === "scope.merge") merges++;
      else abandons++;
    } else if (e.kind === "doc.op" && e.doc !== "base") {
      const j = jobs.get(e.doc);
      if (j) j.ops++;
    } else if (e.kind === "call.refused") refusals[e.code] = (refusals[e.code] ?? 0) + 1;
  }
  for (const c of joined.calls) {
    const l = c.logged;
    if (!l) continue;
    const j = jobs.get(l.scope ?? l.doc);
    if (!j) continue;
    j.calls++;
    j.responseChars += l.chars;
    j.imageTokens += imageTokens(l.pixels);
    j.tokens += c.tokens ?? 0;
    if (l.refused) j.refusals++;
  }
  const briefs = new Map<string, number>();
  for (const j of jobs.values()) briefs.set(j.brief, (briefs.get(j.brief) ?? 0) + 1);
  const rows = [...jobs.values()].map(({ t0: _t0, ...r }) => r);
  return {
    jobs: rows,
    session: {
      forks: rows.length,
      merges,
      abandons,
      maxDepth: rows.reduce((m, r) => Math.max(m, r.depth), 0),
      refusals,
      maxParallel,
      repeatedBriefs: [...briefs.values()].filter((n) => n > 1).length,
    },
  };
}
