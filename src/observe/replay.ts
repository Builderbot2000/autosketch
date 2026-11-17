import type { DeltaRef } from "../core/events.js";
import type { PublicBox, Vec3 } from "../core/region.js";
import { Activity, SessionModel, type ModelEvent } from "./session-model.js";

/**
 * Replay planning (docs/design/12-observability.md, *Panels*, 7; moved from the viewer's
 * `viewer/js/replay.js` by `16`, *What goes, what stays, what moves*): rebuilds the base document
 * at any `seq` from the event stream and deltas.bin. Pure (no I/O), so the in-game replay frames
 * (`src/ui/replay-frames.ts`) and tests share it.
 *
 * The base document at seq S is: clear at the last `session.open` at or before S (its delta is a
 * keyframe with every block of the document as it opened), then apply every base `doc.op`,
 * `doc.undo` and `doc.redo` delta after it, in seq order. A step whose `shift` is set moved the
 * document's origin, so the blocks already there move by -shift first (records are in the frame
 * after the step). A step that changed blocks but carries no delta (deltas off or past
 * observe.maxDeltaBytes) is a gap: from there the rebuilt grid is incomplete, and the view falls
 * back to the newest time-lapse snapshot at or before S.
 */

/** An event as replay reads it: `seq` is required (logged events always carry it). */
export type ReplayEvent = ModelEvent & { seq: number };

/** What replay writes into: log-wide state ids (0 is air) by position, chunked per 16³. */
export interface ReplayGrid {
  chunks: Map<string, Uint32Array>;
  get(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, id: number): void;
  applyRecords(rec: ArrayLike<number>): void;
  clear(): void;
}

/** A plain `ReplayGrid`: chunks keyed `"cx,cy,cz"`, index `(y << 8) | (z << 4) | x` within one. */
export class StateGrid implements ReplayGrid {
  chunks = new Map<string, Uint32Array>();

  static key(cx: number, cy: number, cz: number): string {
    return cx + "," + cy + "," + cz;
  }

  get(x: number, y: number, z: number): number {
    const c = this.chunks.get(StateGrid.key(x >> 4, y >> 4, z >> 4));
    return c ? c[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)]! : 0;
  }

  set(x: number, y: number, z: number, id: number): void {
    const k = StateGrid.key(x >> 4, y >> 4, z >> 4);
    let c = this.chunks.get(k);
    if (!c) {
      if (!id) return;
      this.chunks.set(k, (c = new Uint32Array(4096)));
    }
    c[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = id;
  }

  /** Applies records (x, y, z, id). */
  applyRecords(rec: ArrayLike<number>): void {
    for (let i = 0; i + 3 < rec.length; i += 4) this.set(rec[i]!, rec[i + 1]!, rec[i + 2]!, rec[i + 3]!);
  }

  clear(): void {
    this.chunks.clear();
  }

  /** Every non-air voxel as (x, y, z, id). */
  forEach(fn: (x: number, y: number, z: number, id: number) => void): void {
    for (const [k, c] of this.chunks) {
      const [cx, cy, cz] = k.split(",").map(Number) as Vec3;
      for (let i = 0; i < 4096; i++) if (c[i]) fn(cx * 16 + (i & 15), cy * 16 + (i >> 8), cz * 16 + ((i >> 4) & 15), c[i]!);
    }
  }
}

const CHANGES = new Set(["doc.op", "doc.undo", "doc.redo"]);

const deltaOf = (e: ModelEvent): DeltaRef | undefined => ("delta" in e ? (e.delta as DeltaRef | undefined) : undefined);
const shiftOf = (e: ModelEvent): Vec3 | undefined => ("shift" in e ? (e.shift as Vec3 | undefined) : undefined);
const changedOf = (e: ModelEvent): number => ("changed" in e && typeof e.changed === "number" ? e.changed : 0);

/** A base step that changed blocks without a delta. */
export const isGap = (e: ModelEvent): boolean => (e.kind === "session.open" ? !e.delta : CHANGES.has(e.kind) && changedOf(e) > 0 && !deltaOf(e));

export interface ReplayPlan<E extends ReplayEvent = ReplayEvent> {
  /** Base `session.open` (the last one at or before seq) and the base changes after it. */
  steps: E[];
  /** The first step that cannot be rebuilt, if any. */
  gap: E | undefined;
  /** The newest time-lapse snapshot at or before seq. */
  snapshot: { seq: number; path: string } | undefined;
  /** Bytes of deltas.bin the steps need. */
  deltaEnd: number;
}

/** What replay applies to reach `seq`. */
export function replayPlan<E extends ReplayEvent>(events: E[], seq: number): ReplayPlan<E> {
  let start = -1;
  for (let i = 0; i < events.length && events[i]!.seq <= seq; i++) if (events[i]!.kind === "session.open") start = i;
  const steps: E[] = [];
  let gap: E | undefined;
  let deltaEnd = 0;
  for (let i = Math.max(start, 0); i < events.length && events[i]!.seq <= seq; i++) {
    const e = events[i]!;
    if (e.doc !== "base" || !(e.kind === "session.open" ? i === start : CHANGES.has(e.kind))) continue;
    steps.push(e);
    if (!gap && isGap(e)) gap = e;
    const d = deltaOf(e);
    if (d) deltaEnd = Math.max(deltaEnd, d.offset + d.length);
  }
  return { steps, gap, snapshot: snapshotAt(events, seq), deltaEnd };
}

/** The newest time-lapse snapshot taken at or before `seq` (`snapshots/<seq>.png`). */
export function snapshotAt(events: ReplayEvent[], seq: number): { seq: number; path: string } | undefined {
  let best: { seq: number; path: string } | undefined;
  for (const e of events) {
    if (e.kind !== "render.produced" || e.source !== "snapshot" || !e.path) continue;
    const m = /(\d+)\.png$/.exec(e.path);
    const s = m ? Number(m[1]) : e.seq;
    if (s <= seq && (!best || s > best.seq)) best = { seq: s, path: e.path };
  }
  return best;
}

/** Records of one event from a buffer holding deltas.bin from byte 0. */
export function recordsOf(e: ModelEvent, deltas: ArrayBufferLike): Int32Array {
  const d = deltaOf(e);
  if (!d || !d.length) return new Int32Array(0);
  return new Int32Array(deltas.slice(d.offset, d.offset + d.length));
}

/** Applies one step to a grid. */
export function applyStep(grid: ReplayGrid, e: ModelEvent, deltas: ArrayBufferLike): void {
  if (e.kind === "session.open") grid.clear();
  else {
    const shift = shiftOf(e);
    if (shift) translateGrid(grid, shift.map((v) => -v) as Vec3);
  }
  grid.applyRecords(recordsOf(e, deltas));
}

/** Moves every voxel of the grid by `d`. */
export function translateGrid(grid: ReplayGrid, d: Vec3): void {
  const all: number[] = [];
  for (const [k, c] of grid.chunks) {
    const [cx, cy, cz] = k.split(",").map(Number) as Vec3;
    for (let i = 0; i < 4096; i++) if (c[i]) all.push(cx * 16 + (i & 15) + d[0], cy * 16 + (i >> 8) + d[1], cz * 16 + ((i >> 4) & 15) + d[2], c[i]!);
  }
  grid.clear();
  grid.applyRecords(all);
}

/** Copies the voxels of `box` (inclusive) from one grid to another, moved by `shift`. */
export function copyRegion(src: ReplayGrid, box: PublicBox, dst: ReplayGrid, shift: Vec3 = [0, 0, 0]): void {
  for (let y = box.min[1]; y <= box.max[1]; y++)
    for (let z = box.min[2]; z <= box.max[2]; z++)
      for (let x = box.min[0]; x <= box.max[0]; x++) {
        const v = src.get(x, y, z);
        if (v) dst.set(x + shift[0], y + shift[1], z + shift[2], v);
      }
}

/**
 * Keeps a grid at a replay position. Moving forward applies only the new steps; moving back, or
 * past a new `session.open`, rebuilds from the keyframe.
 */
export class Replayer<G extends ReplayGrid = ReplayGrid> {
  seq = -1;
  keyframe: number | undefined;
  applied = 0;

  constructor(readonly grid: G) {}

  /** Brings the grid to `seq`. `deltas` must cover the plan's deltaEnd. Returns the plan. */
  seek<E extends ReplayEvent>(events: E[], seq: number, deltas: ArrayBufferLike): ReplayPlan<E> {
    const plan = replayPlan(events, seq);
    const key = plan.steps[0]?.kind === "session.open" ? plan.steps[0].seq : 0;
    let from = 0;
    if (seq >= this.seq && key === this.keyframe) from = this.applied;
    else this.grid.clear();
    for (let i = from; i < plan.steps.length; i++) applyStep(this.grid, plan.steps[i]!, deltas);
    this.seq = seq;
    this.keyframe = key;
    this.applied = plan.steps.length;
    return plan;
  }

  reset(): void {
    this.seq = -1;
    this.keyframe = undefined;
    this.applied = 0;
  }
}

/** The session model as of `seq`: every event up to it, applied in order. */
export function modelAt(events: ReplayEvent[], seq: number): SessionModel {
  const m = new SessionModel();
  for (const e of events) {
    if (e.seq > seq) break;
    m.apply(e);
  }
  return m;
}

/** The activity map as of `seq`: base op records where there are deltas, op boxes elsewhere. */
export function activityAt(events: ReplayEvent[], seq: number, deltas?: ArrayBufferLike): Activity {
  const a = new Activity();
  for (const e of events) {
    if (e.seq > seq) break;
    if (e.kind !== "doc.op" || e.doc !== "base") continue;
    if (e.delta && deltas && deltas.byteLength >= e.delta.offset + e.delta.length) a.addRecords(recordsOf(e, deltas));
    else if (e.box) a.addBox(e.box, e.changed);
  }
  return a;
}

/** Deltas of one scope (sandbox frame) up to `seq`, for drill-in during replay. */
export function scopeSteps<E extends ReplayEvent>(events: E[], scope: string, seq: number): E[] {
  return events.filter((e) => e.seq <= seq && e.doc === scope && deltaOf(e) && CHANGES.has(e.kind));
}
