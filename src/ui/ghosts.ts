import type { LoggedEvent } from "../core/events.js";
import type { Mask } from "../core/mask.js";
import type { PublicBox, Vec3 } from "../core/region.js";
import type { Document } from "../document/document.js";
import type { BridgeConnection } from "../world/bridge.js";
import { CANDIDATE_GHOST, UI_COALESCE_MS, type UiGhost, type UiGhostSection } from "../world/protocol/messages.js";
import { jobColour } from "./colours.js";
import { sameFrame, toWorld, type WorldFrame } from "./frame.js";

/**
 * Ghost regions (docs/design/16-in-game-ui.md, *MCP side*, Ghosts; `13`, *In-game UI*, `ui.ghost`):
 *
 * - **Sandbox preview.** One ghost per open job, id the job's scope id: the positions of its work
 *   volume where the sandbox differs from the base document, i.e. the blocks that land on merge
 *   (positions equal to the base would draw over themselves). The ghost's local grid is the
 *   sandbox's own frame, so `origin` is the world position of sandbox (0,0,0). Cleared on merge or
 *   abandon.
 * - **Anchored document.** An unlinked base document drawn at an anchor the player chose
 *   (`ghost.anchor`): its blocks, the anchor taking the place of the document's minimum corner.
 *   Its local grid is the base document's frame, so the anchor also places the jobs (`frame`).
 * - **Candidate.** One prefab the player previews from the candidates screen (`17`, piece 3;
 *   `candidates.ghost`), id `candidate`: its blocks, already oriented, at a world position of its
 *   own, so it needs neither a link nor an anchor. A new one replaces it; it is fixed (no deltas),
 *   and forgotten with a lost connection, as the anchor is.
 *
 * Updates come from `doc.op`, `doc.undo` and `doc.redo` boxes: the sections they touch are rebuilt
 * from the document on the next window (250 ms) and sent whole, one `ui.ghost` per ghost.
 */

/** An open job as the ghosts read it (structurally `scope/scopes.ts`'s `Scope`). */
export interface GhostScope {
  doc: Document;
  workLocal: Mask;
}

export interface GhostHost {
  readonly bridge: Pick<BridgeConnection, "send" | "ui" | "onConnection">;
  /** The link's frame while the base document is linked, else undefined. */
  linkFrame(): WorldFrame | undefined;
  players(): string[];
  baseDoc(): Document | undefined;
  /** An open job by scope id. */
  scope(id: string): GhostScope | undefined;
  /** Base-local position of the job's sandbox (0,0,0) (`ScopeManager.baseOffset`). */
  baseOffset(id: string): Vec3;
  /** Open job ids, oldest first. */
  scopeIds(): string[];
  intervalMs?: number;
}

/**
 * The candidate ghost's blocks (`candidates.ghost`): `size` blocks from its world `origin`, palette
 * indices x fastest, then z, then y; index 0 is air.
 */
export interface CandidateBlocks {
  dimension: string;
  /** World position of the ghost's (0,0,0). */
  origin: Vec3;
  size: Vec3;
  palette: string[];
  blocks: Uint32Array;
}

/** The id of the anchored document's ghost. */
export const DOC_GHOST = "doc";
const AIR = "minecraft:air";
const DOC_TINT = "#ffffff";

const secKey = (s: Vec3) => `${s[0]},${s[1]},${s[2]}`;
const keyVec = (k: string) => k.split(",").map(Number) as Vec3;
const bySection = (a: Vec3, b: Vec3) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0];

export class GhostRegions {
  /** The anchored document's frame, while one is set. */
  anchor?: WorldFrame;
  /** The candidate ghost, while one is shown. */
  private candidate?: CandidateBlocks;
  /** Sections to resend per ghost (local section keys); "full" for a whole resend. */
  private dirty = new Map<string, Set<string> | "full">();
  /** Ghosts the client holds (sent, not cleared), with the frame they were sent in. */
  private shown = new Map<string, WorldFrame>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly host: GhostHost) {
    this.offs.push(host.bridge.onConnection((s) => (s === "up" ? this.up() : this.down())));
    if (host.bridge.ui) this.up();
  }

  /** The frame jobs and flashes are placed in: the link's, else the anchor's. */
  frame(): WorldFrame | undefined {
    return this.host.linkFrame() ?? this.anchor;
  }

  /**
   * Anchors the unlinked base document with its minimum corner at `pos` (world) and sends its
   * ghost whole at once. Returns the ghost id, or undefined when there is no document.
   */
  anchorAt(dimension: string, pos: Vec3, players: string[] = this.host.players()): string | undefined {
    const doc = this.host.baseDoc();
    if (!doc) return undefined;
    const min = doc.localBounds()?.min ?? [0, 0, 0];
    this.anchor = { dimension, origin: [pos[0] - min[0], pos[1] - min[1], pos[2] - min[2]] };
    this.dirty.delete(DOC_GHOST);
    this.sendGhost(DOC_GHOST, players, true);
    return DOC_GHOST;
  }

  /** Removes a ghost: the anchored document's (`ghost.clear`), or a job's. False when no such ghost. */
  clear(id: string): boolean {
    if (id === DOC_GHOST) {
      if (!this.anchor) return false;
      this.anchor = undefined;
    } else if (!this.host.scope(id)) return false;
    this.dirty.delete(id);
    this.sendClear(id);
    return true;
  }

  /** Shows `c` as the candidate ghost, whole, replacing any earlier one (`candidates.ghost`). */
  showCandidate(c: CandidateBlocks, players: string[] = this.host.players()): void {
    this.candidate = c;
    this.sendGhost(CANDIDATE_GHOST, players, true);
  }

  /** Removes the candidate ghost (`candidates.ghost.clear`). False when none is shown. */
  clearCandidate(): boolean {
    if (!this.candidate) return false;
    this.candidate = undefined;
    this.sendClear(CANDIDATE_GHOST);
    return true;
  }

  /** The bus subscriber: marks touched sections, clears ghosts of ended jobs. Cheap. */
  readonly onEvent = (e: LoggedEvent): void => {
    if (!this.timer) return;
    switch (e.kind) {
      case "scope.fork":
        this.dirty.set(e.scope, "full");
        break;
      case "scope.merge":
      case "scope.abandon":
        this.dirty.delete(e.scope);
        if (this.shown.has(e.scope)) this.sendClear(e.scope);
        break;
      case "doc.op":
      case "doc.undo":
      case "doc.redo": {
        const id = e.doc === "base" ? DOC_GHOST : e.doc;
        if (id === DOC_GHOST && !this.anchor) break;
        if (!e.box || e.shift) {
          this.dirty.set(id, "full");
          break;
        }
        let d = this.dirty.get(id);
        if (d === "full") break;
        if (!d) this.dirty.set(id, (d = new Set()));
        forSections(e.box, (s) => d.add(secKey(s)));
        break;
      }
    }
  };

  /** Sends one `ui.ghost` per ghost touched in the window. */
  tick(): void {
    if (!this.host.bridge.ui) return;
    const players = this.host.players();
    if (!players.length) return;
    const frame = this.frame();
    // A moved frame (relink, new anchor): every ghost again at its new place.
    for (const [id, f] of this.shown) if (!sameFrame(f, this.frameOf(id))) this.dirty.set(id, "full");
    if (!frame) {
      this.dirty.clear();
      return;
    }
    const work = [...this.dirty];
    this.dirty.clear();
    for (const [id, d] of work) {
      if (id === CANDIDATE_GHOST) continue;
      if (id !== DOC_GHOST && !this.host.scope(id)) continue;
      if (id === DOC_GHOST && !this.anchor) continue;
      this.sendGhost(id, players, d === "full" || !this.shown.has(id), d === "full" ? undefined : [...d].map(keyVec));
    }
  }

  /** Every open ghost, whole, to these players (a `resync`). */
  resync(players: string[]): void {
    if (!this.host.bridge.ui) return;
    if (this.candidate) this.sendGhost(CANDIDATE_GHOST, players, true);
    if (!this.frame()) return;
    for (const id of this.host.scopeIds()) this.sendGhost(id, players, true);
    if (this.anchor) this.sendGhost(DOC_GHOST, players, true);
  }

  close(): void {
    this.down();
    for (const off of this.offs.splice(0)) off();
  }

  // -- building -------------------------------------------------------------------------------

  /** Builds one ghost message: whole (the non-empty sections) or the listed sections. */
  build(id: string, players: string[], full: boolean, sections?: Vec3[]): UiGhost | undefined {
    const frame = this.frameOf(id);
    if (!frame) return undefined;
    const src = this.source(id);
    if (!src) return undefined;
    const list = full ? src.sections() : sections ?? [];
    const palette = [AIR];
    const index = new Map<string, number>([[AIR, 0]]);
    const out: UiGhostSection[] = [];
    for (const s of list.sort(bySection)) {
      const states = new Uint32Array(4096);
      let any = false;
      for (let y = 0; y < 16; y++)
        for (let z = 0; z < 16; z++)
          for (let x = 0; x < 16; x++) {
            const st = src.state(s[0] * 16 + x, s[1] * 16 + y, s[2] * 16 + z);
            if (st === AIR) continue;
            let i = index.get(st);
            if (i === undefined) index.set(st, (i = palette.push(st) - 1));
            states[(y << 8) | (z << 4) | x] = i;
            any = true;
          }
      if (any || !full) out.push({ section: s, states });
    }
    return { type: "ui.ghost", players, ghost: id, dimension: frame.dimension, origin: toWorld(frame, src.offset), tint: id === DOC_GHOST || id === CANDIDATE_GHOST ? DOC_TINT : jobColour(id), full, palette, sections: out };
  }

  // -- internals ------------------------------------------------------------------------------

  private frameOf(id: string): WorldFrame | undefined {
    if (id === CANDIDATE_GHOST) return this.candidate && { dimension: this.candidate.dimension, origin: this.candidate.origin };
    return id === DOC_GHOST ? this.anchor : this.frame();
  }

  /** What a ghost draws: its state at a ghost-local position, the sections worth sending, its base-local offset. */
  private source(id: string): { state: (x: number, y: number, z: number) => string; sections: () => Vec3[]; offset: Vec3 } | undefined {
    if (id === CANDIDATE_GHOST) {
      const c = this.candidate;
      if (!c) return undefined;
      const [w, h, l] = c.size;
      return {
        offset: [0, 0, 0],
        state: (x, y, z) => (x < w && y < h && z < l ? c.palette[c.blocks[x + z * w + y * w * l]!] ?? AIR : AIR),
        sections: () => (w && h && l ? sectionsOf({ min: [0, 0, 0], max: [w - 1, h - 1, l - 1] }) : []),
      };
    }
    if (id === DOC_GHOST) {
      const doc = this.host.baseDoc();
      if (!doc) return undefined;
      return {
        offset: [0, 0, 0],
        state: (x, y, z) => doc.getState(x, y, z),
        sections: () => {
          const b = doc.localBounds();
          return b ? sectionsOf({ min: b.min, max: [b.max[0] - 1, b.max[1] - 1, b.max[2] - 1] }) : [];
        },
      };
    }
    const s = this.host.scope(id);
    const base = this.host.baseDoc();
    if (!s || !base) return undefined;
    const o = this.host.baseOffset(id);
    return {
      offset: o,
      state: (x, y, z) => {
        if (!s.workLocal.has(x, y, z)) return AIR;
        const st = s.doc.getState(x, y, z);
        return st === base.getState(x + o[0], y + o[1], z + o[2]) ? AIR : st;
      },
      sections: () => {
        const b = s.workLocal.bbox();
        return b ? sectionsOf({ min: b.min, max: [b.max[0] - 1, b.max[1] - 1, b.max[2] - 1] }) : [];
      },
    };
  }

  private sendGhost(id: string, players: string[], full: boolean, sections?: Vec3[]): void {
    if (!this.host.bridge.ui) return;
    const m = this.build(id, players, full, sections);
    if (!m) return;
    if (!full && !m.sections.length) return;
    this.host.bridge.send(m);
    this.shown.set(id, this.frameOf(id)!);
  }

  private sendClear(id: string): void {
    this.shown.delete(id);
    const players = this.host.players();
    if (players.length) this.host.bridge.send({ type: "ui.ghost.clear", players, ghost: id });
  }

  private up(): void {
    if (!this.host.bridge.ui) return;
    this.shown.clear();
    this.dirty.clear();
    for (const id of this.host.scopeIds()) this.dirty.set(id, "full");
    if (this.anchor) this.dirty.set(DOC_GHOST, "full");
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.host.intervalMs ?? UI_COALESCE_MS);
    this.timer.unref?.();
  }

  private down(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.candidate = undefined;
    this.dirty.clear();
    this.shown.clear();
  }
}

/** Sections (local position >> 4) an inclusive box touches. */
function forSections(b: PublicBox, fn: (s: Vec3) => void): void {
  for (let y = b.min[1] >> 4; y <= b.max[1] >> 4; y++) for (let z = b.min[2] >> 4; z <= b.max[2] >> 4; z++) for (let x = b.min[0] >> 4; x <= b.max[0] >> 4; x++) fn([x, y, z]);
}

function sectionsOf(b: PublicBox): Vec3[] {
  const out: Vec3[] = [];
  forSections(b, (s) => out.push(s));
  return out;
}
