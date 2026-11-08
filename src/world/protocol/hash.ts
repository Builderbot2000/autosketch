import { createHash } from "node:crypto";
import type { Compound } from "prismarine-nbt";
import type { Vec3 } from "../../core/region.js";
import { ByteWriter, bytesToHex } from "./bytes.js";
import type { Hash64, SectionHash, VolatileList, WireBox } from "./messages.js";
import { encodeNbt, type Tag } from "./nbt.js";

/**
 * Hashing shared with the mod (docs/design/13-live-world.md, *Wire format*, *Hashing*; W10):
 * canonical NBT, the expected-NBT hash and the per-section hash. Hashes are the first 8 bytes of
 * SHA-256, written as 16 lowercase hex digits.
 */

/**
 * Built-in volatile keys: NBT the game changes on its own while a block ticks. Small on purpose;
 * silo R grows it from measurements on a running Craftoria base. Both the 1.21.1 key names and the
 * renamed 1.21.2+ ones are listed, since dropping an absent key is a no-op.
 */
export const DEFAULT_VOLATILE: VolatileList = {
  "minecraft:furnace": ["BurnTime", "CookTime", "CookTimeTotal", "lit_time_remaining", "lit_total_time", "cooking_time_spent", "cooking_total_time"],
  "minecraft:blast_furnace": ["BurnTime", "CookTime", "CookTimeTotal", "lit_time_remaining", "lit_total_time", "cooking_time_spent", "cooking_total_time"],
  "minecraft:smoker": ["BurnTime", "CookTime", "CookTimeTotal", "lit_time_remaining", "lit_total_time", "cooking_time_spent", "cooking_total_time"],
  "minecraft:hopper": ["TransferCooldown"],
  "minecraft:brewing_stand": ["BrewTime"],
};

/** Union of volatile lists (plugin entries on top of the default); `state_only` wins. */
export function mergeVolatile(...lists: VolatileList[]): VolatileList {
  const out: VolatileList = {};
  for (const list of lists)
    for (const [type, keys] of Object.entries(list)) {
      const have = out[type];
      if (have === "state_only" || keys === "state_only") out[type] = "state_only";
      else out[type] = [...new Set([...(have ?? []), ...keys])];
    }
  return out;
}

function typeOf(c: Compound): string | undefined {
  const id = c.value.id;
  return id?.type === "string" ? id.value : undefined;
}

/** Whether a block entity's NBT is never compared (its type, or `*`, is `state_only`). */
export function isStateOnly(c: Compound, volatile: VolatileList): boolean {
  const t = typeOf(c);
  return volatile["*"] === "state_only" || (t !== undefined && volatile[t] === "state_only");
}

/**
 * Canonical bytes of a block entity's NBT: top-level `x`, `y`, `z` removed, the volatile key paths
 * for its type and for `*` removed, keys sorted recursively, binary NBT. Undefined when the type is
 * state only.
 */
export function canonicalNbt(c: Compound, volatile: VolatileList): Uint8Array | undefined {
  if (isStateOnly(c, volatile)) return undefined;
  const t = typeOf(c);
  const paths = [...((volatile["*"] as string[] | undefined) ?? []), ...((t !== undefined ? (volatile[t] as string[] | undefined) : undefined) ?? [])];
  const value = { ...c.value };
  delete value.x;
  delete value.y;
  delete value.z;
  const root: Compound = { type: "compound", value };
  for (const p of paths) drop(root, p.split("/"));
  return encodeNbt(root);
}

/** Removes one key path, copying the compounds along it so the input is never mutated. */
function drop(c: Compound, path: string[]): void {
  const [head, ...rest] = path;
  if (head === undefined || !(head in c.value)) return;
  if (rest.length === 0) {
    delete c.value[head];
    return;
  }
  const child = c.value[head] as Tag | undefined;
  if (child?.type !== "compound") return;
  const copy: Compound = { type: "compound", value: { ...child.value } };
  c.value[head] = copy;
  drop(copy, rest);
}

export function hash64(bytes: Uint8Array): Hash64 {
  return bytesToHex(createHash("sha256").update(bytes).digest().subarray(0, 8));
}

/** The expected-NBT hash of a block entity; undefined when its type is state only. */
export function nbtHash(c: Compound, volatile: VolatileList): Hash64 | undefined {
  const b = canonicalNbt(c, volatile);
  return b && hash64(b);
}

/** What a section hash reads at one world position. */
export type BlockReader = (x: number, y: number, z: number) => { state: string; nbt?: Compound | undefined };

function inAny(boxes: readonly WireBox[], x: number, y: number, z: number): boolean {
  for (const b of boxes) if (x >= b.min[0] && x <= b.max[0] && y >= b.min[1] && y <= b.max[1] && z >= b.min[2] && z <= b.max[2]) return true;
  return false;
}

/**
 * Hash of one 16³ section over the positions inside at least one of `boxes`, in order y, then z,
 * then x. Per position: the canonical state (varint length, UTF-8), then 0x00, or 0x01 and the
 * 8-byte NBT hash when the block has a block entity that isn't state only. Undefined when no
 * position of the section lies in the boxes.
 */
export function sectionHash(section: Vec3, boxes: readonly WireBox[], read: BlockReader, volatile: VolatileList): Hash64 | undefined {
  const [sx, sy, sz] = section;
  const w = new ByteWriter(64 * 1024);
  const stateBytes = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  let any = false;
  for (let y = sy * 16; y < sy * 16 + 16; y++)
    for (let z = sz * 16; z < sz * 16 + 16; z++)
      for (let x = sx * 16; x < sx * 16 + 16; x++) {
        if (!inAny(boxes, x, y, z)) continue;
        any = true;
        const b = read(x, y, z);
        let sb = stateBytes.get(b.state);
        if (!sb) stateBytes.set(b.state, (sb = enc.encode(b.state)));
        w.varint(sb.length);
        w.bytes(sb);
        const h = b.nbt && nbtHash(b.nbt, volatile);
        if (h === undefined) w.u8(0);
        else {
          w.u8(1);
          for (let i = 0; i < 16; i += 2) w.u8(parseInt(h.slice(i, i + 2), 16));
        }
      }
  return any ? hash64(w.finish()) : undefined;
}

/** Every section a box touches, ascending by y, then z, then x. */
export function sectionsOf(boxes: readonly WireBox[]): Vec3[] {
  const seen = new Map<string, Vec3>();
  for (const b of boxes)
    for (let sy = b.min[1] >> 4; sy <= b.max[1] >> 4; sy++)
      for (let sz = b.min[2] >> 4; sz <= b.max[2] >> 4; sz++)
        for (let sx = b.min[0] >> 4; sx <= b.max[0] >> 4; sx++) seen.set(`${sx},${sy},${sz}`, [sx, sy, sz]);
  return [...seen.values()].sort((a, b) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0]);
}

/** The `hashes.result` list for `boxes`: one entry per touched section, in `sectionsOf` order. */
export function sectionHashes(boxes: readonly WireBox[], read: BlockReader, volatile: VolatileList): SectionHash[] {
  const out: SectionHash[] = [];
  for (const s of sectionsOf(boxes)) {
    const hash = sectionHash(s, boxes, read, volatile);
    if (hash !== undefined) out.push({ section: s, hash });
  }
  return out;
}
