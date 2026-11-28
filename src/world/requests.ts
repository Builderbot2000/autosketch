import type { ObserveEvent } from "../core/events.js";
import type { Document } from "../document/document.js";
import { refusal } from "../scope/scopes.js";
import type { BridgeConnection } from "./bridge.js";
import {
  QUEUE_MAX,
  STATUS_INTERVAL_MS,
  type ChatMessage,
  type NoticeMessage,
  type PatchDrop,
  type PlayerRef,
  type PromptMessage,
  type PromptRefusal,
  type PromptResult,
  type RequestControl,
  type RequestState,
  type StatusAction,
  type StatusMessage,
} from "./protocol/messages.js";
import type { RequestEdits, UndoDone } from "./request-undo.js";
import { isWorldSync } from "./sync.js";

/**
 * The in-game request lifecycle (docs/design/19-canvas-and-requests.md, Part A; `13`, *Request
 * control and canvas*): request states, turn ownership, the per-player queue, stop, and the status
 * lines. Measurements only: states, calls, elapsed time.
 *
 * - **Turns by order** (*When a request has concluded*): a request delivered while no turn runs
 *   starts one; the next `turn.end` (the plugin's `Stop` hook, on the observe bus) ends it and every
 *   request delivered into it (*Send now*, or any prompt to a mod without `requests`). Fallbacks:
 *   while no `turn.end` has been seen this session, `world_reply done` concludes its request (the
 *   turn ends once none in it is still running); and always, `idleMs` with no tool call running ends
 *   the turn, since an Esc interrupt fires no hook. A turn ended by a fallback says `noTurnSignal`.
 * - **Queue** (*Queueing*; both hellos list `requests`): a prompt arriving while a turn runs (or a
 *   queued prompt is being delivered) waits, at most `QUEUE_MAX` per player (refused `busy` past it),
 *   with the context it was sent with (the prompt message itself). When the turn ends, the oldest
 *   entry of any player is delivered and starts the next turn. Stop keeps the queue; a disconnect
 *   drops it. A mod without `requests` gets no queueing (decided by the lead, 2026-11-27): its
 *   prompts are delivered at once, as before, and join the running turn.
 * - **Stop** (*Stop*): the running turn's requests turn `stopping`; `stopSignal` aborts the world
 *   reads in flight, `onStop` tells the mod to drop its unstarted patches, and `before` (a session
 *   call hook) refuses every tool call with `stopped` until the turn ends, which makes them
 *   `stopped`, lifts the refusal and delivers the next queued prompt.
 * - **Undo** (*Stop*, step 5; *Settled in step Q2*): the base document's journal entries committed
 *   while a request was `working` or `stopping` are its edits (`world_sync` entries are the world's,
 *   not its own); `request.undo` on a concluded request undoes them as one step (`opts.undo`).
 * - **Status lines** (*Status line*): with `requests` on both hellos, a `chat` kind `status` per
 *   request on each state change and at most once per `statusMs` while its counts move; without it,
 *   a plain `chat` activity line on each state change.
 */

/** What every tool call is refused with while a request is stopping (`19`, *Stop*, step 3). */
export const STOPPED_TEXT = "The player stopped this request. End your turn now; don't retry or continue.";
/** Longest prompt text on a status line ("possibly shortened"). */
export const STATUS_TEXT_MAX = 80;
/** Requests remembered after they concluded, so a late click is answered `answered`, not `not_found`. */
const KNOWN_MAX = 64;

/** One in-game request as the lifecycle tracks it. */
export interface RequestEntry {
  id: number;
  player: PlayerRef;
  /** The prompt's whole text. */
  text: string;
  state: RequestState;
  /** Tool calls made while it was running. */
  calls: number;
  /** When it was delivered (epoch ms); undefined while queued. */
  deliveredAt?: number;
  /** When it concluded. */
  endedAt?: number;
  /** Concluded by a fallback, not the hook. */
  noTurnSignal?: boolean;
  /** A concluded entry that never ran: why (`cancelled`, or a delivery refusal). */
  never?: "cancelled" | PromptRefusal;
  /** While queued: the prompt as it was sent (its context is the one captured then). */
  prompt?: PromptMessage;
  /** The base-document entries it committed while running (`19`, *Settled in step Q2*). */
  edits?: RequestEdits;
  /** How many of its entries `[Undo request]` undid. */
  undone?: number;
  /** What its last status said, to rate-limit and skip repeats. */
  sent?: { state: RequestState; calls: number; sec: number; pos: number | undefined; at: number };
}

/** The answer to a request-control `ui.request` (`13`, *Request kinds*), for `ui/requests.ts` to send. */
export type ControlAnswer = { ok: true; result: Record<string, unknown> } | { ok: false; error: "answered" | "not_found" | "refused" | "bad_request"; message: string };

export interface RequestLifecycleOptions {
  bridge: Pick<BridgeConnection, "send" | "requests" | "connected">;
  /** Delivers a prompt taken off the queue; resolves with the refusal, or undefined once delivered (and `delivered` was called). */
  deliver(m: PromptMessage): Promise<PromptRefusal | undefined>;
  /** A turn with no tool call for this long ends (ms; the fallback for a missing or silent hook). */
  idleMs: number;
  /** Least time between two status lines of one request while its state is unchanged (default `STATUS_INTERVAL_MS`). */
  statusMs?: number;
  /** The base document now, read when an entry commits (`[Undo request]` undoes only on the document the request edited). */
  baseDoc?(): Document | undefined;
  /**
   * Undoes a concluded request's edits as one step (`request-undo.ts`, run by the entry point through
   * the session's call hooks, so the sync and the world link see it as an undo). Without it
   * `request.undo` answers `bad_request`.
   */
  undo?(request: number, edits: RequestEdits): Promise<UndoDone | Extract<ControlAnswer, { ok: false }>>;
  /** Called on a stop, after the states changed (the entry point sends `patch.drop` here). */
  onStop?(): void;
  now?(): number;
  log?(msg: string): void;
}

interface Turn {
  entries: RequestEntry[];
}

export class RequestLifecycle {
  /** Whether a `turn.end` has arrived this session (then `world_reply done` no longer ends a turn). */
  hookSeen = false;
  private turn?: Turn;
  private queue: RequestEntry[] = [];
  private readonly known = new Map<number, RequestEntry>();
  /** The running turn's abort controller: aborted by a stop, replaced when the next turn starts. */
  private turnCtl?: AbortController;
  /** The queued request being delivered (`next`), if any. */
  private deliveringId?: number;
  private delivering = false;
  private idleTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  /** Tool calls started and not yet ended (`call.start`/`call.end` ids). */
  private readonly inFlight = new Set<number>();

  constructor(private readonly opts: RequestLifecycleOptions) {}

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  // -- state ----------------------------------------------------------------------------------

  /** True from a stop until its turn ends: every tool call is refused `stopped`. */
  get stopping(): boolean {
    return this.turn !== undefined && this.turnCtl?.signal.aborted === true;
  }

  /** The running turn's signal, aborted when it is stopped; world reads in flight race it (`stoppableReads`). Undefined with no turn. */
  get stopSignal(): AbortSignal | undefined {
    return this.turn ? this.turnCtl?.signal : undefined;
  }

  /** The running turn's requests, in delivery order (empty when no turn runs). */
  get running(): readonly RequestEntry[] {
    return this.turn?.entries ?? [];
  }

  /** The queue, oldest first (every player's). */
  get queued(): readonly RequestEntry[] {
    return this.queue;
  }

  /** A request by id, while running, queued or recently concluded. */
  entry(id: number): RequestEntry | undefined {
    return this.known.get(id);
  }

  /** Whether a prompt arriving now waits in the queue: both hellos list `requests` and a turn runs (or the queue is being delivered). */
  get shouldQueue(): boolean {
    return this.opts.bridge.requests && (this.turn !== undefined || this.delivering || this.queue.length > 0);
  }

  // -- delivery and the queue -----------------------------------------------------------------

  /**
   * Queues a prompt (call only when `shouldQueue`): refused `busy` when the player's queue is full.
   * Returns the `prompt.result` to send.
   */
  enqueue(m: PromptMessage): Extract<PromptResult, { queued: true }> | Extract<PromptResult, { reason: PromptRefusal }> {
    const mine = this.queue.filter((e) => same(e.player, m.player));
    if (mine.length >= QUEUE_MAX) return { type: "prompt.result", id: m.id, delivered: false, reason: "busy" };
    const e: RequestEntry = { id: m.id, player: m.player, text: m.text, state: "queued", calls: 0, prompt: m };
    this.queue.push(e);
    this.remember(e);
    this.status(e, true);
    const behind = this.turn?.entries[0]?.id ?? this.deliveringId ?? this.queue[0]!.id;
    if (!this.turn && !this.delivering) void this.next();
    return { type: "prompt.result", id: m.id, delivered: false, queued: true, request: behind, position: mine.length + 1 };
  }

  /**
   * A request was delivered to the agent (directly, from the queue, or by *Send now*): it joins the
   * running turn, or starts one, and is `working`.
   */
  delivered(r: { id: number; player: PlayerRef; text: string }): void {
    const e = this.known.get(r.id) ?? { id: r.id, player: r.player, text: r.text, state: "working" as const, calls: 0 };
    delete e.prompt;
    e.state = "working";
    e.deliveredAt = this.now();
    this.remember(e);
    if (!this.turn) {
      this.turn = { entries: [] };
      this.turnCtl = new AbortController();
    }
    this.turn.entries.push(e);
    this.status(e, true);
    this.touch();
    this.startTick();
  }

  /** Delivers queued prompts, oldest first, until one starts a turn (a refused one concludes and the next is tried). */
  private async next(): Promise<void> {
    if (this.delivering) return;
    this.delivering = true;
    try {
      while (!this.turn && this.queue.length) {
        const e = this.queue.shift()!;
        this.deliveringId = e.id;
        this.renumber(e.player);
        const why = await this.opts.deliver(e.prompt!).catch((err: Error) => {
          this.opts.log?.(`in-game request ${e.id}: delivery from the queue failed: ${err.message}`);
          return "no_listener" as const;
        });
        if (why) this.neverRan(e, why);
      }
    } finally {
      this.delivering = false;
      this.deliveringId = undefined;
    }
  }

  /** Concludes an entry that never ran (cancelled, or refused at delivery): a final `stopped` line, and the player is told why. */
  private neverRan(e: RequestEntry, why: "cancelled" | PromptRefusal): void {
    e.state = "stopped";
    e.never = why;
    delete e.prompt;
    this.status(e, true);
    if (why !== "cancelled") this.notice(e.player, `Autosketch: queued request ${e.id} couldn't be delivered (${why}).`);
  }

  /** Resends the queued lines of a player whose positions moved. */
  private renumber(player: PlayerRef): void {
    for (const e of this.queue) if (same(e.player, player)) this.status(e, true);
  }

  // -- turn ending ----------------------------------------------------------------------------

  /**
   * The session's call events: a `call.start` counts for the running requests; the idle fallback
   * restarts on each start and end and never fires while a call is in flight (a long `run_script`).
   */
  onEvent(e: ObserveEvent, doc?: string): void {
    if (e.kind === "doc.op") return this.recordEdit(e, doc);
    if (e.kind === "call.start") this.inFlight.add(e.call);
    else if (e.kind === "call.end") this.inFlight.delete(e.call);
    else return;
    if (!this.turn) return;
    if (e.kind === "call.start") for (const r of this.turn.entries) if (r.state === "working" || r.state === "stopping") r.calls++;
    this.touch();
  }

  /** A base-document journal entry committed: it is an edit of every request of the turn still running (not of a `world_sync`). */
  private recordEdit(e: Extract<ObserveEvent, { kind: "doc.op" }>, tag: string | undefined): void {
    if (tag !== "base" || !this.turn || isWorldSync(e)) return;
    const doc = this.opts.baseDoc?.();
    if (!doc) return;
    for (const r of this.turn.entries) {
      if (r.state !== "working" && r.state !== "stopping") continue;
      // A relink or another document mid-request: only the current document's entries can be undone.
      if (r.edits?.doc !== doc) r.edits = { doc, seqs: [] };
      r.edits.seqs.push(e.jseq);
    }
  }

  /** The hook reported the turn's end (`turn.end` on the observe bus). */
  turnEnded(): void {
    this.hookSeen = true;
    this.endTurn(false);
  }

  /**
   * The agent answered `request` with `world_reply done`: the fallback while no hook has reported
   * this session. Concludes that request; the turn ends once none in it is still running.
   */
  replyDone(request: number | undefined): void {
    if (this.hookSeen || !this.turn || request === undefined) return;
    const e = this.turn.entries.find((r) => r.id === request);
    if (!e || e.state !== "working") return;
    if (this.turn.entries.every((r) => r === e || (r.state !== "working" && r.state !== "stopping"))) return this.endTurn(true);
    this.conclude(e, true);
  }

  private conclude(e: RequestEntry, fallback: boolean): void {
    if (e.state === "working") {
      e.state = "done";
      if (fallback) e.noTurnSignal = true;
    } else if (e.state === "stopping") e.state = "stopped";
    else return;
    e.endedAt = this.now();
    this.status(e, true);
  }

  private endTurn(fallback: boolean): void {
    const t = this.turn;
    if (!t) return;
    this.turn = undefined;
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    this.stopTick();
    for (const e of t.entries) this.conclude(e, fallback);
    this.turnCtl = undefined;
    void this.next();
  }

  /** Restarts the idle fallback. */
  private touch(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (!this.turn || this.inFlight.size) return;
    this.idleTimer = setTimeout(() => {
      this.opts.log?.(`in-game requests: no tool call for ${this.opts.idleMs} ms, so the turn is taken as ended`);
      this.endTurn(true);
    }, this.opts.idleMs);
    this.idleTimer.unref?.();
  }

  // -- stop -----------------------------------------------------------------------------------

  /** Stops the running turn's requests; returns those that turned `stopping` (empty when none ran or all already were). */
  stop(): RequestEntry[] {
    const t = this.turn;
    if (!t) return [];
    const now = t.entries.filter((e) => e.state === "working");
    if (!now.length) return [];
    for (const e of now) {
      e.state = "stopping";
      this.status(e, true);
    }
    if (this.turnCtl && !this.turnCtl.signal.aborted) {
      this.turnCtl.abort(refusal("stopped", STOPPED_TEXT));
      this.opts.onStop?.();
    }
    return now;
  }

  /** The session call hook (`Session.callHooks`, installed first): refuses every call while stopping. */
  readonly callHook = {
    before: (_call: { tool: string }): void => {
      if (this.stopping) throw refusal("stopped", STOPPED_TEXT);
    },
  };

  // -- control --------------------------------------------------------------------------------

  /**
   * A server-side command (`request.control`, `13`): answered with a `notice` (stop, cancel) or a
   * `chat` reply listing the queue. The allowlist is checked by the caller.
   */
  control(m: RequestControl): void {
    const p = m.player;
    if (m.action === "stop") {
      const running = this.running.filter((e) => e.state === "working" || e.state === "stopping");
      if (!running.length) return this.notice(p, "Autosketch: no request is running.");
      const stopped = this.stop();
      const ids = (stopped.length ? stopped : running).map((e) => e.id);
      const what = `request${ids.length === 1 ? "" : "s"} ${list(ids)}`;
      return this.notice(p, stopped.length ? `Autosketch: stopping ${what}; the agent ends its turn at its next tool call.` : `Autosketch: ${what} ${ids.length === 1 ? "is" : "are"} already stopping; the agent ends its turn at its next tool call.`);
    }
    const mine = this.queue.filter((e) => same(e.player, p));
    if (m.action === "queue") {
      const head = this.running[0];
      const n = mine.length;
      const lines = n
        ? [`Queue: ${n} prompt${n === 1 ? "" : "s"}${head ? ` behind request ${head.id}` : ""}.`, ...mine.map((e, i) => `${i + 1}. ${JSON.stringify(short(e.text))}`)]
        : ["Queue: empty."];
      this.opts.bridge.send({ type: "chat", request: null, player: p.uuid, kind: "reply", lines } satisfies ChatMessage);
      return;
    }
    const pos = m.position ?? 0;
    const e = mine[pos - 1];
    if (!e) return this.notice(p, `Autosketch: no queued prompt ${pos}; /autosketch queue lists yours.`);
    this.cancel(e);
    this.notice(p, `Autosketch: cancelled queued prompt ${pos} (${JSON.stringify(short(e.text))}).`);
  }

  /**
   * A status line's button (`ui.request` `request.stop`, `queue.send`, `queue.cancel`; `13`,
   * *Request kinds*), and `request.undo` (step Q2).
   */
  async ui(kind: string, args: Record<string, unknown>): Promise<ControlAnswer> {
    const id = args.request;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) return { ok: false, error: "bad_request", message: "request must be a request id" };
    const e = this.known.get(id);
    if (!e) return { ok: false, error: "not_found", message: `No request ${id}.` };
    switch (kind) {
      case "request.stop":
        if (e.state === "queued") return { ok: false, error: "refused", message: `Request ${id} is queued, not running: cancel it instead.` };
        if (e.state === "done" || e.state === "stopped") return { ok: false, error: "answered", message: `Request ${id} has already ended.` };
        if (e.state === "working") this.stop();
        return { ok: true, result: { request: id, state: e.state } };
      case "queue.send": {
        if (e.state !== "queued") return { ok: false, error: "answered", message: `Request ${id} was already ${e.never === "cancelled" ? "cancelled" : "delivered"}.` };
        if (this.stopping) return { ok: false, error: "refused", message: `The running request is stopping; request ${id} is delivered when its turn ends.` };
        const into = this.turn?.entries[0]?.id ?? id;
        this.queue.splice(this.queue.indexOf(e), 1);
        this.renumber(e.player);
        const why = await this.opts.deliver(e.prompt!);
        if (why) {
          this.neverRan(e, why);
          return { ok: false, error: "refused", message: `Request ${id} couldn't be delivered (${why}).` };
        }
        return { ok: true, result: { request: id, into } };
      }
      case "request.undo":
        return this.undoRequest(e);
      case "queue.cancel":
        if (e.state !== "queued") return { ok: false, error: "answered", message: `Request ${id} was already ${e.never === "cancelled" ? "cancelled" : "delivered"}.` };
        this.cancel(e);
        return { ok: true, result: { request: id } };
      default:
        return { ok: false, error: "bad_request", message: `Unknown request-control kind "${kind}".` };
    }
  }

  /**
   * `[Undo request]` (`19`, *Stop*, step 5): a concluded request's edits undone as one step.
   * Refused while it or any request runs, or is queued (as Claude Code can't rewind a turn while it
   * works); `answered` once undone or when it made no edits.
   */
  private async undoRequest(e: RequestEntry): Promise<ControlAnswer> {
    const id = e.id;
    if (!this.opts.undo) return { ok: false, error: "bad_request", message: "This Autosketch doesn't serve request.undo." };
    if (e.state === "queued") return { ok: false, error: "refused", message: `Request ${id} is queued and hasn't run, so it has no edits to undo.` };
    if (e.state === "working" || e.state === "stopping") return { ok: false, error: "refused", message: `Request ${id} is still ${e.state}; it can be undone once its turn ends.` };
    if (e.undone !== undefined) return { ok: false, error: "answered", message: `Request ${id} was already undone (${e.undone} entr${e.undone === 1 ? "y" : "ies"}).` };
    const busy = this.turn?.entries.find((r) => r.state === "working" || r.state === "stopping");
    if (busy || this.delivering) return { ok: false, error: "refused", message: `Request ${busy?.id ?? this.deliveringId ?? "?"} is running; request ${id} can be undone once its turn ends.` };
    if (!e.edits?.seqs.length) return { ok: false, error: "answered", message: e.never ? `Request ${id} never ran, so it made no edits.` : `Request ${id} made no edits.` };
    const r = await this.opts.undo(id, e.edits);
    if (!r.ok) return r;
    e.undone = r.entries;
    this.status(e, true);
    return { ok: true, result: { request: id, entries: r.entries } };
  }

  private cancel(e: RequestEntry): void {
    this.queue.splice(this.queue.indexOf(e), 1);
    this.neverRan(e, "cancelled");
    this.renumber(e.player);
  }

  /** The game disconnected: the queue is dropped (`19`, *Queueing*). A running turn keeps going. */
  disconnected(): void {
    for (const e of this.queue) {
      e.state = "stopped";
      e.never = "cancelled";
      delete e.prompt;
    }
    this.queue = [];
  }

  close(): void {
    clearTimeout(this.idleTimer);
    this.stopTick();
  }

  // -- status lines ---------------------------------------------------------------------------

  private remember(e: RequestEntry): void {
    this.known.delete(e.id);
    this.known.set(e.id, e);
    if (this.known.size > KNOWN_MAX) {
      for (const [id, old] of this.known) {
        if (this.known.size <= KNOWN_MAX) break;
        if (old.state === "done" || old.state === "stopped") this.known.delete(id);
      }
    }
  }

  private position(e: RequestEntry): number | undefined {
    if (e.state !== "queued") return undefined;
    return this.queue.filter((q) => same(q.player, e.player)).indexOf(e) + 1;
  }

  /** The status message for an entry now (`13`, `chat` kind `status`). */
  statusOf(e: RequestEntry): StatusMessage {
    const now = this.now();
    const elapsedMs = e.deliveredAt === undefined ? 0 : Math.max(0, (e.endedAt ?? now) - e.deliveredAt);
    const pos = this.position(e);
    const text = short(e.text);
    return {
      type: "chat",
      request: e.id,
      player: e.player.uuid,
      kind: "status",
      lines: [statusLine(e, text, elapsedMs, pos)],
      state: e.state,
      text,
      calls: e.calls,
      elapsedMs,
      ...(pos !== undefined ? { queuePos: pos } : {}),
      ...(e.state === "done" && e.noTurnSignal ? { noTurnSignal: true as const } : {}),
      actions: actionsOf(e),
    };
  }

  /**
   * Sends an entry's status: at once when `force` (a state or position change), otherwise only when
   * its counts moved and `statusMs` has passed. Without `requests`, a plain activity line on each
   * change of state (running, done, stopped) instead.
   */
  private status(e: RequestEntry, force: boolean): void {
    const m = this.statusOf(e);
    const sec = Math.floor(m.elapsedMs / 1000);
    const last = e.sent;
    const now = this.now();
    if (!this.opts.bridge.requests) {
      if (last?.state === e.state || e.state === "queued" || e.state === "stopping") return;
      e.sent = { state: e.state, calls: e.calls, sec, pos: undefined, at: now };
      this.opts.bridge.send({ type: "chat", request: e.id, player: e.player.uuid, kind: "activity", lines: m.lines } satisfies ChatMessage);
      return;
    }
    if (last && last.state === e.state && last.pos === m.queuePos) {
      if (!force && last.calls === e.calls && last.sec === sec) return;
      if (!force && now - last.at < (this.opts.statusMs ?? STATUS_INTERVAL_MS)) return;
    }
    e.sent = { state: e.state, calls: e.calls, sec, pos: m.queuePos, at: now };
    this.opts.bridge.send(m);
  }

  private startTick(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      for (const e of this.running) if (e.state === "working" || e.state === "stopping") this.status(e, false);
    }, this.opts.statusMs ?? STATUS_INTERVAL_MS);
    this.tickTimer.unref?.();
  }

  private stopTick(): void {
    clearInterval(this.tickTimer);
    this.tickTimer = undefined;
  }

  private notice(p: PlayerRef, text: string): void {
    this.opts.bridge.send({ type: "notice", text, player: p.uuid } satisfies NoticeMessage);
  }
}

// -- helpers --------------------------------------------------------------------------------------

const same = (a: PlayerRef, b: PlayerRef) => a.uuid.toLowerCase() === b.uuid.toLowerCase();
const list = (ids: number[]) => (ids.length === 1 ? String(ids[0]) : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`);

/** A prompt's text for a status line: one line, at most `STATUS_TEXT_MAX` characters. */
export function short(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > STATUS_TEXT_MAX ? `${t.slice(0, STATUS_TEXT_MAX - 1)}…` : t;
}

/** `0:42`, `2:10`, `1:02:03`. */
export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const ss = String(r).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The plain text of a status line (`19`, *Status line*; the vectors' shapes). */
export function statusLine(e: Pick<RequestEntry, "state" | "calls" | "noTurnSignal" | "never" | "undone">, text: string, elapsedMs: number, pos: number | undefined): string {
  const t = JSON.stringify(text);
  const counts = `${e.calls} call${e.calls === 1 ? "" : "s"} · ${elapsed(elapsedMs)}${e.undone !== undefined ? ` · undone (${e.undone} entr${e.undone === 1 ? "y" : "ies"})` : ""}`;
  switch (e.state) {
    case "queued":
      return `⧗ Queued ${pos ?? ""} · ${t}`.replace("Queued  ·", "Queued ·");
    case "working":
      return `⏳ Working · ${t} · ${counts}`;
    case "stopping":
      return `■ Stopping… · ${t} · ${counts}`;
    case "done":
      return `✔ Done${e.noTurnSignal ? " (no turn signal)" : ""} · ${t} · ${counts}`;
    case "stopped":
      if (e.never === "cancelled") return `■ Cancelled · ${t}`;
      if (e.never) return `■ Not delivered (${e.never}) · ${t}`;
      return `■ Stopped · ${t} · ${counts}`;
  }
}

/**
 * The buttons of a state (`13`): Stop while working; Send now and Cancel while queued; Undo request
 * on a stopped request that made edits and isn't undone yet (`19`, *Stop*, step 5).
 */
function actionsOf(e: RequestEntry): StatusAction[] {
  const args = { request: e.id };
  if (e.state === "working") return [{ label: "Stop", kind: "request.stop", args }];
  if (e.state === "stopped" && !e.never && e.undone === undefined && e.edits?.seqs.length) return [{ label: "Undo request", kind: "request.undo", args }];
  if (e.state === "queued")
    return [
      { label: "Send now", kind: "queue.send", args },
      { label: "Cancel", kind: "queue.cancel", args },
    ];
  return [];
}

/**
 * The world view's and select's bridge, with reads that a stop cancels (`19`, *Stop*, step 2): a
 * `search`, `fill`, `expand` or `snapshot` in flight when the player stops rejects at once with
 * `stopped` (the mod's late answer is dropped), and one sent while stopping is refused unsent.
 * Anything else (`volumes.set`) passes through: it changes the world's volumes, so it is awaited.
 */
export function stoppableReads<B extends Pick<BridgeConnection, "request" | "connected"> & Partial<Pick<BridgeConnection, "on">>>(bridge: B, signal: () => AbortSignal | undefined): B {
  const reads = new Set(["search", "fill", "expand", "snapshot"]);
  const request = ((m: { type: string }) => {
    const s = reads.has(m.type) ? signal() : undefined;
    if (s?.aborted) return Promise.reject(s.reason as Error);
    const p = (bridge.request as (m: unknown) => Promise<unknown>)(m);
    if (!s) return p;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = () => reject(s.reason as Error);
      s.addEventListener("abort", onAbort, { once: true });
      p.then(
        (v) => {
          s.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e: unknown) => {
          s.removeEventListener("abort", onAbort);
          reject(e as Error);
        },
      );
    });
  }) as B["request"];
  return new Proxy(bridge, {
    get(target, key, receiver) {
      if (key === "request") return request;
      const v = Reflect.get(target, key, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** `patch.drop` (`13`): sent on a stop to a mod whose hello lists `requests`. */
export const PATCH_DROP: PatchDrop = { type: "patch.drop" };
