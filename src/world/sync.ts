import type { Compound } from "prismarine-nbt";
import { AIR } from "../core/blockstate.js";
import type { Box, Vec3 } from "../core/region.js";
import type { Document, EditResult, WriteGuard } from "../document/document.js";
import type { JournalEntry } from "../document/journal.js";
import { refusal } from "../scope/scopes.js";
import type { BridgeError } from "./bridge.js";
import type { SyncReason, WorldLink } from "./link.js";
import { WORLD_SYNC_OP } from "./no-push.js";
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

/** Op name of every sync entry: P's "does not push" marker (`no-push.ts`). */
export const WORLD_SYNC = WORLD_SYNC_OP;

/** True for a `world_sync` journal entry: written from the world, never sent back as a patch. */
export function isWorldSync(e: Pick<JournalEntry, "op">): boolean {
  return e.op === WORLD_SYNC;
}

/**
 * The sync barrier (13, *World undo and restore*, W6): undo and redo refuse to step past a
 * `world_sync` entry that changed blocks, since going past it would push the pre-sync cache into
 * the world over the player's hand edits. `overwriteHandEdits: true` crosses it. A write guard, so
 * tools, scripts and `restore` (which checks every step first, all or nothing) obey it alike.
 */
export const syncBarrier: WriteGuard = (changes, op) => {
  const e = changes.entry;
  if ((op !== "undo" && op !== "redo") || !e || !isWorldSync(e) || e.before.length === 0 || changes.overwriteHandEdits) return;
  const n = e.before.length;
  throw refusal(
    "sync_barrier",
    `${op} would step past #${e.seq} ${e.summary}, which brought ${n.toLocaleString("en-US")} block${n === 1 ? "" : "s"} changed in the world (mostly the player's hand edits) into the cache. ` +
      `Going past it would push the pre-sync cache into the world and erase those edits. Pass overwriteHandEdits: true only if the player asked to discard their hand edits. Nothing was written.`,
  );
};

/** Installs the sync barrier on a linked document, beside any lock guard (idempotent). */
export function attachSyncBarrier(doc: Document): void {
  if (!doc.guards.includes(syncBarrier)) doc.guards.push(syncBarrier);
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
  /**
   * Block entities only, the state unchanged: an ack's normalized list. No `nbt` means "no block
   * entity". `sent`, with `reconcile`: the NBT the patch wrote there (null: none), when known; the
   * position is reconciled only while the cache still holds it.
   */
  nbt?: readonly { pos: Vec3; nbt?: Compound; sent?: Compound | null }[];
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
  /**
   * Ack handling (13, *World undo and restore*, the redo-tail answer): the `nbt` list is the game's
   * normalization of NBT the patch itself just wrote, not a world change. It is reconciled in place
   * (`reconcileNbt`): no journal entry, so the redo tail survives and no barrier appears. The other
   * forms (an ack's skipped blocks) still commit one `world_sync` entry as usual.
   */
  reconcile?: boolean;
}

export interface SyncResult extends EditResult {
  /** Components the sync changed blocks inside, with the count (13, *Metadata survives*). */
  components: { id: string; changed: number }[];
  /** With `reconcile`: block entities reconciled in place. */
  reconciled?: number;
}

/**
 * Writes world states and NBT into the cache as one `world_sync` entry (see the module comment).
 * Positions whose state and NBT already match are left alone, so an unchanged world adds no entry
 * (`changed` 0, `seq` the current head).
 *
 * A sync is an edit, so committing it discards the redo tail, as any edit does (13, *World undo and
 * restore*, resolved). The exception is an ack's normalized NBT with `reconcile`, which adds no entry.
 */
export function applyWorldState(doc: Document, changes: WorldChanges, opts: SyncOptions = {}): SyncResult {
  const [ox, oy, oz] = opts.origin ?? [0, 0, 0];
  const keep = opts.volumes;
  const inside = (x: number, y: number, z: number) => !keep || keep.some((b) => x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]);
  const same = sameNbt(opts.volatile);
  attachSyncBarrier(doc);
  let reconciled: number | undefined;
  if (opts.reconcile && changes.nbt?.length) {
    reconciled = reconcileNbt(doc, changes.nbt.filter((n) => inside(...n.pos)), [ox, oy, oz], same);
    const { nbt: _nbt, ...rest } = changes;
    changes = rest;
    if (!changes.clear?.length && !changes.snapshot && !changes.blocks?.length)
      return { op: WORLD_SYNC, seq: doc.journal.headSeq, changed: 0, warnings: [], components: [], reconciled };
  }

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
  return { ...edit, components: entry ? componentDrift(doc, entry) : [], ...(reconciled !== undefined ? { reconciled } : {}) };
}

/**
 * Takes the game's normalized form of NBT a patch just wrote into the cache without a journal
 * entry (13, the redo-tail answer). The journal keeps block entities as shared compounds: the
 * object an op wrote is the one its entry records as `after`, the next entry at that position
 * records as `before`, and undo or redo put back. So every in-memory entry's reference to the
 * cache's current compound at the position is replaced by the world's form (or removed, when the
 * game kept no block entity): the history then says what the world holds, and undo and redo write
 * the normalized NBT. Entries already in on-disk segments keep the sent form (segments are
 * immutable); stepping onto them writes the sent NBT, and that patch's ack reconciles again.
 *
 * A position is skipped when `sent` is given and the cache no longer holds it (a newer edit is
 * on its way to the world, and its own ack reports what the world keeps). Returns the count.
 */
function reconcileNbt(doc: Document, list: readonly { pos: Vec3; nbt?: Compound; sent?: Compound | null }[], origin: Vec3, same: (a: Compound | undefined, b: Compound | undefined) => boolean): number {
  let n = 0;
  for (const item of list) {
    const local: Vec3 = [item.pos[0] - origin[0], item.pos[1] - origin[1], item.pos[2] - origin[2]];
    const s = doc.toStore(...local);
    const k = key(s);
    const cur = doc.blockEntities.get(k);
    if (item.sent !== undefined && !same(cur, item.sent ?? undefined)) continue;
    if (same(cur, item.nbt)) continue;
    if (cur)
      for (const e of doc.journal.entries)
        for (const c of e.nbt ?? []) {
          const i = c.index * 3;
          if (e.positions[i] !== s[0] || e.positions[i + 1] !== s[1] || e.positions[i + 2] !== s[2]) continue;
          for (const side of ["before", "after"] as const)
            if (c[side] === cur) {
              if (item.nbt) c[side] = item.nbt;
              else delete c[side];
            }
        }
    if (item.nbt) doc.blockEntities.set(k, item.nbt);
    else doc.blockEntities.delete(k);
    doc.voxels.set(s[0], s[1], s[2], doc.voxels.get(s[0], s[1], s[2])); // same id: only invalidates the cache section hash
    doc.revision++;
    n++;
  }
  return n;
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

// -- on the link ----------------------------------------------------------------------------------

/** The `hashes` and `snapshot` requests over a link's bridge, in the volumes' dimension. */
export function bridgeSource(link: WorldLink, dimension: string): WorldSource {
  return {
    hashes: async (boxes) => (await link.bridge.request({ type: "hashes", dimension, boxes })).sections,
    snapshot: (req) => link.bridge.request({ type: "snapshot", dimension, sections: req.sections }),
  };
}

/** The frame a linked document's cache sits in: the agent's (extended) work volume and every context box. */
export function linkFrame(link: WorldLink): LinkFrame | undefined {
  const v = link.volumes;
  if (!v) return undefined;
  return { origin: v.origin, volumes: [v.extended, ...v.context], volatile: link.volatile };
}

/**
 * The link's sync implementation (`WorldLink.setSync`; 13, *Automatic*, *Manual*). Takes the
 * accumulated dirty notices first. For a `dirty` sync with listed positions it writes them (the
 * partial form, no round trip); after an "everything" notice, on reconnect and for the `world_sync`
 * tool it compares section hashes and snapshots the sections that differ. Resolves undefined when
 * nothing is linked or nothing changed.
 */
export async function syncLink(link: WorldLink, reason: SyncReason): Promise<SyncResult | undefined> {
  const doc = link.doc, v = link.volumes, frame = linkFrame(link);
  if (link.state !== "linked" || !doc || !v || !frame) return undefined;
  const dirty = link.takeDirty();
  let r: SyncResult;
  if (reason === "dirty" && dirty && !dirty.everything) {
    if (!dirty.blocks.length) return undefined;
    r = applyWorldState(doc, { blocks: dirty.blocks }, { origin: frame.origin, volumes: frame.volumes, volatile: frame.volatile });
  } else {
    r = await syncBySections(doc, bridgeSource(link, v.dimension), frame);
  }
  return r.changed ? r : undefined;
}

/** A call as the auto-sync hook sees it (the session's `CallInfo`, structurally: `world/` doesn't import `server/`). */
export interface SyncCall {
  tool: string;
  doc: boolean;
}

/**
 * Auto-sync (13, *Automatic*, W5): before a tool call on a document, if the link reports dirty
 * volumes, sync first, so the tool sees the player's edits. Returned as a call hook for the
 * session's `callHooks` (`server/index.ts` installs it with `link.setSync(syncLink)`), never in a
 * tool module. Concurrent calls share one sync in flight; calls that take no document, the
 * `world_sync` tool (which runs its own full sync), and calls while the bridge is down (a reconnect
 * syncs) don't sync.
 */
export function autoSyncHook(link: () => WorldLink | undefined): { before(call: SyncCall): Promise<void> } {
  let inflight: Promise<unknown> | undefined;
  return {
    async before(call) {
      const l = link();
      if (!call.doc || call.tool === WORLD_SYNC || !l || l.state !== "linked") return;
      if (inflight) await inflight; // a sync already running for another call covers this one
      if (!l.isDirty() || !l.bridge.connected) return;
      const run = l.syncNow("dirty").catch((e: unknown) => {
        if ((e as BridgeError).refusal !== "world_disconnected") throw e; // the reconnect will sync
      });
      inflight = run;
      try {
        await run;
      } finally {
        if (inflight === run) inflight = undefined;
      }
    },
  };
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
