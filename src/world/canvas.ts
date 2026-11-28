import { boxVolume, formatBox, intersectBox, isEmptyBox, toPublic, translateBox, unionBox, type Box, type Vec3 } from "../core/region.js";
import { Document, type WriteGuard } from "../document/document.js";
import type { Section } from "../document/voxels.js";
import { refusal } from "../scope/scopes.js";
import type { CanvasFrame } from "./live-link.js";
import type { WorldView } from "./view.js";

/**
 * Reads across the canvas (docs/design/19-canvas-and-requests.md, *The frame doesn't move with the
 * brush*; step F1). The linked document is sparse: it holds the brush's and the context's sections
 * only. A document read that reaches other canvas positions must not see them as air, so it reads
 * them through the world view (`18`, piece 5) and looks at a **canvas read document**: the linked
 * document's blocks with the view's blocks laid in around them, in the linked document's local
 * coordinates. That document is read-only and its outside blocks are possibly stale (they are the
 * world as last read for this request); the call's result says so in a `world:` line.
 *
 * - **Reach.** Each tool names the local boxes its call reads (a position, a column, a slice, a
 *   selection's bounding box). Inside the mirror nothing changes: the call reads the linked
 *   document itself. Positions outside the canvas that the mirror doesn't hold are refused
 *   (`outside_canvas`), as positions outside the volumes are for the mod.
 * - **Reading.** The part of the reach in the canvas is read into the world view unless the view
 *   already holds it (full or coarse) for this request; the view caps a read at `contextCap` and
 *   goes coarse past it.
 * - **The read document.** Rebuilt when the linked document, the view or the reach changed. It
 *   shares the linked document's state table, components, named selections and cameras (so names
 *   resolve as usual) and copies a section only where the view's blocks land in it; mirror
 *   positions always come from the linked document. Every edit on it is refused.
 *
 * Without a canvas, or on any document but the linked one, reads are unchanged.
 */

/** What canvas reads need: the linked frame (absent without a canvas), the world view and a note sink. */
export interface CanvasReadsOptions {
  frame: () => CanvasFrame | undefined;
  view: () => WorldView | undefined;
  /** Adds a line to the call's `world:` lines. */
  note: (line: string) => void;
}

/** Outside-canvas parts of a reach larger than this are refused without checking them position by position. */
const CHECK_LIMIT = 262_144;

export class CanvasReads {
  private cache?: { key: string; doc: Document };

  constructor(private readonly opts: CanvasReadsOptions) {}

  /** The latest canvas read document (raycast finds its renders), if one was built for this frame. */
  get doc(): Document | undefined {
    const f = this.opts.frame();
    return f && this.cache && this.cache.key.startsWith(frameKey(f)) ? this.cache.doc : undefined;
  }

  /**
   * The document a read of `reach` (local, half-open boxes) on `doc` should look at: `doc` itself
   * when it isn't the linked document, there is no canvas, or the reach stays inside the mirror;
   * otherwise the canvas read document, after reading what the view lacks.
   */
  async docFor(doc: Document, reach: readonly Box[]): Promise<Document> {
    const f = this.opts.frame();
    const boxes = reach.filter((b) => !isEmptyBox(b));
    if (!f || f.doc !== doc || !boxes.length) return doc;
    const inside: Box[] = [];
    for (const b of boxes) {
      for (const part of outsideOf(b, f.canvas)) if (!heldAll(f, part)) throw outsideCanvas(f, part);
      const c = intersectBox(b, f.canvas);
      if (!isEmptyBox(c) && !heldAll(f, c)) inside.push(c);
    }
    if (!inside.length) return doc;
    const view = this.opts.view();
    if (!view) throw refusal("world_disconnected", "The world view isn't available in this server, so canvas positions outside the brush and context can't be read.");
    if (view.dimension !== undefined && view.dimension !== f.dimension)
      throw refusal("wrong_dimension", `The world view reads ${view.dimension} for the current request, but the canvas is in ${f.dimension}; read the canvas outside the brush from a request in that dimension.`);
    const world = inside.map((b) => translateBox(b, f.origin));
    const missing = world.filter((b) => !view.parts.some((p) => p.level !== "surface" && contains(p.box, b)));
    let read = 0;
    let coarse = false;
    if (missing.length) {
      const r = await view.read({ boxes: missing.map(toPublic) });
      read = r.blocks;
      coarse = r.level === "coarse";
    }
    const out = this.build(f, view, inside);
    const where = inside.map((b) => formatBox(b)).join(", ");
    this.opts.note(
      read
        ? `world: read ${read.toLocaleString("en-US")} blocks outside the brush and context through the world view (${where}, local${coarse ? "; coarse, one block per cell" : ""}): read-only, and as of this call.`
        : `world: ${where} (local) lies outside the brush and context, so it was read from the world view as read earlier in this request: read-only, possibly stale.`,
    );
    return out;
  }

  /** The canvas read document for the linked document, the view's blocks and this reach. */
  private build(f: CanvasFrame, view: WorldView, reach: readonly Box[]): Document {
    const linked = f.doc, vdoc = view.doc;
    const key = `${frameKey(f)}|${linked.revision}|${idOf(vdoc)}:${vdoc.revision}|${reach.map((b) => formatBox(b)).join(";")}`;
    if (this.cache?.key === key) return this.cache.doc;
    const doc = this.cache?.key.startsWith(frameKey(f)) ? this.cache.doc : new Document({ ...linked.meta }, { states: linked.states, palettes: linked.palettes });
    doc.meta = { ...linked.meta, source: `world:canvas ${f.dimension}` };
    doc.voxels.clear();
    doc.blockEntities.clear();
    const mine = new Map<string, Section>();
    for (const s of linked.voxels.allSections()) {
      doc.voxels.putSection(s);
      mine.set(`${s.sx},${s.sy},${s.sz}`, s);
    }
    for (const [k, v] of linked.blockEntities) doc.blockEntities.set(k, v);
    // The view's blocks outside the mirror, in local coordinates; a shared section is copied before it is written.
    const copied = new Set<string>();
    const [lx, ly, lz] = linked.origin;
    const canvas = f.canvas;
    const vb = view.parts.reduce<Box | undefined>((u, p) => unionBox(u, p.box), undefined);
    if (vb) {
      const clip = intersectBox(translateBox(vb, neg(f.origin)), canvas);
      if (!isEmptyBox(clip)) {
        vdoc.voxels.forEachInBox(vdoc.boxToStore(translateBox(clip, f.origin)), (sx, sy, sz, id) => {
          const [wx, wy, wz] = vdoc.toLocal(sx, sy, sz);
          const x = wx - f.origin[0], y = wy - f.origin[1], z = wz - f.origin[2];
          if (f.mirror.has(x, y, z)) return;
          const tx = x + lx, ty = y + ly, tz = z + lz;
          const k = `${tx >> 4},${ty >> 4},${tz >> 4}`;
          const s = mine.get(k);
          if (s && !copied.has(k)) {
            doc.voxels.putSection({ ...s, ids: s.ids.slice() });
            copied.add(k);
          }
          doc.voxels.set(tx, ty, tz, doc.states.intern(vdoc.states.get(id)));
          const be = vdoc.blockEntities.get(`${sx},${sy},${sz}`);
          if (be) doc.blockEntities.set(`${tx},${ty},${tz}`, be);
        });
      }
    }
    doc.origin = [...linked.origin];
    doc.components = linked.components;
    doc.selections = linked.selections;
    doc.cameras = linked.cameras;
    doc.entities = linked.entities;
    doc.palettes = linked.palettes;
    if (linked.lastSelection !== undefined) doc.lastSelection = linked.lastSelection;
    if (linked.context) doc.context = linked.context;
    let bounds = linked.bounds;
    for (const b of reach) bounds = unionBox(bounds, linked.boxToStore(b));
    doc.bounds = bounds;
    if (!doc.guards.includes(readOnly)) doc.guards.push(readOnly);
    doc.revision++;
    this.cache = { key, doc };
    return doc;
  }
}

/** Refuses every edit on a canvas read document. */
const readOnly: WriteGuard = (_changes, op) => {
  throw refusal(
    "canvas_read_only",
    `This look at the canvas outside the brush is read-only, so ${op} can't edit it. Edit the linked document (scope "base"), inside the brush; the player or world_volumes moves the brush.`,
  );
};

function outsideCanvas(f: CanvasFrame, part: Box): Error {
  return refusal(
    "outside_canvas",
    `${formatBox(part)} (local) lies outside the canvas, local ${formatBox(f.canvas)}, and outside the brush and context, so it can't be read. ` +
      "Read inside the canvas; the player can grow it (/autosketch canvas grow).",
  );
}

/** Whether the mirror holds every position of `b`: inside one held box, or checked position by position when small. */
function heldAll(f: CanvasFrame, b: Box): boolean {
  if (f.held.some((h) => contains(h, b))) return true;
  if (boxVolume(b) > CHECK_LIMIT) return false;
  for (let y = b.min[1]; y < b.max[1]; y++) for (let z = b.min[2]; z < b.max[2]; z++) for (let x = b.min[0]; x < b.max[0]; x++) if (!f.mirror.has(x, y, z)) return false;
  return true;
}

/** The parts of `b` outside `c` (at most six boxes, half-open). */
function outsideOf(b: Box, c: Box): Box[] {
  const out: Box[] = [];
  let rest: Box = { min: [...b.min], max: [...b.max] };
  for (let i = 0; i < 3; i++) {
    if (rest.min[i]! < c.min[i]!) {
      const lo: Box = { min: [...rest.min], max: [...rest.max] };
      lo.max[i] = Math.min(c.min[i]!, rest.max[i]!);
      out.push(lo);
      rest.min[i] = lo.max[i]!;
    }
    if (rest.max[i]! > c.max[i]!) {
      const hi: Box = { min: [...rest.min], max: [...rest.max] };
      hi.min[i] = Math.max(c.max[i]!, rest.min[i]!);
      out.push(hi);
      rest.max[i] = hi.min[i]!;
    }
    if (rest.min[i]! >= rest.max[i]!) break;
  }
  return out.filter((x) => !isEmptyBox(x));
}

const contains = (o: Box, b: Box) => [0, 1, 2].every((i) => o.min[i]! <= b.min[i]! && o.max[i]! >= b.max[i]!);
const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];
const frameKey = (f: CanvasFrame) => `${idOf(f.doc)}@${f.origin.join(",")}`;

const ids = new WeakMap<object, number>();
let nextId = 1;
/** A stable id per object, for cache keys. */
function idOf(o: object): number {
  let n = ids.get(o);
  if (n === undefined) ids.set(o, (n = nextId++));
  return n;
}
