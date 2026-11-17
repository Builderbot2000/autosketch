import type { LoggedEvent } from "../core/events.js";
import type { PublicBox } from "../core/region.js";
import { SessionModel, type Scope } from "../observe/session-model.js";
import type { BridgeConnection } from "../world/bridge.js";
import { UI_COALESCE_MS, UI_FLASH_BOXES, type UiFlash, type UiJob, type UiRefusal, type UiRequestInfo, type UiState, type UiTokens } from "../world/protocol/messages.js";
import { mergeBoxes, translatePublic } from "./boxes.js";
import { jobColour } from "./colours.js";
import { toWorldBox, type WorldFrame } from "./frame.js";

/**
 * The overlay feed (docs/design/16-in-game-ui.md, *MCP side*, Feed; `13`, *In-game UI*): keeps the
 * session model from the event bus and sends `ui.state` (full on connect and to a player that asks
 * for `resync`, changes after) and `ui.flash`, at most one of each per 250 ms window.
 *
 * Off the tool-call path (`16`, *Principles* 5): the bus subscriber only applies the event to the
 * model and remembers the changed box, both O(1). Everything sent is built on a timer, and only
 * while a mod with `ui` is connected; `send` hands the frame to the socket and never waits for it.
 */

export interface FeedHost {
  readonly bridge: Pick<BridgeConnection, "send" | "ui" | "onConnection">;
  /** Where the base document is in the world, or undefined (unlinked and not anchored: jobs and flashes can't be placed). */
  frame(): WorldFrame | undefined;
  /** The overlay player set (`UiPlayers.overlay`). */
  players(): string[];
  /** The open in-game request, or null. */
  request(): UiRequestInfo | null;
  /** Window override for tests (default `UI_COALESCE_MS`). */
  intervalMs?: number;
}

/** What the client holds after the last broadcast `ui.state`. */
interface Sent {
  players: string;
  jobs: Map<string, string>;
  request: string;
  tokens: string;
  refusal: string;
}

interface Snapshot {
  jobs: UiJob[];
  request: UiRequestInfo | null;
  tokens: UiTokens | null;
  refusal: UiRefusal | null;
}

/** Pending flash boxes per job before they are pre-merged (bounds memory between ticks). */
const PENDING_CAP = 1024;

export class UiFeed {
  readonly model = new SessionModel();
  /** The `seq` of the last broadcast `ui.state` on this connection (0: none yet). */
  private seq = 0;
  private sent?: Sent;
  /** Changed boxes per job since the last flash, base-document-local. */
  private pending = new Map<string, PublicBox[]>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly host: FeedHost) {
    this.offs.push(host.bridge.onConnection((s) => (s === "up" ? this.up() : this.down())));
    if (host.bridge.ui) this.up();
  }

  /** The bus subscriber. Cheap by contract (`observe/bus.ts`). */
  readonly onEvent = (e: LoggedEvent): void => {
    this.model.apply(e);
    if (!this.timer || (e.kind !== "doc.op" && e.kind !== "doc.undo" && e.kind !== "doc.redo") || !e.box) return;
    const box = e.doc === "base" ? e.box : this.inBase(e.doc, e.box);
    if (!box) return;
    let list = this.pending.get(e.doc);
    if (!list) this.pending.set(e.doc, (list = []));
    list.push(box);
    if (list.length > PENDING_CAP) this.pending.set(e.doc, mergeBoxes(list, UI_FLASH_BOXES));
  };

  /** Sends what changed since the last window: a `ui.state` if anything did, then a `ui.flash`. */
  tick(): void {
    if (!this.host.bridge.ui) return;
    const players = this.host.players();
    const frame = this.host.frame();
    if (!players.length) {
      this.pending.clear();
      return;
    }
    const snap = this.snapshot(frame);
    const key = players.join(",");
    if (!this.sent || this.sent.players !== key) this.sendFull(players, snap, ++this.seq);
    else {
      const m = this.changes(this.sent, snap);
      if (m) this.host.bridge.send({ type: "ui.state", players, seq: ++this.seq, full: false, ...m });
    }
    this.sent = remember(key, snap);
    if (this.pending.size && frame) {
      const flashes: UiFlash[] = [];
      for (const [job, boxes] of this.pending)
        flashes.push({ job, colour: jobColour(job), dimension: frame.dimension, boxes: mergeBoxes(boxes, UI_FLASH_BOXES).map((b) => toWorldBox(frame, b)) });
      this.host.bridge.send({ type: "ui.flash", players, flashes });
    }
    this.pending.clear();
  }

  /**
   * A player's `resync` (*Sequence and resync*): everyone first gets what changed (so the state is
   * current), then this player alone gets the whole state under the current `seq`.
   */
  resync(player: string): void {
    if (!this.host.bridge.ui) return;
    this.tick();
    const snap = this.snapshot(this.host.frame());
    if (this.seq === 0) this.seq = 1; // nothing broadcast yet (no overlay players): this full state starts the count
    this.sendFull([player], snap, this.seq);
  }

  close(): void {
    this.down();
    for (const off of this.offs.splice(0)) off();
  }

  // -- internals ------------------------------------------------------------------------------

  private up(): void {
    if (!this.host.bridge.ui) return;
    this.seq = 0;
    this.sent = undefined;
    this.pending.clear();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.host.intervalMs ?? UI_COALESCE_MS);
    this.timer.unref?.();
    this.tick();
  }

  private down(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  /** A sandbox-local box in the base document's frame (the fork's translation). */
  private inBase(doc: string, box: PublicBox): PublicBox | undefined {
    const t = this.model.scopes.get(doc)?.translation;
    return t ? translatePublic(box, t) : undefined;
  }

  private sendFull(players: string[], s: Snapshot, seq: number): void {
    this.host.bridge.send({ type: "ui.state", players, seq, full: true, jobs: s.jobs, request: s.request, tokens: s.tokens, refusal: s.refusal });
  }

  private snapshot(frame: WorldFrame | undefined): Snapshot {
    return {
      jobs: frame ? this.model.openScopes().flatMap((s) => (s.work ? [uiJob(s, frame)] : [])) : [],
      request: this.host.request(),
      tokens: tokensOf(this.model),
      refusal: refusalOf(this.model),
    };
  }

  private changes(sent: Sent, s: Snapshot): Omit<UiState, "type" | "players" | "seq" | "full"> | undefined {
    const out: Omit<UiState, "type" | "players" | "seq" | "full"> = {};
    const jobs = s.jobs.filter((j) => sent.jobs.get(j.id) !== JSON.stringify(j));
    const ids = new Set(s.jobs.map((j) => j.id));
    const removed = [...sent.jobs.keys()].filter((id) => !ids.has(id));
    if (jobs.length) out.jobs = jobs;
    if (removed.length) out.removed = removed;
    if (JSON.stringify(s.request) !== sent.request) out.request = s.request;
    if (JSON.stringify(s.tokens) !== sent.tokens) out.tokens = s.tokens;
    if (JSON.stringify(s.refusal) !== sent.refusal) out.refusal = s.refusal;
    return Object.keys(out).length ? out : undefined;
  }
}

function remember(players: string, s: Snapshot): Sent {
  return { players, jobs: new Map(s.jobs.map((j) => [j.id, JSON.stringify(j)])), request: JSON.stringify(s.request), tokens: JSON.stringify(s.tokens), refusal: JSON.stringify(s.refusal) };
}

/** A job record from an open scope (its work and context are in the base frame, from `scope.fork`). */
export function uiJob(s: Scope, frame: WorldFrame): UiJob {
  return {
    id: s.id,
    colour: jobColour(s.id),
    brief: s.brief,
    dimension: frame.dimension,
    work: toWorldBox(frame, s.work!),
    context: s.context ? [toWorldBox(frame, s.context)] : [],
  };
}

/** Token totals of the newest prompt Claude Code reported (`13`, B3), or null before any figures. */
export function tokensOf(m: SessionModel): UiTokens | null {
  const p = m.spend.promptList()[0];
  if (!p || !p.tokens.requests) return null;
  const t = p.tokens;
  return { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreation: t.cacheWrite, ...(t.cost ? { cost: t.cost } : {}) };
}

/** The last refusal as one line, or null. */
export function refusalOf(m: SessionModel): UiRefusal | null {
  const r = m.refusals[m.refusals.length - 1];
  if (!r) return null;
  const line = `${r.tool}: ${r.message.split("\n")[0] ?? ""}`;
  return { code: r.code, text: line.length > 200 ? line.slice(0, 199) + "…" : line };
}
