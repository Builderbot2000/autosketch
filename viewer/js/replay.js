// Replay (docs/design/12-observability.md, *Panels*, 7): rebuilds the views at any `seq` from the
// event stream and deltas.bin. Pure (no DOM, no network), so tests run it in Node.
//
// The base document at seq S is: clear at the last `session.open` at or before S (its delta is a
// keyframe with every block of the document as it opened), then apply every base `doc.op`,
// `doc.undo` and `doc.redo` delta after it, in seq order. A step whose `shift` is set moved the
// document's origin, so the blocks already there move by -shift first (records are in the frame
// after the step). A step that changed blocks but carries no delta (deltas off or past
// observe.maxDeltaBytes) is a gap: from there the rebuilt grid is incomplete, and the view falls
// back to the newest time-lapse snapshot at or before S.

import { Activity, SessionModel } from "./model.js";

const CHANGES = new Set(["doc.op", "doc.undo", "doc.redo"]);

/** A base step that changed blocks without a delta. */
export const isGap = (e) => (e.kind === "session.open" ? !e.delta : CHANGES.has(e.kind) && e.changed > 0 && !e.delta);

/**
 * What replay applies to reach `seq`:
 *   steps     base `session.open` (the last one at or before seq) and the base changes after it
 *   gap       the first step that cannot be rebuilt, if any
 *   snapshot  the newest time-lapse snapshot at or before seq: { seq, path }
 *   deltaEnd  bytes of deltas.bin the steps need
 */
export function replayPlan(events, seq) {
  let start = -1;
  for (let i = 0; i < events.length && events[i].seq <= seq; i++) if (events[i].kind === "session.open") start = i;
  const steps = [];
  let gap;
  let deltaEnd = 0;
  for (let i = Math.max(start, 0); i < events.length && events[i].seq <= seq; i++) {
    const e = events[i];
    if (e.doc !== "base" || !(e.kind === "session.open" ? i === start : CHANGES.has(e.kind))) continue;
    steps.push(e);
    if (!gap && isGap(e)) gap = e;
    if (e.delta) deltaEnd = Math.max(deltaEnd, e.delta.offset + e.delta.length);
  }
  return { steps, gap, snapshot: snapshotAt(events, seq), deltaEnd };
}

/** The newest time-lapse snapshot taken at or before `seq` (`snapshots/<seq>.png`). */
export function snapshotAt(events, seq) {
  let best;
  for (const e of events) {
    if (e.kind !== "render.produced" || e.source !== "snapshot" || !e.path) continue;
    const m = /(\d+)\.png$/.exec(e.path);
    const s = m ? Number(m[1]) : e.seq;
    if (s <= seq && (!best || s > best.seq)) best = { seq: s, path: e.path };
  }
  return best;
}

/** Records of one event from a buffer holding deltas.bin from byte 0. */
export function recordsOf(e, deltas) {
  if (!e.delta || !e.delta.length) return new Int32Array(0);
  return new Int32Array(deltas.slice(e.delta.offset, e.delta.offset + e.delta.length));
}

/** Applies one step to a grid. */
export function applyStep(grid, e, deltas) {
  if (e.kind === "session.open") grid.clear();
  else if (e.shift) translateGrid(grid, e.shift.map((v) => -v));
  grid.applyRecords(recordsOf(e, deltas));
}

/** Moves every voxel of the grid by `d`. */
export function translateGrid(grid, d) {
  const all = [];
  for (const [k, c] of grid.chunks) {
    const [cx, cy, cz] = k.split(",").map(Number);
    for (let i = 0; i < 4096; i++) if (c[i]) all.push(cx * 16 + (i & 15) + d[0], cy * 16 + (i >> 8) + d[1], cz * 16 + ((i >> 4) & 15) + d[2], c[i]);
  }
  grid.clear();
  grid.applyRecords(all);
}

/** Copies the voxels of `box` (inclusive) from one grid to another, moved by `shift`. */
export function copyRegion(src, box, dst, shift = [0, 0, 0]) {
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
export class Replayer {
  constructor(grid) {
    this.grid = grid;
    this.seq = -1;
    this.keyframe = undefined;
    this.applied = 0;
  }

  /** Brings the grid to `seq`. `deltas` must cover the plan's deltaEnd. Returns the plan. */
  seek(events, seq, deltas) {
    const plan = replayPlan(events, seq);
    const key = plan.steps[0]?.kind === "session.open" ? plan.steps[0].seq : 0;
    let from = 0;
    if (seq >= this.seq && key === this.keyframe) {
      from = this.applied;
    } else {
      this.grid.clear();
    }
    for (let i = from; i < plan.steps.length; i++) applyStep(this.grid, plan.steps[i], deltas);
    this.seq = seq;
    this.keyframe = key;
    this.applied = plan.steps.length;
    return plan;
  }

  reset() {
    this.seq = -1;
    this.keyframe = undefined;
    this.applied = 0;
  }
}

/** The session model as of `seq`: every event up to it, applied in order. */
export function modelAt(events, seq) {
  const m = new SessionModel();
  for (const e of events) {
    if (e.seq > seq) break;
    m.apply(e);
  }
  return m;
}

/** The activity map as of `seq`: base op records where there are deltas, op boxes elsewhere. */
export function activityAt(events, seq, deltas) {
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
export function scopeSteps(events, scope, seq) {
  return events.filter((e) => e.seq <= seq && e.doc === scope && e.delta && CHANGES.has(e.kind));
}
