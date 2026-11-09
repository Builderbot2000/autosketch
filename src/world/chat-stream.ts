import type { ObserveEvent } from "../core/events.js";
import type { EventListener } from "../core/fanout.js";
import type { ChatMessage, PlayerRef } from "./protocol/messages.js";

/**
 * What streams back to the game chat (docs/design/13-live-world.md, *Prompting from the game*,
 * "What streams back", W11): one compact **activity** line per tool call, built from the session's
 * event fan-out (`call.start`, `call.end`, `call.refused`, `doc.op`/`doc.undo`/`doc.redo`,
 * `render.produced`, `world.patch`), so no tool emits anything extra; and the agent's **replies**
 * from `world_reply`.
 *
 * - **Coalesced:** a call's edits are summed into its line (a script making thousands of edits is
 *   one line), and consecutive calls of the same tool with the same outcome merge (`fill ×3: …`).
 * - **Rate-limited:** at most one activity `chat` per `activityMs`; lines finished in between wait
 *   for it. A message carries at most `MAX_LINES` lines, the rest summed into a last one.
 * - **Request streams:** while an in-game request is open, `chat` carries its id and player, so the
 *   mod shows activity to that player (log `mine`, the default). It closes on `done` or after
 *   `idleMs` with no tool calls, or when the next request opens. Outside a request, `chat` carries
 *   no request or player, and only players with log `all` see it.
 *
 * The stream reads measurements only (counts of blocks, images, patch results); it says nothing
 * about what the work means.
 */

export interface OpenRequest {
  id: number;
  player: PlayerRef;
}

export interface ActivityStreamOptions {
  /** Subscribes to the session's event fan-out; returns the unsubscribe function. */
  subscribe: (fn: EventListener) => () => void;
  /** Sends one `chat` to the mod (dropped while disconnected). */
  send: (m: ChatMessage) => void;
  /** Whether a document is linked now; activity is reported only then. */
  linked: () => boolean;
  /** Minimum time between activity messages (ms; 0 sends each line as its call ends). */
  activityMs: number;
  /** A request stream closes after this long with no tool calls (ms). */
  idleMs: number;
}

/** Lines per activity message; the rest are summed into one last line. */
export const MAX_LINES = 6;
/** Longest activity line, in characters (the mod wraps long lines for display). */
const MAX_LINE = 120;
/** Tools whose calls are not activity: a reply is shown as itself. */
const SILENT = new Set(["world_reply"]);

interface CallAcc {
  call: number;
  tool: string;
  /** "base" or a scope id: the document tag its edits arrive with. */
  doc: string;
  changed: number;
  images: number;
  ok: boolean;
  refused?: string;
  patch?: { applied: number; skipped: number; rejected: number; dropped?: string };
}

/** A finished line waiting to be sent: a call (or run of calls), or a late patch result. */
interface Line {
  key: string;
  tool: string;
  doc: string;
  count: number;
  changed: number;
  images: number;
  ok: boolean;
  refused?: string;
  patch?: { applied: number; skipped: number; rejected: number; dropped?: string };
}

const fmt = (n: number) => n.toLocaleString("en-US");

export class ActivityStream {
  private unsubscribe?: () => void;
  private readonly calls = new Map<number, CallAcc>();
  private queue: Line[] = [];
  private lastSent = -Infinity;
  private flushTimer?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private request?: OpenRequest;
  /** Recent requests by id, so a late reply still reaches the player who asked. */
  private readonly recent = new Map<number, OpenRequest>();

  constructor(private readonly opts: ActivityStreamOptions) {}

  /** Starts listening to the fan-out (idempotent). The link calls it while the bridge is up. */
  start(): void {
    this.unsubscribe ??= this.opts.subscribe((e, doc) => this.onEvent(e, doc));
  }

  /** Stops listening and drops pending lines and the open request. */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.calls.clear();
    this.queue = [];
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.closeRequest();
  }

  /** The open request stream, if any. */
  get current(): OpenRequest | undefined {
    return this.request;
  }

  /** Opens a request stream (replacing any open one): later activity goes to its player. */
  open(request: OpenRequest): void {
    this.flush();
    this.request = request;
    this.recent.set(request.id, request);
    if (this.recent.size > 32) this.recent.delete(this.recent.keys().next().value!);
    this.touch();
  }

  /** Closes the open request stream (pending activity is sent first, still under it). */
  closeRequest(): void {
    if (this.queue.length) this.flush();
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.request = undefined;
  }

  /**
   * Sends a reply (`world_reply`): pending activity first, so the chat keeps the order things
   * happened in. `request` defaults to the open request; a recent closed one still reaches its
   * player, without reopening its stream. `done` closes the open request it answers. Returns the
   * request answered (undefined when none: then only players with log `all` see it).
   */
  reply(lines: string[], opts: { done?: boolean; request?: number } = {}): { request: OpenRequest | undefined; open: boolean } {
    this.flush();
    const open = opts.request === undefined || opts.request === this.request?.id;
    const target = open ? this.request : this.recent.get(opts.request!);
    const request = opts.request ?? target?.id ?? null;
    this.opts.send({ type: "chat", request, player: target?.player.uuid ?? null, kind: "reply", lines });
    const isOpen = open && !!target;
    if (isOpen) this.touch();
    if (opts.done && isOpen) this.closeRequest();
    return { request: target, open: isOpen };
  }

  /** Sends every pending activity line now. */
  flush(): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (!this.queue.length) return;
    const lines = activityLines(this.queue);
    this.queue = [];
    this.lastSent = Date.now();
    this.opts.send({ type: "chat", request: this.request?.id ?? null, player: this.request?.player.uuid ?? null, kind: "activity", lines });
  }

  // -- events ---------------------------------------------------------------------------------

  private onEvent(e: ObserveEvent, doc: string): void {
    switch (e.kind) {
      case "call.start":
        if (SILENT.has(e.tool) || !this.opts.linked()) return;
        this.calls.set(e.call, { call: e.call, tool: e.tool, doc: e.scope ?? "base", changed: 0, images: 0, ok: true });
        this.touch();
        return;
      case "call.refused": {
        const c = this.calls.get(e.call);
        if (c) c.refused = e.code;
        return;
      }
      case "call.end": {
        const c = this.calls.get(e.call);
        if (!c) return;
        this.calls.delete(e.call);
        c.ok = e.ok;
        this.push(lineOf(c));
        this.touch();
        return;
      }
      case "doc.op":
      case "doc.undo":
      case "doc.redo": {
        if (e.op === "world_sync") return; // the world's own changes coming in, not the agent's work
        const c = this.callFor(doc);
        if (c) c.changed += e.changed;
        return;
      }
      case "render.produced": {
        const c = this.callFor(e.scope ?? doc);
        if (c) c.images++;
        return;
      }
      case "world.patch": {
        const patch = { applied: e.applied, skipped: e.skipped, rejected: e.rejected, ...(e.dropped ? { dropped: e.dropped } : {}) };
        const c = this.callFor("base");
        if (c) {
          const p = c.patch;
          c.patch = p ? { applied: p.applied + patch.applied, skipped: p.skipped + patch.skipped, rejected: p.rejected + patch.rejected, ...(patch.dropped ?? p.dropped ? { dropped: patch.dropped ?? p.dropped } : {}) } : patch;
        } else if (this.opts.linked()) this.push({ key: `world|${patch.dropped ?? ""}`, tool: "world", doc: "base", count: 1, changed: 0, images: 0, ok: true, patch });
        return;
      }
      default:
        return;
    }
  }

  /** The latest open call on the document `doc` ("base" or a scope id), else the latest open call. */
  private callFor(doc: string): CallAcc | undefined {
    let any: CallAcc | undefined, match: CallAcc | undefined;
    for (const c of this.calls.values()) {
      any = c;
      if (c.doc === doc) match = c;
    }
    return match ?? any;
  }

  private push(line: Line): void {
    const last = this.queue.at(-1);
    if (last && last.key === line.key) {
      last.count += line.count;
      last.changed += line.changed;
      last.images += line.images;
      if (line.patch) last.patch = last.patch ? { applied: last.patch.applied + line.patch.applied, skipped: last.patch.skipped + line.patch.skipped, rejected: last.patch.rejected + line.patch.rejected, ...(line.patch.dropped ? { dropped: line.patch.dropped } : {}) } : line.patch;
    } else this.queue.push(line);
    this.schedule();
  }

  private schedule(): void {
    if (this.flushTimer) return;
    const wait = Math.max(0, this.lastSent + this.opts.activityMs - Date.now());
    if (wait === 0) return this.flush();
    this.flushTimer = setTimeout(() => this.flush(), wait);
    this.flushTimer.unref?.();
  }

  /** Restarts the open request's idle timer. */
  private touch(): void {
    if (!this.request) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.closeRequest(), this.opts.idleMs);
    this.idleTimer.unref?.();
  }
}

function lineOf(c: CallAcc): Line {
  const outcome = c.refused ? `refused:${c.refused}` : c.ok ? "ok" : "failed";
  return { key: `${c.doc}|${c.tool}|${outcome}`, tool: c.tool, doc: c.doc, count: 1, changed: c.changed, images: c.images, ok: c.ok, ...(c.refused ? { refused: c.refused } : {}), ...(c.patch ? { patch: c.patch } : {}) };
}

/** The text of one line: `fill: 1,204 blocks`, `render: 1 image`, `fill refused: lock_overlap`. */
export function formatLine(l: Line): string {
  const where = l.doc === "base" ? "" : `[${l.doc}] `;
  const name = `${where}${l.tool}${l.count > 1 ? ` ×${fmt(l.count)}` : ""}`;
  if (l.refused) return clip(`${name} refused: ${l.refused}`);
  const parts: string[] = [];
  if (!l.ok) parts.push("failed");
  if (l.changed) parts.push(`${fmt(l.changed)} block${l.changed === 1 ? "" : "s"}`);
  if (l.images) parts.push(`${fmt(l.images)} image${l.images === 1 ? "" : "s"}`);
  if (l.patch) {
    const p = l.patch;
    if (p.dropped) parts.push(`world: not sent (${p.dropped})`);
    else parts.push(`world: ${fmt(p.applied)} placed${p.skipped ? `, ${fmt(p.skipped)} skipped (hand-edited)` : ""}${p.rejected ? `, ${fmt(p.rejected)} rejected` : ""}`);
  }
  if (l.tool === "world" && l.patch) return clip(parts.join(", "));
  return clip(parts.length ? `${name}: ${parts.join(", ")}` : name);
}

function activityLines(queue: Line[]): string[] {
  if (queue.length <= MAX_LINES) return queue.map(formatLine);
  const shown = queue.slice(0, MAX_LINES - 1).map(formatLine);
  const rest = queue.slice(MAX_LINES - 1);
  const calls = rest.reduce((n, l) => n + (l.tool === "world" ? 0 : l.count), 0);
  const blocks = rest.reduce((n, l) => n + l.changed, 0);
  const tools = [...new Set(rest.map((l) => l.tool))];
  shown.push(clip(`… ${fmt(calls)} more call${calls === 1 ? "" : "s"}${blocks ? `, ${fmt(blocks)} blocks` : ""} (${tools.join(", ")})`));
  return shown;
}

const clip = (s: string) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s);
