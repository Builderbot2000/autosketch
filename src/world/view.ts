import { boxVolume, formatBox, fromPublic, unionBox, type Box, type PublicBox, type Vec3 } from "../core/region.js";
import { Document, type WriteGuard } from "../document/document.js";
import type { PaletteBook } from "../palette/pick.js";
import { refusal } from "../scope/scopes.js";
import type { BridgeConnection } from "./bridge.js";
import type { GameContext, SnapshotResult, WireBox } from "./protocol/messages.js";

/**
 * The world view (docs/design/18-select.md, piece 5): a read-only look at the world held **beside**
 * the open document, never in place of it, so it coexists with a linked document and with open
 * sandboxes (the scan probe replaced the document instead, `Session.adoptTemporary`).
 *
 * - **A document in world coordinates.** The view keeps the blocks it has read in an ordinary
 *   `Document` whose local coordinates are the world's: `doc.origin` is set so store coordinates stay
 *   near zero (the voxel store's range) while every position a tool sees or gives is a world
 *   position. So `render`, `view_slice`, `raycast`, `select` and `analyze` work on it unchanged, and
 *   named selections (`candidate`) live in its `selections` like any document's.
 * - **Read-only.** Every edit on it is refused with `world_view_read_only` (a write guard, so ops,
 *   scripts, undo and restore are all covered). Reads write the voxels directly, as the probe does.
 * - **Per request.** It holds what was read for the current in-game request (`request()`), in that
 *   request's dimension, and starts empty again when the request changes or ends. With no request
 *   open it belongs to "no request" and the linked dimension.
 * - **Reads are snapshots** (`13`, `snapshot` by boxes or sections), capped per call by `contextCap`
 *   (the mod's cap; the mod refuses past its own). A later read of the same place replaces it.
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

/** What one read added. */
export interface ViewRead {
  /** Boxes read (world, half-open). */
  boxes: Box[];
  blocks: number;
  /** Non-air blocks among them. */
  solid: number;
  dimension: string;
}

/** Contexts kept for recent prompts, by request id (their dimension and the player's position). */
const KEEP_CONTEXTS = 16;

export class WorldView {
  private state?: { request: number | undefined; dimension: string | undefined; doc: Document; reads: Box[] };
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

  /** The boxes read so far for this request (world, half-open), oldest first. */
  get reads(): readonly Box[] {
    return this.fresh().reads;
  }

  /** Whether the view holds nothing yet. */
  get empty(): boolean {
    return this.fresh().reads.length === 0;
  }

  /** Whether a world position has been read for this request. */
  has(pos: Vec3): boolean {
    const [x, y, z] = pos;
    return this.fresh().reads.some((b) => x >= b.min[0] && x < b.max[0] && y >= b.min[1] && y < b.max[1] && z >= b.min[2] && z < b.max[2]);
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
   * coordinates (16³ each). One `snapshot` request; refused past `contextCap` before sending.
   */
  async read(what: { boxes: PublicBox[] } | { sections: Vec3[] }): Promise<ViewRead> {
    const st = this.fresh();
    const dimension = st.dimension;
    if (!this.opts.bridge.connected) throw refusal("world_disconnected", "No game is connected, so the world view can't read anything.");
    if (!dimension) throw refusal("world_view_no_request", "The world view doesn't know which dimension to read: no in-game request is open and nothing is linked.");
    const boxes = "boxes" in what ? what.boxes.map(fromPublic) : what.sections.map(sectionBox);
    if (!boxes.length) throw new Error("nothing to read: give at least one box");
    const blocks = boxes.reduce((n, b) => n + boxVolume(b), 0);
    if (blocks > this.contextCap)
      throw refusal("world_view_too_large", `That read is ${blocks.toLocaleString("en-US")} blocks, over the per-read cap of ${this.contextCap.toLocaleString("en-US")} (contextCap): read a smaller box, or several in turn.`);
    const wire: WireBox[] = boxes.map((b) => ({ min: b.min, max: [b.max[0] - 1, b.max[1] - 1, b.max[2] - 1] }));
    const snap = "boxes" in what ? await this.opts.bridge.request({ type: "snapshot", dimension, boxes: wire }) : await this.opts.bridge.request({ type: "snapshot", dimension, sections: what.sections });
    // The request may have changed while the snapshot was in flight: write into the view it was read for only.
    if (this.fresh() !== st) throw refusal("world_view_stale", "The in-game request changed while the world view was reading; read again for the new request.");
    const solid = write(st.doc, snap);
    for (const r of snap.regions) {
      const b: Box = { min: [...r.box.min], max: [r.box.max[0] + 1, r.box.max[1] + 1, r.box.max[2] + 1] };
      st.reads.push(b);
      st.doc.bounds = unionBox(st.doc.bounds, st.doc.boxToStore(b));
    }
    st.doc.revision++;
    return { boxes, blocks, solid, dimension };
  }

  /** One line for a read's tool result (`world_view_read`). */
  describe(r: ViewRead): string {
    const where = r.boxes.map((b) => formatBox(b)).join(", ");
    const reads = this.reads;
    const all = reads.reduce<Box | undefined>((u, b) => unionBox(u, b), undefined);
    return (
      `ok · world_view_read · ${r.blocks.toLocaleString("en-US")} blocks (${r.solid.toLocaleString("en-US")} non-air) at ${where} in ${r.dimension}. ` +
      `The world view now holds ${reads.length} read${reads.length === 1 ? "" : "s"}${all ? ` within ${formatBox(all)}` : ""}, in world coordinates; ` +
      'look with view:"world" on render, view_slice, raycast, select and analyze. Nothing in it reaches the world.'
    );
  }

  /** The view for the current request, emptied when the request (or its dimension) changed. */
  private fresh(): NonNullable<WorldView["state"]> {
    const request = this.opts.request();
    const dimension = this.dimension;
    const st = this.state;
    if (st && st.request === request && (st.dimension === dimension || st.reads.length === 0)) {
      st.dimension = dimension;
      return st;
    }
    const doc = Document.create({ name: WORLD_VIEW_NAME, dataVersion: this.opts.dataVersion?.() ?? 0, ...(this.opts.palettes?.() ? { palettes: this.opts.palettes()! } : {}) });
    doc.meta.source = `world:view ${dimension ?? "?"}`;
    // Local = world: anchor the store at the player when known, so store coordinates stay small.
    const p = this.context?.position;
    doc.origin = p ? [-Math.floor(p[0]), -Math.floor(p[1]), -Math.floor(p[2])] : [0, 0, 0];
    doc.guards.push(readOnly);
    this.state = { request, dimension, doc, reads: [] };
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

const sectionBox = (s: Vec3): Box => ({ min: [s[0] * 16, s[1] * 16, s[2] * 16], max: [s[0] * 16 + 16, s[1] * 16 + 16, s[2] * 16 + 16] });
