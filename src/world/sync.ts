import type { Compound } from "prismarine-nbt";
import { AIR } from "../core/blockstate.js";
import type { Box, Vec3 } from "../core/region.js";
import type { Document, EditResult } from "../document/document.js";
import type { JournalEntry } from "../document/journal.js";
import { nbtHash, sectionHash, sectionsOf } from "./protocol/hash.js";
import type { Hash64, SectionHash, SnapshotRegion, VolatileList, WireBox, WorldBlock } from "./protocol/messages.js";
import { encodeNbt } from "./protocol/nbt.js";

/**
 * World → cache sync (docs/design/13-live-world.md, *World → agent: sync*, W5). The only way world
 * data enters a linked document: every write is one journal entry with op name `world_sync`.
 *
 * - Writes are raw: the world's states are the truth, so no connection properties are recomputed.
 * - The write guard doesn't run (`Document.editUnguarded`): locks and the root's work-volume rule
 *   bind agents, and a sync writes context positions too (13, *Scoped sessions*).
 * - A sync pushes nothing. The patch sender recognises its entries by `isWorldSync` and never sends
 *   them (13, *Pushes nothing*).
 * - Metadata survives: an edit never touches saved selections, anchors, palettes or checkpoints,
 *   and a sync never touches components; the result counts the blocks it changed inside each
 *   component instead (13, *Metadata survives*).
 *
 * Positions arrive in world coordinates. `origin` is the world position of the document's local
 * (0,0,0), the work volume's minimum corner (13, *Frame*).
 */

/** Op name of every sync entry. */
export const WORLD_SYNC = "world_sync";

/** True for a `world_sync` journal entry: written from the world, never sent back as a patch. */
export function isWorldSync(e: Pick<JournalEntry, "op">): boolean {
  return e.op === WORLD_SYNC;
}

/** World changes to write into the cache, in any combination; applied in the order listed here. */
export interface WorldChanges {
  /** World boxes to clear to air: context the player removed (13, *A context change alone*). Not filtered by `volumes`. */
  clear?: readonly WireBox[];
  /**
   * Whole or section form: a `snapshot.result`'s palette and regions (13, `snapshot.result`). Every
   * position of every region is written (air included); positions outside `volumes` are dropped,
   * since a section snapshot reads whole sections.
   */
  snapshot?: { palette: readonly string[]; regions: readonly SnapshotRegion[] };
  /**
   * Partial form: blocks as the world holds them, from a `dirty` notice or an ack's skipped list.
   * A block without `nbt` has no block entity.
   */
  blocks?: readonly WorldBlock[];
  /** Block entities only, the state unchanged: an ack's normalized list. No `nbt` means "no block entity". */
  nbt?: readonly { pos: Vec3; nbt?: Compound }[];
}

export interface SyncOptions {
  /** World position of local (0,0,0). Default (0,0,0). */
  origin?: Vec3;
  /** World boxes the cache holds (the work and context volumes, inclusive). Writes outside them are dropped. Default: no filter. */
  volumes?: readonly WireBox[];
  /**
   * Volatile-key list (13, *Hashing*): a block entity whose NBT hashes the same as the cache's is
   * left alone, so a ticking furnace doesn't count as a change. Without it, NBT is compared exactly.
   */
  volatile?: VolatileList;
  /** Journal summary; default "world sync: <n> positions". */
  summary?: string;
}

export interface SyncResult extends EditResult {
  /** Components the sync changed blocks inside, with the count (13, *Metadata survives*). */
  components: { id: string; changed: number }[];
}

/**
 * Writes world states and NBT into the cache as one `world_sync` entry (see the module comment).
 * Positions whose state and NBT already match are left alone, so an unchanged world adds no entry
 * (`changed` 0, `seq` the current head).
 *
 * A sync is an edit, so committing it discards the redo tail, as any edit does (13, *World undo and
 * restore*, resolved).
 */
export function applyWorldState(doc: Document, changes: WorldChanges, opts: SyncOptions = {}): SyncResult {
  const [ox, oy, oz] = opts.origin ?? [0, 0, 0];
  const keep = opts.volumes;
  const inside = (x: number, y: number, z: number) => !keep || keep.some((b) => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]);
  const same = sameNbt(opts.volatile);

  const r = doc.editUnguarded(WORLD_SYNC, opts.summary ?? describe(changes), (tx) => {
    /** Writes one world block at a world position, unless the cache already holds it. */
    const put = (x: number, y: number, z: number, state: string | number, nbt: Compound | undefined) => {
      const lx = x - ox, ly = y - oy, lz = z - oz;
      const id = typeof state === "number" ? state : tx.intern(state === "minecraft:cave_air" || state === "minecraft:void_air" ? AIR : state);
      if (tx.getId(lx, ly, lz) === id && same(doc.getBlockEntity(lx, ly, lz), id === 0 ? undefined : nbt)) return;
      tx.set(lx, ly, lz, id, nbt ?? null);
    };

    for (const b of changes.clear ?? []) forBox(b, (x, y, z) => put(x, y, z, 0, undefined));

    const snap = changes.snapshot;
    if (snap) {
      const ids = snap.palette.map((s) => tx.intern(s === "minecraft:cave_air" || s === "minecraft:void_air" ? AIR : s));
      for (const region of snap.regions) {
        const nbtAt = new Map(region.blockEntities.map((e) => [key(e.pos), e.nbt]));
        let i = 0;
        forBox(region.box, (x, y, z) => {
          const p = region.states[i++]!;
          if (!inside(x, y, z)) return;
          const id = ids[p];
          if (id === undefined) throw new Error(`world sync: palette index ${p} out of range`);
          put(x, y, z, id, nbtAt.get(key([x, y, z])));
        });
      }
    }

    for (const b of changes.blocks ?? []) if (inside(...b.pos)) put(...b.pos, b.state, b.nbt);

    for (const n of changes.nbt ?? []) {
      if (!inside(...n.pos)) continue;
      const [x, y, z] = n.pos;
      put(x, y, z, tx.getId(x - ox, y - oy, z - oz), n.nbt);
    }
  });

  const entry = r.changed ? lastEntry(doc, r.seq) : undefined;
  const { value: _value, ...edit } = r;
  return { ...edit, components: entry ? componentDrift(doc, entry) : [] };
}

/** Default journal summary: what the world reported, e.g. "world sync: 3 blocks, 1 block entity". */
function describe(c: WorldChanges): string {
  const n = (k: number, one: string, many = `${one}s`) => `${k.toLocaleString("en-US")} ${k === 1 ? one : many}`;
  const parts: string[] = [];
  if (c.clear?.length) parts.push(`cleared ${n(c.clear.length, "box", "boxes")}`);
  if (c.snapshot) parts.push(`snapshot of ${n(c.snapshot.regions.length, "region")}`);
  if (c.blocks?.length) parts.push(n(c.blocks.length, "block"));
  if (c.nbt?.length) parts.push(n(c.nbt.length, "block entity", "block entities"));
  return `world sync: ${parts.join(", ") || "nothing"}`;
}

// -- section-hash sync ----------------------------------------------------------------------------

/** The two requests a section-hash sync makes of the mod (13, `hashes` and `snapshot`); the bridge provides them. */
export interface WorldSource {
  hashes(boxes: WireBox[]): Promise<SectionHash[]>;
  snapshot(req: { sections: Vec3[] }): Promise<{ palette: readonly string[]; regions: readonly SnapshotRegion[] }>;
}

/** Where the cache sits in the world: the link's frame, volumes and volatile list. */
export interface LinkFrame {
  /** World position of local (0,0,0). */
  origin: Vec3;
  /** The work volume (or its whole-block extension) and every context box, world coordinates. */
  volumes: WireBox[];
  volatile: VolatileList;
}

export interface SectionSyncResult extends SyncResult {
  /** Sections compared, and those whose hashes differed (and were snapshotted). */
  sections: { compared: number; differing: Vec3[] };
}

/**
 * Section-hash sync (13, *Section hashes instead of full snapshots*): asks the mod for the hash of
 * every section the volumes touch, compares them with the cache's, snapshots only the sections
 * that differ and applies them as one `world_sync` entry. Used by the `world_sync` tool, auto-sync
 * after an "everything" dirty notice, and reconnects. Catches contents-only changes too, which no
 * dirty notice reports.
 */
export async function syncBySections(doc: Document, source: WorldSource, frame: LinkFrame, opts: { summary?: string } = {}): Promise<SectionSyncResult> {
  const theirs = await source.hashes(frame.volumes);
  const mine = cacheHashes(doc, frame);
  const differing: Vec3[] = [];
  const seen = new Set<string>();
  for (const s of theirs) {
    const k = key(s.section);
    seen.add(k);
    if (mine.get(k) !== s.hash) differing.push(s.section);
  }
  // A section the cache hashes but the world didn't list can't happen with the same boxes; snapshot it anyway.
  for (const [k, h] of mine) if (h !== undefined && !seen.has(k)) differing.push(k.split(",").map(Number) as Vec3);
  const compared = seen.size;
  if (!differing.length) return { op: WORLD_SYNC, seq: doc.journal.headSeq, changed: 0, warnings: [], components: [], sections: { compared, differing } };
  const snap = await source.snapshot({ sections: differing });
  const r = applyWorldState(doc, { snapshot: snap }, {
    origin: frame.origin,
    volumes: frame.volumes,
    volatile: frame.volatile,
    summary: opts.summary ?? `world sync: ${differing.length} of ${compared} section${compared === 1 ? "" : "s"} differed`,
  });
  return { ...r, sections: { compared, differing } };
}

/**
 * The cache's section hashes over the frame's volumes, by "sx,sy,sz" (undefined: no position of
 * the section lies in the volumes). Kept per document and updated incrementally: every voxel write
 * invalidates its section (`VoxelStore.onWrite`), so comparing a large volume rehashes only the
 * sections written since the last comparison. A change of frame (volumes, origin, volatile list)
 * starts over.
 */
export function cacheHashes(doc: Document, frame: LinkFrame): Map<string, Hash64 | undefined> {
  const c = hashCacheOf(doc, frame);
  const out = new Map<string, Hash64 | undefined>();
  const read = (x: number, y: number, z: number) => {
    const lx = x - frame.origin[0], ly = y - frame.origin[1], lz = z - frame.origin[2];
    const s = doc.getState(lx, ly, lz);
    const state = s === "minecraft:cave_air" || s === "minecraft:void_air" ? AIR : s;
    return { state, nbt: doc.getBlockEntity(lx, ly, lz) };
  };
  for (const s of sectionsOf(frame.volumes)) {
    const k = key(s);
    if (!c.hashes.has(k)) c.hashes.set(k, sectionHash(s, frame.volumes, read, frame.volatile));
    out.set(k, c.hashes.get(k));
  }
  return out;
}

interface HashCache {
  frameKey: string;
  /** World minus store coordinates, as of the frame key. */
  shift: Vec3;
  hashes: Map<string, Hash64 | undefined>;
}

const hashCaches = new WeakMap<Document, HashCache>();

function hashCacheOf(doc: Document, frame: LinkFrame): HashCache {
  // World = store − doc.origin + frame.origin; an explicit re-origin of the document changes it too.
  const shift: Vec3 = [frame.origin[0] - doc.origin[0], frame.origin[1] - doc.origin[1], frame.origin[2] - doc.origin[2]];
  const frameKey = JSON.stringify([shift, frame.volumes, frame.volatile]);
  let c = hashCaches.get(doc);
  if (c && c.frameKey === frameKey) return c;
  const cache: HashCache = { frameKey, shift, hashes: new Map() };
  hashCaches.set(doc, cache);
  doc.voxels.onWrite = (x, y, z) => {
    if (cache.hashes.size) cache.hashes.delete(`${(x + cache.shift[0]) >> 4},${(y + cache.shift[1]) >> 4},${(z + cache.shift[2]) >> 4}`);
  };
  c = cache;
  return c;
}

/** Blocks changed by an entry inside each component's box (store coordinates, half-open). */
function componentDrift(doc: Document, e: JournalEntry): { id: string; changed: number }[] {
  const out: { id: string; changed: number }[] = [];
  for (const c of doc.components.values()) {
    const b: Box = c.box;
    let n = 0;
    for (let i = 0; i < e.positions.length; i += 3) {
      const x = e.positions[i]!, y = e.positions[i + 1]!, z = e.positions[i + 2]!;
      if (x >= b.min[0] && x < b.max[0] && y >= b.min[1] && y < b.max[1] && z >= b.min[2] && z < b.max[2]) n++;
    }
    if (n) out.push({ id: c.id, changed: n });
  }
  return out;
}

function lastEntry(doc: Document, seq: number): JournalEntry | undefined {
  const j = doc.journal;
  const e = j.entries[j.cursor - 1];
  return e?.seq === seq ? e : undefined;
}

/** Whether the cache's block entity already matches the world's (volatile keys ignored when a list is given). */
function sameNbt(volatile: VolatileList | undefined): (a: Compound | undefined, b: Compound | undefined) => boolean {
  return (a, b) => {
    if (!a || !b) return a === b;
    if (a === b) return true;
    if (volatile) {
      const ha = nbtHash(a, volatile), hb = nbtHash(b, volatile);
      if (ha !== undefined && hb !== undefined) return ha === hb;
    }
    return bytesEqual(encodeNbt(a), encodeNbt(b));
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Visits an inclusive world box in snapshot order: x fastest, then z, then y. */
function forBox(b: WireBox, fn: (x: number, y: number, z: number) => void): void {
  for (let y = b.min[1]; y <= b.max[1]; y++) for (let z = b.min[2]; z <= b.max[2]; z++) for (let x = b.min[0]; x <= b.max[0]; x++) fn(x, y, z);
}

const key = (p: Vec3) => `${p[0]},${p[1]},${p[2]}`;
