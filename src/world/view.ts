import { boxVolume, containsPoint, formatBox, fromPublic, intersectBox, isEmptyBox, unionBox, type Box, type PublicBox, type Vec3 } from "../core/region.js";
import { Document, type WriteGuard } from "../document/document.js";
import type { PaletteBook } from "../palette/pick.js";
import { refusal } from "../scope/scopes.js";
import type { BridgeConnection } from "./bridge.js";
import { maskRegions } from "./protocol/body.js";
import { COARSE_CELLS, MASK_MARGIN, type CoarseCell, type CoarseResult, type GameContext, type SnapshotResult, type WireBox } from "./protocol/messages.js";

/**
 * The world view (docs/design/18-select.md, piece 5): a read-only look at the world held **beside**
 * the open document, never in place of it, so it coexists with a linked document and with open
 * sandboxes.
 *
 * - **A document in world coordinates.** The view keeps the blocks it has read in an ordinary
 *   `Document` whose local coordinates are the world's: `doc.origin` is set so store coordinates stay
 *   near zero (the voxel store's range) while every position a tool sees or gives is a world
 *   position. So `render`, `view_slice`, `raycast`, `select` and `analyze` work on it unchanged, and
 *   named selections (`candidate`) live in its `selections` like any document's.
 * - **Read-only.** Every edit on it is refused with `world_view_read_only` (a write guard, so ops,
 *   scripts, undo and restore are all covered). Reads write the voxels directly.
 * - **Per request.** It holds what was read for the current in-game request (`request()`), in that
 *   request's dimension, and starts empty again when the request changes or ends. With no request
 *   open it belongs to "no request" and the linked dimension.
 * - **Reads are snapshots** (`13`, `snapshot` by boxes or sections), capped per call by `contextCap`
 *   (the mod's cap; the mod refuses past its own). A later read of the same place replaces it.
 * - **Coarse level** (V2): a read over the cap goes coarse, one block per 2³ or 4³ cell written over
 *   the whole cell; full detail replaces coarse cells, never the reverse. A **surface read** (piece
 *   10) writes each column's top block only.
 *
 * It lives in `world/` because it reads through the bridge; tools reach it only through
 * `Session.worldView` (ARCHITECTURE.md, *Dependency rules*).
 */

/** The mod's default `contextCap` (blocks), the per-call cap of a read (`13`, *Measured on Craftoria*). */
export const DEFAULT_CONTEXT_CAP = 4_194_304;
/** The view's name as a document (its captions say "world"). */
export const WORLD_VIEW_NAME = "world-view";

export interface WorldViewOptions {
  bridge: Pick<BridgeConnection, "request" | "on" | "connected">;
  /** The in-game request the view belongs to now (held or open), or undefined. */
  request: () => number | undefined;
  /** The dimension to read when the request's own isn't known (the linked volumes'). */
  dimension?: () => string | undefined;
  /** The game's DataVersion, for the view's document. */
  dataVersion?: () => number;
  palettes?: () => PaletteBook | undefined;
  /** Per-call cap in blocks (default `DEFAULT_CONTEXT_CAP`). */
  contextCap?: number;
}

/** How a part of the view was read: full blocks, coarse cells (`18`, piece 5) or a surface map (piece 10). */
export type ReadLevel = "full" | "coarse" | "surface";

/** One read held by the view (world, half-open box; a coarse box is aligned to its cells). */
export interface ReadPart {
  box: Box;
  level: ReadLevel;
  /** Coarse cell size (2 or 4). */
  cell?: CoarseCell;
}

/** What one read added. */
export interface ViewRead {
  /** Boxes read (world, half-open; coarse boxes grown to whole cells). */
  boxes: Box[];
  /** Positions covered (a surface read: columns). */
  blocks: number;
  /** Non-air blocks written (coarse: non-air cells; surface: columns whose top block was kept). */
  solid: number;
  dimension: string;
  level: ReadLevel;
  /** Coarse cell size. */
  cell?: CoarseCell;
  /** Surface read: columns whose top block lies outside the box's y range (left out). */
  outside?: number;
  /** Chunks `[cx, cz]` that aren't generated (read as air, or no surface). */
  missing?: [number, number][];
}

/** A part of the view held at coarse level, for the render caption. */
export interface CoarsePart {
  box: Box;
  cell: CoarseCell;
  /** Some of it has since been read at full detail. */
  partial: boolean;
  /**
   * Boxes of the other reads that meet it (full, surface, or coarse at another cell size), where its
   * cells may no longer be uniform: the render draws those per block, every other cell as one cube.
   */
  except?: Box[];
}

interface ViewState {
  request: number | undefined;
  dimension: string | undefined;
  doc: Document;
  parts: ReadPart[];
}

/** Contexts kept for recent prompts, by request id (their dimension and the player's position). */
const KEEP_CONTEXTS = 16;

export class WorldView {
  private state?: ViewState;
  private readonly contexts = new Map<number, GameContext>();
  private readonly off: () => void;

  constructor(private readonly opts: WorldViewOptions) {
    this.off = opts.bridge.on("prompt", (m) => {
      this.contexts.set(m.id, m.context);
      if (this.contexts.size > KEEP_CONTEXTS) this.contexts.delete(this.contexts.keys().next().value!);
    });
  }

  get contextCap(): number {
    return this.opts.contextCap ?? DEFAULT_CONTEXT_CAP;
  }

  /** The request the view's contents belong to. */
  get request(): number | undefined {
    return this.fresh().request;
  }

  /** The game context the request's prompt carried (dimension, player position), when known. */
  get context(): GameContext | undefined {
    const id = this.opts.request();
    return id === undefined ? undefined : this.contexts.get(id);
  }

  /** The dimension reads go to: the request's, else the linked one. */
  get dimension(): string | undefined {
    return this.context?.dimension ?? this.opts.dimension?.();
  }

  /** The view's document (world coordinates, read-only); empty until something is read. */
  get doc(): Document {
    return this.fresh().doc;
  }

  /** The boxes read so far for this request (world, half-open), oldest first, at any level. */
  get reads(): readonly Box[] {
    return this.fresh().parts.map((p) => p.box);
  }

  /** The reads with their level (full, coarse, surface), oldest first. */
  get parts(): readonly ReadPart[] {
    return this.fresh().parts;
  }

  /** Whether the view holds nothing yet. */
  get empty(): boolean {
    return this.fresh().parts.length === 0;
  }

  /**
   * Whether a world position has been read for this request, at full detail or coarse. A surface
   * read holds only its columns' top blocks, so it doesn't count.
   */
  has(pos: Vec3): boolean {
    return this.fresh().parts.some((p) => p.level !== "surface" && containsPoint(p.box, ...pos));
  }

  /** Whether a world position is held at coarse level only (no full-detail read covers it). */
  isCoarse(pos: Vec3): boolean {
    const parts = this.fresh().parts;
    return parts.some((p) => p.level === "coarse" && containsPoint(p.box, ...pos)) && !parts.some((p) => p.level === "full" && containsPoint(p.box, ...pos));
  }

  /**
   * The coarse parts, each with whether a full-detail read has since replaced some of it (render
   * caption) and the other reads that meet it (where the render draws its cells per block).
   */
  coarseParts(): CoarsePart[] {
    const parts = this.fresh().parts;
    const full = parts.filter((p) => p.level === "full");
    return parts
      .filter((p) => p.level === "coarse")
      .map((p) => {
        const except = parts.filter((o) => o !== p && !(o.level === "coarse" && o.cell === p.cell) && !isEmptyBox(intersectBox(o.box, p.box))).map((o) => o.box);
        return { box: p.box, cell: p.cell!, partial: full.some((f) => !isEmptyBox(intersectBox(f.box, p.box))), ...(except.length ? { except } : {}) };
      });
  }

  /** Empties the view (it also empties itself when the request changes). */
  clear(): void {
    this.state = undefined;
  }

  /** Stops listening to the bridge. */
  close(): void {
    this.off();
  }

  /**
   * Reads blocks into the view: `boxes` are world boxes (public, inclusive), `sections` are section
   * coordinates (16³ each). One `snapshot` request at full detail. Past `contextCap`, or when the
   * mod answers `too_large`, the read goes **coarse** (`18`, piece 5): the smallest cell (2, then 4)
   * whose cell count fits the cap, each cell drawn whole as its most common non-air block. Coarse
   * cells never overwrite positions already read at full detail; a later full read replaces coarse
   * cells. Refused when even 4³ cells are over the cap.
   */
  async read(what: { boxes: PublicBox[] } | { sections: Vec3[] }): Promise<ViewRead> {
    const st = this.fresh();
    const dimension = this.dimensionFor(st);
    const boxes = "boxes" in what ? what.boxes.map(fromPublic) : what.sections.map(sectionBox);
    if (!boxes.length) throw new Error("nothing to read: give at least one box");
    const blocks = boxes.reduce((n, b) => n + boxVolume(b), 0);
    if (blocks <= this.contextCap) {
      try {
        const snap = "boxes" in what ? await this.opts.bridge.request({ type: "snapshot", dimension, boxes: boxes.map(toWire) }) : await this.opts.bridge.request({ type: "snapshot", dimension, sections: what.sections });
        this.checkSame(st);
        const solid = write(st.doc, snap);
        for (const r of snap.regions) this.hold(st, { box: fromWire(r.box), level: "full" });
        return { boxes, blocks, solid, dimension, level: "full", ...(snap.missing?.length ? { missing: snap.missing } : {}) };
      } catch (e) {
        // The mod's own cap may be lower than the MCP's assumption: fall back to coarse.
        if ((e as { refusal?: string }).refusal !== "too_large") throw e;
      }
    }
    return this.readCoarse(st, dimension, boxes, blocks);
  }

  /**
   * Reads a shape's sections plus `margin` blocks around them (`18`, piece 5; snapshot kind `mask`):
   * what a fill or an expand reads into the view for its candidate (T2). The margin is measured from
   * the sections' boxes (`13`, *Select*), so the regions are `maskRegions`, the same layout the mod
   * answers with. Past `contextCap`, or answered `too_large`, the same regions are read coarse, as
   * `read` does.
   */
  async readMask(sections: readonly Vec3[], margin: number = MASK_MARGIN): Promise<ViewRead> {
    const st = this.fresh();
    const dimension = this.dimensionFor(st);
    if (!sections.length) throw new Error("no sections to read");
    const boxes = maskRegions(sections, margin).map(fromWire);
    const blocks = boxes.reduce((n, b) => n + boxVolume(b), 0);
    if (blocks <= this.contextCap) {
      try {
        const snap = await this.opts.bridge.request({ type: "snapshot", dimension, kind: "mask", sections: [...sections], ...(margin !== MASK_MARGIN ? { margin } : {}) });
        this.checkSame(st);
        const solid = write(st.doc, snap);
        for (const r of snap.regions) this.hold(st, { box: fromWire(r.box), level: "full" });
        return { boxes, blocks, solid, dimension, level: "full", ...(snap.missing?.length ? { missing: snap.missing } : {}) };
      } catch (e) {
        if ((e as { refusal?: string }).refusal !== "too_large") throw e;
      }
    }
    return this.readCoarse(st, dimension, boxes, blocks);
  }

  /**
   * A surface read for terrain (`18`, piece 10): per column of the box, the topmost non-air block
   * (today's surface snapshot), written at its own height when that lies within the box's y range;
   * the columns whose top lies outside it are left out and counted. Capped by `contextCap` columns.
   */
  async readSurface(pub: PublicBox): Promise<ViewRead> {
    const st = this.fresh();
    const dimension = this.dimensionFor(st);
    const box = fromPublic(pub);
    const columns = (box.max[0] - box.min[0]) * (box.max[2] - box.min[2]);
    if (columns > this.contextCap)
      throw refusal("world_view_too_large", `That surface read is ${columns.toLocaleString("en-US")} columns, over the per-read cap of ${this.contextCap.toLocaleString("en-US")} (contextCap): read a smaller area, or several in turn.`);
    const snap = await this.opts.bridge.request({ type: "snapshot", dimension, kind: "surface", columns: { min: [box.min[0], box.min[2]], max: [box.max[0] - 1, box.max[2] - 1] } });
    this.checkSame(st);
    const doc = st.doc;
    const ids = snap.palette.map((s) => doc.states.intern(airy(s) ? AIR : s));
    const [ox, oy, oz] = doc.origin;
    const sx = box.max[0] - box.min[0];
    let solid = 0, outside = 0;
    let held: Box | undefined;
    for (let i = 0; i < columns; i++) {
      const h = snap.surface.heights[i]!;
      if (h === 0) continue;
      const x = box.min[0] + (i % sx), z = box.min[2] + Math.floor(i / sx), y = snap.minY + h - 1;
      if (y < box.min[1] || y >= box.max[1]) {
        outside++;
        continue;
      }
      doc.voxels.set(x + ox, y + oy, z + oz, ids[snap.surface.states[i]!]!);
      solid++;
      held = unionBox(held, { min: [x, y, z], max: [x + 1, y + 1, z + 1] });
    }
    this.hold(st, { box, level: "surface" }, held);
    return { boxes: [box], blocks: columns, solid, dimension, level: "surface", outside, ...(snap.missing.length ? { missing: snap.missing } : {}) };
  }

  /** A coarse read of `boxes`: the smallest cell whose count fits the cap, the next one on `too_large`. */
  private async readCoarse(st: ViewState, dimension: string, boxes: Box[], blocks: number): Promise<ViewRead> {
    const fits = COARSE_CELLS.filter((c) => boxes.reduce((n, b) => n + boxVolume(alignBox(b, c)) / c ** 3, 0) <= this.contextCap);
    for (const cell of fits) {
      let snap: CoarseResult;
      try {
        snap = await this.opts.bridge.request({ type: "snapshot", dimension, kind: "coarse", cell, boxes: boxes.map(toWire) });
      } catch (e) {
        if ((e as { refusal?: string }).refusal === "too_large") continue;
        throw e;
      }
      this.checkSame(st);
      const full = st.parts.filter((p) => p.level === "full").map((p) => p.box);
      const solid = writeCoarse(st.doc, snap, full);
      const aligned = snap.regions.map((r) => fromWire(r.box));
      for (const b of aligned) this.hold(st, { box: b, level: "coarse", cell });
      return { boxes: aligned, blocks, solid, dimension, level: "coarse", cell, ...(snap.missing?.length ? { missing: snap.missing } : {}) };
    }
    throw refusal(
      "world_view_too_large",
      `That read is ${blocks.toLocaleString("en-US")} blocks: over the per-read cap of ${this.contextCap.toLocaleString("en-US")} (contextCap) even at one block per 4³ cell. Read part of it, or several parts in turn.`,
    );
  }

  /** The dimension to read for this view; refuses when disconnected or unknown. */
  private dimensionFor(st: ViewState): string {
    if (!this.opts.bridge.connected) throw refusal("world_disconnected", "No game is connected, so the world view can't read anything.");
    if (!st.dimension) throw refusal("world_view_no_request", "The world view doesn't know which dimension to read: no in-game request is open and nothing is linked.");
    return st.dimension;
  }

  /** The request may have changed while a read was in flight: write into the view it was read for only. */
  private checkSame(st: ViewState): void {
    if (this.fresh() !== st) throw refusal("world_view_stale", "The in-game request changed while the world view was reading; read again for the new request.");
  }

  /** Records a read and grows the view's bounds (by `bounds` when given, else the read's box). */
  private hold(st: ViewState, part: ReadPart, bounds: Box | undefined = part.box): void {
    st.parts.push(part);
    if (bounds) st.doc.bounds = unionBox(st.doc.bounds, st.doc.boxToStore(bounds));
    st.doc.revision++;
  }

  /** One line for a read's tool result (`world_view_read`). */
  describe(r: ViewRead): string {
    const where = r.boxes.map((b) => formatBox(b)).join(", ");
    const parts = this.parts;
    const all = parts.reduce<Box | undefined>((u, p) => unionBox(u, p.box), undefined);
    const n = (k: number) => k.toLocaleString("en-US");
    const what =
      r.level === "full"
        ? `${n(r.blocks)} blocks (${n(r.solid)} non-air) at ${where}`
        : r.level === "coarse"
          ? `${n(r.blocks)} blocks over the per-read cap of ${n(this.contextCap)}, so read coarse: one block per ${r.cell}³ cell (the cell's most common non-air block, drawn over the whole cell; ${n(r.solid)} non-air cells) at ${where}`
          : `the surface of ${n(r.blocks)} columns at ${where}: ${n(r.solid)} top blocks kept, one per column${r.outside ? `, ${n(r.outside)} columns whose top lies outside the box's y range left out` : ""} (only the top block of each column is read; nothing below it)`;
    const levels = new Set(parts.map((p) => p.level));
    return (
      `ok · world_view_read · ${what} in ${r.dimension}.` +
      (r.level === "coarse" ? " Positions already held at full detail were kept; read a smaller box there to replace coarse cells with full detail." : "") +
      (r.missing?.length ? ` ${r.missing.length} chunk${r.missing.length === 1 ? " isn't" : "s aren't"} generated (read as nothing): ${r.missing.slice(0, 8).map((c) => `[${c.join(",")}]`).join(" ")}${r.missing.length > 8 ? " …" : ""}.` : "") +
      ` The world view now holds ${parts.length} read${parts.length === 1 ? "" : "s"}${levels.size > 1 || !levels.has("full") ? ` (${[...levels].join(", ")})` : ""}${all ? ` within ${formatBox(all)}` : ""}, in world coordinates; ` +
      'look with view:"world" on render, view_slice, raycast, select and analyze. Nothing in it reaches the world.'
    );
  }

  /** The view for the current request, emptied when the request (or its dimension) changed. */
  private fresh(): ViewState {
    const request = this.opts.request();
    const dimension = this.dimension;
    const st = this.state;
    if (st && st.request === request && (st.dimension === dimension || st.parts.length === 0)) {
      st.dimension = dimension;
      return st;
    }
    const doc = Document.create({ name: WORLD_VIEW_NAME, dataVersion: this.opts.dataVersion?.() ?? 0, ...(this.opts.palettes?.() ? { palettes: this.opts.palettes()! } : {}) });
    doc.meta.source = `world:view ${dimension ?? "?"}`;
    // Local = world: anchor the store at the player when known, so store coordinates stay small.
    const p = this.context?.position;
    doc.origin = p ? [-Math.floor(p[0]), -Math.floor(p[1]), -Math.floor(p[2])] : [0, 0, 0];
    doc.guards.push(readOnly);
    this.state = { request, dimension, doc, parts: [] };
    return this.state;
  }
}

/** Refuses every edit on the view. */
const readOnly: WriteGuard = (_changes, op) => {
  throw refusal(
    "world_view_read_only",
    `The world view is a read-only look at the world, so ${op} can't edit it; nothing in it reaches the world. ` +
      "Build on the open document (the linked one once the player marks a work volume), or ask the player for a build request.",
  );
};

const AIR = "minecraft:air";
const airy = (s: string) => s === AIR || s === "minecraft:cave_air" || s === "minecraft:void_air";

/** Writes a snapshot's blocks at their world positions (local = world); returns the non-air count. */
function write(doc: Document, snap: SnapshotResult): number {
  const ids = snap.palette.map((s) => doc.states.intern(airy(s) ? AIR : s));
  const [ox, oy, oz] = doc.origin;
  let solid = 0;
  for (const r of snap.regions) {
    const { min, max } = r.box;
    // A re-read replaces what was there, block entities included.
    for (const k of [...doc.blockEntities.keys()]) {
      const [x, y, z] = k.split(",").map(Number) as Vec3;
      if (x - ox >= min[0] && x - ox <= max[0] && y - oy >= min[1] && y - oy <= max[1] && z - oz >= min[2] && z - oz <= max[2]) doc.blockEntities.delete(k);
    }
    let i = 0;
    for (let y = min[1]; y <= max[1]; y++)
      for (let z = min[2]; z <= max[2]; z++)
        for (let x = min[0]; x <= max[0]; x++) {
          const id = ids[r.states[i++]!]!;
          if (id !== 0) solid++;
          doc.voxels.set(x + ox, y + oy, z + oz, id);
        }
    for (const be of r.blockEntities) doc.blockEntities.set(`${be.pos[0] + ox},${be.pos[1] + oy},${be.pos[2] + oz}`, be.nbt);
  }
  return solid;
}

/**
 * Writes a coarse snapshot (`18`, piece 5): each cell's block over the whole cell, at its world
 * positions, except positions inside `keep` (already read at full detail). Returns the non-air cells.
 */
function writeCoarse(doc: Document, snap: CoarseResult, keep: readonly Box[]): number {
  const ids = snap.palette.map((s) => doc.states.intern(airy(s) ? AIR : s));
  const [ox, oy, oz] = doc.origin;
  const c = snap.cell;
  let solid = 0;
  for (const r of snap.regions) {
    const box = fromWire(r.box);
    const kept = keep.filter((k) => !isEmptyBox(intersectBox(k, box)));
    const n: Vec3 = [(box.max[0] - box.min[0]) / c, (box.max[1] - box.min[1]) / c, (box.max[2] - box.min[2]) / c];
    let i = 0;
    for (let cy = 0; cy < n[1]; cy++)
      for (let cz = 0; cz < n[2]; cz++)
        for (let cx = 0; cx < n[0]; cx++) {
          const id = ids[r.states[i++]!]!;
          if (id !== 0) solid++;
          const x0 = box.min[0] + cx * c, y0 = box.min[1] + cy * c, z0 = box.min[2] + cz * c;
          for (let y = y0; y < y0 + c; y++)
            for (let z = z0; z < z0 + c; z++)
              for (let x = x0; x < x0 + c; x++) {
                if (kept.length && kept.some((k) => containsPoint(k, x, y, z))) continue;
                doc.blockEntities.delete(`${x + ox},${y + oy},${z + oz}`);
                doc.voxels.set(x + ox, y + oy, z + oz, id);
              }
        }
  }
  return solid;
}

/** A box grown outward to whole cells of the world grid (as the mod aligns a coarse read). */
function alignBox(b: Box, c: number): Box {
  const lo = (v: number) => Math.floor(v / c) * c, hi = (v: number) => Math.ceil(v / c) * c;
  return { min: [lo(b.min[0]), lo(b.min[1]), lo(b.min[2])], max: [hi(b.max[0]), hi(b.max[1]), hi(b.max[2])] };
}

const toWire = (b: Box): WireBox => ({ min: b.min, max: [b.max[0] - 1, b.max[1] - 1, b.max[2] - 1] });
const fromWire = (b: WireBox): Box => ({ min: [...b.min], max: [b.max[0] + 1, b.max[1] + 1, b.max[2] + 1] });

const sectionBox = (s: Vec3): Box => ({ min: [s[0] * 16, s[1] * 16, s[2] * 16], max: [s[0] * 16 + 16, s[1] * 16 + 16, s[2] * 16 + 16] });
