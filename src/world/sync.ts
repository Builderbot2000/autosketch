import type { Compound } from "prismarine-nbt";
import { AIR } from "../core/blockstate.js";
import type { Box, Vec3 } from "../core/region.js";
import type { Document, EditResult } from "../document/document.js";
import type { JournalEntry } from "../document/journal.js";
import { nbtHash } from "./protocol/hash.js";
import type { SnapshotRegion, VolatileList, WireBox, WorldBlock } from "./protocol/messages.js";
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
