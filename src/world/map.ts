import type { Box, Vec3 } from "../core/region.js";
import { Image, type RGBA } from "../palette/image.js";
import { refusal } from "../scope/scopes.js";
import type { BridgeConnection } from "./bridge.js";
import type { GameContext, SurfaceResult, WireBox } from "./protocol/messages.js";
import { DEFAULT_CONTEXT_CAP } from "./view.js";

/**
 * `world_map` (docs/design/19-canvas-and-requests.md, *Seeing the whole canvas*; step M1): the canvas
 * from above, one cell per chunk column, shaded by the highest surface block in the chunk, with the
 * brush (work volume), its context, open jobs and the player marked, and a chunk grid labelled in
 * local coordinates. It is how the agent sees the whole canvas before choosing where to put the
 * brush. Measurements only: heights, boxes, counts and positions; nothing judges the terrain or the
 * build (*No opinions in code*).
 *
 * - **Reads.** Surface snapshots (`13`, `snapshot` kind `surface`), served inside the canvas in every
 *   mode (`19`, *Model*). Up to `contextCap` columns, one snapshot of every column; past it the map
 *   goes coarse: one snapshot per chunk row, of that row's middle line of columns (16 of each chunk's
 *   256), so the wire carries a sixteenth of the columns. Read straight through the bridge, never
 *   into the world view, so the map leaves the view as it was.
 * - **The canvas** is the mod's latest `canvas` message, kept here (the live link keeps its own for
 *   the frame); the confirm (`select/confirm.ts`) asks it whether a canvas already holds a shape.
 * - **Local coordinates** are the linked document's when linked (`19`, *The frame doesn't move with
 *   the brush*), else the canvas's minimum corner: the frame once a brush inside it links.
 *
 * Logic only; the tool (`server/tools/world-map.ts`) reaches it through `Session.worldMap`.
 */

/** A canvas as the mod reported it: whole chunk columns, the full build height (inclusive world box). */
export interface MapCanvas {
  dimension: string;
  box: WireBox;
}

/** Highest surface per chunk column of the canvas. */
export interface ChunkTops {
  /** The canvas's minimum chunk `[cx, cz]` and its size in chunks. */
  min: [number, number];
  nx: number;
  nz: number;
  /** Per chunk (x fastest): the highest surface block's world y, or NaN when the chunk had none read. */
  top: Float64Array;
  /** Per chunk: 1 when the mod reported it ungenerated. */
  missing: Uint8Array;
  /** Columns read, and in how many snapshots. */
  columns: number;
  snapshots: number;
  /** True past the cap: each chunk's middle row only. */
  sampled: boolean;
}

/** The marks drawn over the heights (world coordinates, inclusive boxes). */
export interface MapMarks {
  /** World position of local (0,0,0), and why: the linked frame, or the canvas's minimum corner. */
  origin: Vec3;
  linked: boolean;
  work?: WireBox;
  context?: WireBox[];
  /** The brush is in another dimension than the canvas. */
  brushElsewhere?: string;
  jobs?: { id: string; box: WireBox; blocks?: number }[];
  player?: Vec3;
}

/** A job of the linked document, as the tool gives it: its lock, local and half-open. */
export interface MapJob {
  id: string;
  box: Box;
  blocks?: number;
}

export interface MapImage {
  png: Buffer;
  width: number;
  height: number;
  /** Pixels per chunk. */
  cell: number;
  /** Chunks between labelled grid lines. */
  step: number;
  /** Where the grid starts in the image (left and top margins). */
  left: number;
  top: number;
  caption: string;
}

/** Longest side of the map's grid in pixels (a cell is at least 1 px, at most `MAX_CELL`). */
export const MAP_PX = 480;
const MAX_CELL = 24;
const GRID_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256];
const BG: RGBA = [18, 18, 22, 255];
const EMPTY: RGBA = [44, 44, 50, 255];
const UNGENERATED: RGBA = [8, 8, 8, 255];
const UNGENERATED_MARK: RGBA = [110, 110, 110, 255];
const LOW: [number, number, number] = [35, 70, 110];
const HIGH: [number, number, number] = [245, 238, 200];
const GRID: RGBA = [255, 255, 255, 70];
const GRID_FAINT: RGBA = [255, 255, 255, 22];
const LABEL: RGBA = [210, 210, 210, 255];
export const WORK_COLOUR: RGBA = [255, 255, 255, 255];
export const CONTEXT_COLOUR: RGBA = [255, 210, 0, 255];
export const JOB_COLOUR: RGBA = [255, 80, 200, 255];
export const PLAYER_COLOUR: RGBA = [0, 220, 255, 255];
const LABEL_BG: RGBA = [0, 0, 0, 200];

const chunksOf = (b: WireBox): [number, number] => [(b.max[0] - b.min[0] + 1) >> 4, (b.max[2] - b.min[2] + 1) >> 4];

/** The highest surface block per chunk from surface snapshots of the canvas. */
export function chunkTops(canvas: WireBox, snaps: readonly SurfaceResult[], sampled: boolean): ChunkTops {
  const min: [number, number] = [canvas.min[0] >> 4, canvas.min[2] >> 4];
  const [nx, nz] = chunksOf(canvas);
  const top = new Float64Array(nx * nz).fill(NaN);
  const missing = new Uint8Array(nx * nz);
  let columns = 0;
  const at = (cx: number, cz: number) => (cx >= min[0] && cx < min[0] + nx && cz >= min[1] && cz < min[1] + nz ? cx - min[0] + nx * (cz - min[1]) : -1);
  for (const s of snaps) {
    const a = s.columns;
    const sx = a.max[0] - a.min[0] + 1, sz = a.max[1] - a.min[1] + 1;
    columns += sx * sz;
    for (let i = 0; i < sx * sz; i++) {
      const h = s.surface.heights[i]!;
      if (h === 0) continue;
      const c = at((a.min[0] + (i % sx)) >> 4, (a.min[1] + Math.floor(i / sx)) >> 4);
      if (c < 0) continue;
      const y = s.minY + h - 1;
      if (!(top[c]! >= y)) top[c] = y;
    }
    for (const [cx, cz] of s.missing) {
      const c = at(cx, cz);
      if (c >= 0) missing[c] = 1;
    }
  }
  return { min, nx, nz, top, missing, columns, snapshots: snaps.length, sampled };
}

/** The shade of a height between the map's lowest and highest chunk tops. */
export function heightShade(y: number, lo: number, hi: number): RGBA {
  const t = hi <= lo ? 1 : (y - lo) / (hi - lo);
  return [Math.round(LOW[0] + (HIGH[0] - LOW[0]) * t), Math.round(LOW[1] + (HIGH[1] - LOW[1]) * t), Math.round(LOW[2] + (HIGH[2] - LOW[2]) * t), 255];
}

/** The lowest and highest chunk tops, and where the highest is (chunk index). */
function range(t: ChunkTops): { lo: number; hi: number; highest: number } | undefined {
  let lo = Infinity, hi = -Infinity, highest = -1;
  t.top.forEach((y, i) => {
    if (Number.isNaN(y)) return;
    if (y < lo) lo = y;
    if (y > hi) (hi = y), (highest = i);
  });
  return highest < 0 ? undefined : { lo, hi, highest };
}

/**
 * Draws the canvas from above: x east, z south (north up), one cell per chunk shaded by its highest
 * surface block (dark low, light high), ungenerated chunks black with a grey cross, chunks with no
 * surface block dark grey; the brush solid white, the context dashed yellow, open jobs magenta and
 * numbered, the player's position ringed in cyan; grid lines every `step` chunks labelled with the
 * local x (top) and z (left) of the line.
 */
export function renderMap(canvas: MapCanvas, t: ChunkTops, marks: MapMarks): MapImage {
  const cell = Math.max(1, Math.min(MAX_CELL, Math.floor(MAP_PX / Math.max(t.nx, t.nz))));
  const cb = canvas.box;
  const lx = (cx: number) => cx * 16 - marks.origin[0];
  const lz = (cz: number) => cz * 16 - marks.origin[2];
  const longest = Math.max(...[t.min[0], t.min[0] + t.nx].map((c) => String(lx(c)).length), ...[t.min[1], t.min[1] + t.nz].map((c) => String(lz(c)).length));
  const step = GRID_STEPS.find((s) => s * cell >= Math.max(24, longest * 6 + 6)) ?? GRID_STEPS[GRID_STEPS.length - 1]!;
  const left = longest * 6 + 3, top = 11;
  const gw = t.nx * cell, gh = t.nz * cell;
  const w = left + gw + 2, h = top + gh + 2;
  const img = new Image(w, h);
  img.fillRect(0, 0, w, h, BG);
  const r = range(t);
  const inset = cell >= 6 ? 1 : 0;
  for (let j = 0; j < t.nz; j++)
    for (let i = 0; i < t.nx; i++) {
      const k = i + t.nx * j;
      const x = left + i * cell, y = top + j * cell;
      if (t.missing[k]) {
        img.fillRect(x, y, cell, cell, UNGENERATED);
        if (cell >= 3) for (let d = 0; d < cell; d++) (img.blend(x + d, y + d, UNGENERATED_MARK), img.blend(x + cell - 1 - d, y + d, UNGENERATED_MARK));
        continue;
      }
      const ty = t.top[k]!;
      img.fillRect(x, y, cell, cell, Number.isNaN(ty) || !r ? EMPTY : heightShade(ty, r.lo, r.hi));
    }
  // Grid: every chunk faintly when cells are large, every `step` chunks labelled.
  for (let i = 0; i <= t.nx; i++) {
    const major = i % step === 0;
    if (major || inset) img.fillRect(left + i * cell - (i === t.nx ? 1 : 0), top, 1, gh, major ? GRID : GRID_FAINT);
    if (major) {
      const s = String(lx(t.min[0] + i));
      img.text(s, Math.min(Math.max(0, left + i * cell - Math.floor((s.length * 6) / 2)), w - s.length * 6), 2, LABEL);
    }
  }
  for (let j = 0; j <= t.nz; j++) {
    const major = j % step === 0;
    if (major || inset) img.fillRect(left, top + j * cell - (j === t.nz ? 1 : 0), gw, 1, major ? GRID : GRID_FAINT);
    if (major) {
      const s = String(lz(t.min[1] + j));
      img.text(s, left - 2 - s.length * 6, Math.min(Math.max(top, top + j * cell - 3), h - 8), LABEL);
    }
  }
  // Marks, in pixels: a block x maps to (x - canvas min) · cell / 16.
  const px = (wx: number) => left + Math.floor(((wx - cb.min[0]) * cell) / 16);
  const pz = (wz: number) => top + Math.floor(((wz - cb.min[2]) * cell) / 16);
  const rect = (b: WireBox) => {
    const x0 = Math.max(left, px(b.min[0])), y0 = Math.max(top, pz(b.min[2]));
    const x1 = Math.min(left + gw, Math.max(px(b.max[0] + 1), x0 + 1)), y1 = Math.min(top + gh, Math.max(pz(b.max[2] + 1), y0 + 1));
    return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : undefined;
  };
  const outline = (b: WireBox, c: RGBA, dashed = false) => {
    const q = rect(b);
    if (!q) return undefined;
    const dot = (x: number, y: number, i: number) => (!dashed || (i >> 1) % 2 === 0) && img.fillRect(x, y, 1, 1, c);
    for (let x = q.x0; x < q.x1; x++) (dot(x, q.y0, x - q.x0), dot(x, q.y1 - 1, x - q.x0));
    for (let y = q.y0; y < q.y1; y++) (dot(q.x0, y, y - q.y0), dot(q.x1 - 1, y, y - q.y0));
    return q;
  };
  if (!marks.brushElsewhere) {
    for (const b of marks.context ?? []) outline(b, CONTEXT_COLOUR, true);
    if (marks.work) outline(marks.work, WORK_COLOUR);
  }
  (marks.jobs ?? []).forEach((j, i) => {
    const q = outline(j.box, JOB_COLOUR);
    if (!q) return;
    const label = String(i + 1), lw = label.length * 6 + 1;
    const x = Math.min(Math.max(left, q.x0), w - lw), y = q.y0 - 9 >= top ? q.y0 - 9 : Math.min(q.y1 + 1, h - 9);
    img.fillRect(x, y, lw, 9, LABEL_BG);
    img.text(label, x + 1, y + 1, JOB_COLOUR);
  });
  const p = marks.player;
  if (p && inside(cb, p)) {
    const x = px(Math.floor(p[0])), y = pz(Math.floor(p[2]));
    for (const s of [7, 5]) {
      const o = Math.floor(s / 2);
      img.fillRect(x - o, y - o, s, 1, PLAYER_COLOUR);
      img.fillRect(x - o, y + o, s, 1, PLAYER_COLOUR);
      img.fillRect(x - o, y - o, 1, s, PLAYER_COLOUR);
      img.fillRect(x + o, y - o, 1, s, PLAYER_COLOUR);
      if (cell < 4) break;
    }
  }
  img.text("N", 1, 2, [255, 255, 255, 255]);
  const caption =
    `Map ${w}×${h} px: ${t.nx}×${t.nz} chunks, ${cell} px per chunk (16×16 blocks), north up (N top left). ` +
    `Shade = the highest surface block in each chunk${r ? `, dark at local y ${r.lo - marks.origin[1]} to light at ${r.hi - marks.origin[1]}` : ""}; ` +
    `white = brush (work volume), dashed yellow = context, magenta = open jobs (numbered as listed), cyan ring = the player; ` +
    `dark grey = no surface block read${t.missing.some((m) => m) ? ", black with a grey cross = ungenerated" : ""}. ` +
    `Grid every ${step} chunk${step === 1 ? "" : "s"} (${step * 16} blocks), labelled with local x (top) and z (left).`;
  return { png: img.encodePng(), width: w, height: h, cell, step, left, top, caption };
}

const inside = (b: WireBox, p: readonly number[]) => [0, 2].every((i) => Math.floor(p[i]!) >= b.min[i]! && Math.floor(p[i]!) <= b.max[i]!);
const n = (k: number) => k.toLocaleString("en-US");
const pt = (v: readonly number[]) => `(${v.join(",")})`;
const size = (b: WireBox) => [0, 1, 2].map((i) => b.max[i]! - b.min[i]! + 1).join("×");
const local = (b: WireBox, o: Vec3) => `${pt(b.min.map((c, i) => c - o[i]!))}–${pt(b.max.map((c, i) => c - o[i]!))}`;
const span = (b: WireBox) => `${pt(b.min)}–${pt(b.max)}`;
const overlaps = (a: WireBox, b: WireBox) => [0, 1, 2].every((i) => a.min[i]! <= b.max[i]! && b.min[i]! <= a.max[i]!);

/** `world_map`'s text: the canvas, what was read, the heights, the brush, jobs and the player. Measurements only. */
export function describeMap(canvas: MapCanvas, t: ChunkTops, marks: MapMarks, opts: { cap: number; image: MapImage }): string {
  const cb = canvas.box, o = marks.origin;
  const [w, , d] = [0, 1, 2].map((i) => cb.max[i]! - cb.min[i]! + 1);
  const lines = [
    `ok · world_map · canvas ${t.nx}×${t.nz} chunks (${w}×${d} blocks, world y ${cb.min[1]} to ${cb.max[1]}) in ${canvas.dimension}, world ${span(cb)} = local ${local(cb, o)}; local (0,0,0) is world ${pt(o)} (${marks.linked ? "the linked document's frame" : "the canvas's minimum corner: the frame once a brush inside it links"}).`,
  ];
  const r = range(t);
  const read = t.sampled
    ? `${n(t.columns)} columns in ${t.snapshots} surface snapshots, coarse: the canvas is over the per-read cap of ${n(opts.cap)} columns (contextCap), so each chunk's middle row (16 of its 256 columns)`
    : `${n(t.columns)} columns in ${t.snapshots} surface snapshot${t.snapshots === 1 ? "" : "s"}, every column`;
  const missing = t.missing.reduce((s, m) => s + m, 0);
  let none = 0;
  t.top.forEach((y, i) => void (Number.isNaN(y) && !t.missing[i] && none++));
  const hx = r ? (r.highest % t.nx) + t.min[0] : 0, hz = r ? Math.floor(r.highest / t.nx) + t.min[1] : 0;
  lines.push(
    `Surface: read ${read}, as of this call. ` +
      (r
        ? `Highest surface block per chunk from local y ${r.lo - o[1]} to ${r.hi - o[1]} (world y ${r.lo} to ${r.hi}); the highest in the chunk at local x ${hx * 16 - o[0]}..${hx * 16 + 15 - o[0]}, z ${hz * 16 - o[2]}..${hz * 16 + 15 - o[2]}.`
        : "No surface block was read.") +
      (missing ? ` ${n(missing)} chunk${missing === 1 ? "" : "s"} ungenerated.` : "") +
      (none ? ` ${n(none)} chunk${none === 1 ? "" : "s"} with no surface block read.` : ""),
  );
  if (marks.brushElsewhere) lines.push(`Brush: in ${marks.brushElsewhere}, not on this canvas.`);
  else if (!marks.work) lines.push("Brush: none set.");
  else {
    const where = overlaps(marks.work, cb) ? "" : "; it lies outside the canvas";
    const c = marks.context?.length ?? 0;
    lines.push(`Brush: work ${size(marks.work)} at local ${local(marks.work, o)} (world ${span(marks.work)})${where}; context ${c} box${c === 1 ? "" : "es"}.`);
  }
  const jobs = marks.jobs ?? [];
  if (jobs.length)
    lines.push(`Open jobs: ${jobs.map((j, i) => `[${i + 1}] ${j.id} at local ${local(j.box, o)}${j.blocks !== undefined ? ` (${n(j.blocks)} blocks)` : ""}`).join(", ")}.`);
  const p = marks.player;
  if (!p) lines.push("Player: position not known (no in-game request open).");
  else {
    const b = p.map((c) => Math.floor(c));
    lines.push(`Player: at local ${pt(b.map((c, i) => c - o[i]!))} (world ${pt(b)})${inside(cb, p) ? "" : ", outside the canvas"}.`);
  }
  lines.push(opts.image.caption + " Image plus text.");
  return lines.join("\n");
}

/** What `world_map` needs of the world. */
export interface WorldMapOptions {
  bridge: Pick<BridgeConnection, "request" | "on" | "onConnection" | "connected" | "volumes">;
  /** The linked frame (world position of local (0,0,0)), while linked. */
  linked?: () => { origin: Vec3; dimension: string } | undefined;
  /** The current in-game request's context (the player's position), when one is open. */
  player?: () => GameContext | undefined;
  /** Per-read cap in columns (the mod's `contextCap`; default 4,194,304). */
  contextCap?: number;
}

export class WorldMap {
  private latest: MapCanvas | null | undefined;
  private readonly offs: (() => void)[] = [];

  constructor(private readonly opts: WorldMapOptions) {
    this.offs.push(
      opts.bridge.on("canvas", (m) => void (this.latest = m.box === null ? null : { dimension: m.dimension, box: m.box })),
      opts.bridge.onConnection((s) => void (s === "down" && (this.latest = undefined))),
    );
  }

  close(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** The mod's canvas now (null: none; undefined: not reported on this connection). */
  get canvas(): MapCanvas | null | undefined {
    return this.latest;
  }

  get contextCap(): number {
    return this.opts.contextCap ?? DEFAULT_CONTEXT_CAP;
  }

  /** `world_map`: reads the canvas's surface and draws it with the marks. `jobs` are the linked document's open jobs (local). */
  async map(jobs: readonly MapJob[] = []): Promise<{ png: Buffer; text: string; image: MapImage; tops: ChunkTops }> {
    const { bridge } = this.opts;
    if (!bridge.connected) throw refusal("world_disconnected", "No game is connected, so there is no canvas to map.");
    const c = this.latest;
    if (!c)
      throw refusal(
        "no_canvas",
        'No canvas is set, so there is nothing to map. The player sets one (the wand\'s canvas mode, or /autosketch canvas here [radius]); confirming a shape over the brush cap sets one too (world_volumes({from:"candidate"})).',
      );
    const tops = await this.readTops(c);
    const l = this.opts.linked?.();
    const linked = !!l && l.dimension === c.dimension;
    const origin: Vec3 = linked ? [...l.origin] : [...c.box.min];
    const v = bridge.volumes;
    const marks: MapMarks = { origin, linked };
    if (v && v.work !== null) {
      if (v.dimension !== c.dimension) marks.brushElsewhere = v.dimension;
      else (marks.work = v.work), (marks.context = v.context);
    }
    if (linked && jobs.length)
      marks.jobs = jobs.map((j) => ({
        id: j.id,
        box: { min: [0, 1, 2].map((i) => j.box.min[i]! + origin[i]!) as Vec3, max: [0, 1, 2].map((i) => j.box.max[i]! - 1 + origin[i]!) as Vec3 },
        ...(j.blocks !== undefined ? { blocks: j.blocks } : {}),
      }));
    const ctx = this.opts.player?.();
    if (ctx && ctx.dimension === c.dimension) marks.player = [...ctx.position];
    const image = renderMap(c, tops, marks);
    return { png: image.png, image, tops, text: describeMap(c, tops, marks, { cap: this.contextCap, image }) };
  }

  /** Surface snapshots of the canvas: every column up to the cap, else each chunk row's middle line. */
  private async readTops(c: MapCanvas): Promise<ChunkTops> {
    const b = c.box;
    const w = b.max[0] - b.min[0] + 1, d = b.max[2] - b.min[2] + 1;
    const ask = (z0: number, z1: number) =>
      this.opts.bridge.request({ type: "snapshot", dimension: c.dimension, kind: "surface", columns: { min: [b.min[0], z0], max: [b.max[0], z1] } });
    if (w * d <= this.contextCap) return chunkTops(b, [await ask(b.min[2], b.max[2])], false);
    const snaps: SurfaceResult[] = [];
    for (let z = b.min[2] + 8; z <= b.max[2]; z += 16) snaps.push(await ask(z, z));
    return chunkTops(b, snaps, true);
  }
}
