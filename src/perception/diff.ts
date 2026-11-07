import type { Registry } from "../assets/registry.js";
import { shortState, stateId } from "../core/blockstate.js";
import { Mask } from "../core/mask.js";
import { formatBox, type Box, type Vec3 } from "../core/region.js";
import { Document } from "../document/document.js";
import { VoxelStore } from "../document/voxels.js";
import type { PaletteIndex } from "../palette/index.js";

/**
 * Diffs (docs/design/06-perception.md, "Diffs"): what changed since a checkpoint or the last n
 * ops, read from the journal without touching the document. Also builds a read-only snapshot of
 * the document at that point, for before/after renders.
 */

export interface DiffChange {
  /** Local position in the current document. */
  pos: Vec3;
  before: string;
  after: string;
}

export interface DocDiff {
  /** Human label of the reference point ("checkpoint \"a\"", "3 ops ago"). */
  label: string;
  /** Journal cursor of the reference point. */
  target: number;
  /** Ops between the reference point and now. */
  ops: number;
  /** The reference point is in the undone (redoable) tail of the journal. */
  ahead: boolean;
  changes: DiffChange[];
  /** Changed positions (local), for highlights and the `changed` selection. */
  mask: Mask;
  box?: Box;
}

/** Resolves "checkpoint:<name>", "op:-n" (or a bare checkpoint name) to a journal cursor. */
export function resolveSince(doc: Document, since: string): { target: number; label: string } {
  const j = doc.journal;
  const op = /^op:-(\d+)$/.exec(since);
  if (op) {
    const n = Number(op[1]);
    if (n < 1) throw new Error('op:-n needs n ≥ 1 (op:-1 = the last op)');
    if (n > j.cursor) throw new Error(`only ${j.cursor} op${j.cursor === 1 ? " is" : "s are"} in memory to diff against (asked for op:-${n})`);
    return { target: j.cursor - n, label: n === 1 ? "the last op" : `the last ${n} ops` };
  }
  const name = since.replace(/^checkpoint:/, "");
  const cp = j.checkpoints.get(name);
  if (!cp) throw new Error(`since must be "checkpoint:<name>" or "op:-n"; no checkpoint "${name}" (have: ${[...j.checkpoints.keys()].join(", ") || "none"})`);
  const target = j.cursorFor(cp);
  if (target === undefined) throw new Error(`checkpoint "${name}" can no longer be reached: the ops after it were replaced or trimmed from memory`);
  return { target, label: `checkpoint "${name}"` };
}

const keyOf = (x: number, y: number, z: number) => `${x},${y},${z}`;

/** Store position → state id at the journal cursor `target`, for every position touched in between. */
function statesAt(doc: Document, target: number): Map<string, { p: Vec3; id: number }> {
  const j = doc.journal;
  const out = new Map<string, { p: Vec3; id: number }>();
  if (target < j.cursor) {
    // Undo direction: the first "before" of each position after the target.
    for (let i = target; i < j.cursor; i++) {
      const e = j.entries[i]!;
      for (let k = 0; k < e.before.length; k++) {
        const p: Vec3 = [e.positions[k * 3]!, e.positions[k * 3 + 1]!, e.positions[k * 3 + 2]!];
        const key = keyOf(...p);
        if (!out.has(key)) out.set(key, { p, id: e.before[k]! });
      }
    }
  } else {
    // Redo direction (the checkpoint is in the undone tail): the last "after" up to the target.
    for (let i = j.cursor; i < target; i++) {
      const e = j.entries[i]!;
      for (let k = 0; k < e.after.length; k++) {
        const p: Vec3 = [e.positions[k * 3]!, e.positions[k * 3 + 1]!, e.positions[k * 3 + 2]!];
        out.set(keyOf(...p), { p, id: e.after[k]! });
      }
    }
  }
  return out;
}

export function diffSince(doc: Document, since: string): DocDiff {
  const { target, label } = resolveSince(doc, since);
  const changes: DiffChange[] = [];
  const mask = new Mask();
  for (const { p, id } of statesAt(doc, target).values()) {
    const now = doc.voxels.get(p[0], p[1], p[2]);
    if (now === id) continue;
    const pos = doc.toLocal(...p);
    changes.push({ pos, before: doc.states.get(id), after: doc.states.get(now) });
    mask.add(...pos);
  }
  const box = mask.bbox();
  return { label, target, ops: Math.abs(doc.journal.cursor - target), ahead: target > doc.journal.cursor, changes, mask, ...(box ? { box } : {}) };
}

/**
 * A read-only copy of the document as it was at journal cursor `target`. Shares the state table
 * (ids are stable), copies the voxels; the original document is not touched.
 */
export function documentAt(doc: Document, target: number): Document {
  const voxels = new VoxelStore();
  for (const s of doc.voxels.allSections()) voxels.putSection({ ...s, ids: s.ids.slice() });
  const snap = new Document({ ...doc.meta }, { states: doc.states, voxels });
  for (const { p, id } of statesAt(doc, target).values()) voxels.set(p[0], p[1], p[2], id);
  const j = doc.journal;
  const e = target < j.cursor ? j.entries[target] : j.entries[target - 1];
  const side = target < j.cursor ? "before" : "after";
  snap.origin = e ? [...(side === "before" ? e.originBefore : e.originAfter)] : [...doc.origin];
  const bounds = e ? (side === "before" ? e.boundsBefore : e.boundsAfter) : doc.bounds;
  if (bounds) snap.bounds = structuredClone(bounds);
  snap.components = new Map([...doc.components].map(([k, c]) => [k, structuredClone(c)]));
  return snap;
}

/** Clusters of changed positions (within 2 blocks of each other), largest first. */
export function changedRegions(mask: Mask, limit = 200_000): { box: Box; count: number }[] {
  const pts = mask.positions();
  if (!pts.length) return [];
  if (pts.length > limit) return [{ box: mask.bbox()!, count: pts.length }];
  const left = new Set(pts.map((p) => keyOf(...p)));
  const out: { box: Box; count: number }[] = [];
  for (const start of pts) {
    if (!left.delete(keyOf(...start))) continue;
    const q = [start];
    const min: Vec3 = [...start], max: Vec3 = [start[0] + 1, start[1] + 1, start[2] + 1];
    for (let i = 0; i < q.length; i++) {
      const [x, y, z] = q[i]!;
      for (let dx = -2; dx <= 2; dx++)
        for (let dy = -2; dy <= 2; dy++)
          for (let dz = -2; dz <= 2; dz++) {
            const k = keyOf(x + dx, y + dy, z + dz);
            if (!left.delete(k)) continue;
            const p: Vec3 = [x + dx, y + dy, z + dz];
            q.push(p);
            for (let a = 0; a < 3; a++) {
              min[a] = Math.min(min[a]!, p[a]!);
              max[a] = Math.max(max[a]!, p[a]! + 1);
            }
          }
    }
    out.push({ box: { min, max }, count: q.length });
  }
  return out.sort((a, b) => b.count - a.count);
}

const n = (v: number) => v.toLocaleString("en-US");

/** Text summary: counts by family (added, removed, replaced) and the regions changed. */
export function formatDiff(d: DocDiff, ctx: { registry?: Registry; index?: PaletteIndex } = {}): string {
  const head = `diff since ${d.label} (${d.ops} op${d.ops === 1 ? "" : "s"}${d.ahead ? ", which are undone: the checkpoint is ahead of now" : ""})`;
  if (!d.changes.length) return `${head}: no blocks changed`;
  const fam = (s: string) => {
    const id = stateId(s);
    return shortState(ctx.index?.familyOfBlock(id)?.id ?? id, ctx.registry);
  };
  const added = new Map<string, number>(), removed = new Map<string, number>(), replaced = new Map<string, number>();
  let states = 0;
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const c of d.changes) {
    if (c.before === "minecraft:air") bump(added, fam(c.after));
    else if (c.after === "minecraft:air") bump(removed, fam(c.before));
    else if (stateId(c.before) === stateId(c.after)) states++;
    else bump(replaced, `${fam(c.before)}→${fam(c.after)}`);
  }
  const list = (m: Map<string, number>) => {
    const s = [...m].sort((a, b) => b[1] - a[1]);
    return s.slice(0, 8).map(([k, v]) => `${k} ${n(v)}`).join(", ") + (s.length > 8 ? ` …+${s.length - 8}` : "");
  };
  const lines = [`${head}: ${n(d.changes.length)} position${d.changes.length === 1 ? "" : "s"} changed in ${formatBox(d.box!)}`];
  if (added.size) lines.push(`added: ${list(added)}`);
  if (removed.size) lines.push(`removed: ${list(removed)}`);
  if (replaced.size) lines.push(`replaced: ${list(replaced)}`);
  if (states) lines.push(`state changes (same block): ${n(states)}`);
  const regions = changedRegions(d.mask);
  lines.push(`regions: ${regions.slice(0, 5).map((r) => `${formatBox(r.box)} ${n(r.count)}`).join(" · ")}${regions.length > 5 ? ` …+${regions.length - 5}` : ""}`);
  return lines.join("\n");
}
