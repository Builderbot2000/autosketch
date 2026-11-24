import type { LoggedEvent } from "../core/events.js";
import type { Mask } from "../core/mask.js";
import type { PublicBox } from "../core/region.js";
import { SessionModel, type Scope } from "../observe/session-model.js";
import type { BridgeConnection } from "../world/bridge.js";
import { CANDIDATE_FILL, SAVE_FLASH_COLOUR, SAVE_FLASH_JOB, UI_COALESCE_MS, UI_FLASH_BOXES, type UiFill, type UiFlash, type UiJob, type UiRefusal, type UiRequestInfo, type UiState, type UiTokens, type WireBox } from "../world/protocol/messages.js";
import { mergeBoxes, translatePublic } from "./boxes.js";
import { CANDIDATE_COLOUR, candidateFill } from "./candidate-outline.js";
import { jobColour } from "./colours.js";
import { toWorldBox, type WorldFrame } from "./frame.js";

/**
 * The overlay feed (docs/design/16-in-game-ui.md, *MCP side*, Feed; `13`, *In-game UI*): keeps the
 * session model from the event bus and sends `ui.state` (full on connect and to a player that asks
 * for `resync`, changes after) and `ui.flash`, at most one of each per 250 ms window. The select
 * candidate (`18`, piece 8) rides along as the `candidate` fill record, and proposed hits as flash
 * records with job `candidate`.
 *
 * Off the tool-call path (`16`, *Principles* 5): the bus subscriber only applies the event to the
 * model and remembers the changed box, both O(1). Everything sent is built on a timer, and only
 * while a mod with `ui` is connected; `send` hands the frame to the socket and never waits for it.
 */

export interface FeedHost {
  readonly bridge: Pick<BridgeConnection, "send" | "ui" | "onConnection">;
  /** Where the base document is in the world, or undefined (unlinked and not anchored: jobs and flashes can't be placed). */
  frame(): WorldFrame | undefined;
  /** True while the base document is linked (`17`, piece 8: only a linked save flashes). Default: never. */
  linked?(): boolean;
  /** The overlay player set (`UiPlayers.overlay`). */
  players(): string[];
  /** The open in-game request, or null. */
  request(): UiRequestInfo | null;
  /**
   * The select candidate (`18`, piece 8): the world view's `candidate` while its request holds, or
   * undefined. `key` changes exactly when the shape does (the stored selection's identity), so the
   * shell is computed once per fill or expand, on the timer; `mask` is in world coordinates.
   */
  candidate?(): { key: unknown; dimension: string; mask(): Mask } | undefined;
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
  /** Fill records by id, compared by identity (a candidate's record is only rebuilt when its shape changes). */
  fills: Map<string, UiFill>;
}

interface Snapshot {
  jobs: UiJob[];
  fills: UiFill[];
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
  /** The candidate's fill record and the shape key it was built from. */
  private fill?: { key: unknown; dimension: string; record: UiFill };
  /** Proposed hits to pulse in the next window, world boxes per dimension (`18`, piece 8). */
  private hits: { dimension: string; boxes: WireBox[] }[] = [];

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

  /**
   * The save flash (docs/design/17-reusable-components.md, piece 8; `13`, *Save flash*): `box`, local
   * to `doc` ("base" or a scope id), goes out in the next window's `ui.flash` as a Flash record with
   * job {@link SAVE_FLASH_JOB} in {@link SAVE_FLASH_COLOUR}, beside any job's records. Only while the
   * base document is linked (an anchored unlinked document sends nothing) and a mod with `ui` is
   * connected. It is not an event, so the session log, and replay frames built from it, never carry it.
   */
  saveFlash(box: PublicBox, doc = "base"): void {
    if (!this.timer || !this.host.linked?.()) return;
    const b = doc === "base" ? box : this.inBase(doc, box);
    if (!b) return;
    let list = this.pending.get(SAVE_FLASH_JOB);
    if (!list) this.pending.set(SAVE_FLASH_JOB, (list = []));
    list.push(b);
    if (list.length > PENDING_CAP) this.pending.set(SAVE_FLASH_JOB, mergeBoxes(list, UI_FLASH_BOXES));
  }

  /**
   * Proposed hits (`18`, piece 8; `13`, *In-game UI*, Fill): world boxes the agent offered as choices
   * go out in the next window's `ui.flash` as one record with job {@link CANDIDATE_FILL} in the
   * candidate's colour (at most {@link UI_FLASH_BOXES}, merged past it). World coordinates, so no
   * link or anchor is needed. False when nothing can be shown (no mod with `ui` connected).
   */
  pulseHits(boxes: readonly WireBox[], dimension: string): boolean {
    if (!this.timer || !boxes.length) return false;
    this.hits.push({ dimension, boxes: [...boxes] });
    return true;
  }

  /** Sends what changed since the last window: a `ui.state` if anything did, then a `ui.flash`. */
  tick(): void {
    if (!this.host.bridge.ui) return;
    const players = this.host.players();
    const frame = this.host.frame();
    if (!players.length) {
      this.pending.clear();
      this.hits = [];
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
    const flashes: UiFlash[] = [];
    if (frame)
      for (const [job, boxes] of this.pending)
        flashes.push({ job, colour: job === SAVE_FLASH_JOB ? SAVE_FLASH_COLOUR : jobColour(job), dimension: frame.dimension, boxes: mergeBoxes(boxes, UI_FLASH_BOXES).map((b) => toWorldBox(frame, b)) });
    for (const h of this.hits) flashes.push({ job: CANDIDATE_FILL, colour: CANDIDATE_COLOUR, dimension: h.dimension, boxes: h.boxes.length > UI_FLASH_BOXES ? mergeBoxes(h.boxes, UI_FLASH_BOXES) : h.boxes });
    if (flashes.length) this.host.bridge.send({ type: "ui.flash", players, flashes });
    this.pending.clear();
    this.hits = [];
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
    this.hits = [];
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.host.intervalMs ?? UI_COALESCE_MS);
    this.timer.unref?.();
    this.tick();
  }

  private down(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.hits = [];
  }

  /** A sandbox-local box in the base document's frame (the fork's translation). */
  private inBase(doc: string, box: PublicBox): PublicBox | undefined {
    const t = this.model.scopes.get(doc)?.translation;
    return t ? translatePublic(box, t) : undefined;
  }

  private sendFull(players: string[], s: Snapshot, seq: number): void {
    this.host.bridge.send({ type: "ui.state", players, seq, full: true, jobs: s.jobs, request: s.request, tokens: s.tokens, refusal: s.refusal, ...(s.fills.length ? { fills: s.fills } : {}) });
  }

  /** The candidate's fill record, rebuilt only when the shape changed; none while there is no candidate or it is empty. */
  private candidateFills(): UiFill[] {
    const c = this.host.candidate?.();
    if (!c) {
      this.fill = undefined;
      return [];
    }
    if (!this.fill || this.fill.key !== c.key || this.fill.dimension !== c.dimension) {
      const mask = c.mask();
      this.fill = { key: c.key, dimension: c.dimension, record: candidateFill(mask, c.dimension) };
    }
    return this.fill.record.faces.length ? [this.fill.record] : [];
  }

  private snapshot(frame: WorldFrame | undefined): Snapshot {
    return {
      jobs: frame ? this.model.openScopes().flatMap((s) => (s.work ? [uiJob(s, frame)] : [])) : [],
      fills: this.candidateFills(),
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
    const fills = s.fills.filter((f) => sent.fills.get(f.id) !== f);
    const fillIds = new Set(s.fills.map((f) => f.id));
    const fillsRemoved = [...sent.fills.keys()].filter((id) => !fillIds.has(id));
    if (fills.length) out.fills = fills;
    if (fillsRemoved.length) out.fillsRemoved = fillsRemoved;
    return Object.keys(out).length ? out : undefined;
  }
}

function remember(players: string, s: Snapshot): Sent {
  return { players, jobs: new Map(s.jobs.map((j) => [j.id, JSON.stringify(j)])), request: JSON.stringify(s.request), tokens: JSON.stringify(s.tokens), refusal: JSON.stringify(s.refusal), fills: new Map(s.fills.map((f) => [f.id, f])) };
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
