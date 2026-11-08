import type { Registry } from "../assets/registry.js";
import { Mask } from "../core/mask.js";
import { boxVolume, intersectBox, isEmptyBox, type Box, type Vec3 } from "../core/region.js";
import type { Document } from "../document/document.js";
import { ANALYZE_MAX_VOLUME, classifyState, facadeOf, type Analysis, type Facade, type Opening, type Side } from "./analyze.js";

/**
 * Geometry of the semantic selections (docs/design/05-operations.md, *Semantic*), derived from
 * structural analysis (06) and so using its vocabulary: facade, storey, roof, room, opening.
 * Read-only: every function returns a mask of document-local positions. `ops/selection.ts` turns
 * the JSON forms into calls here; nothing in this file knows about selection expressions.
 */

const SIDES: Side[] = ["north", "south", "east", "west"];
const FACADE_NAMES = ["front", "back", "left", "right"] as const;

/** The footprint side a facade name or compass side refers to, given the document's front. */
export function sideOf(name: string, front: Analysis["front"]): Side {
  if ((SIDES as string[]).includes(name)) return name as Side;
  if (!(FACADE_NAMES as readonly string[]).includes(name)) throw new Error(`face must be front, back, left, right, north, south, east or west (got "${name}")`);
  return SIDES.find((s) => facadeOf(s, front) === name)!;
}

/**
 * `face`: the wall plane of one footprint side, over the wall rows (walls.bottom..walls.top),
 * air included (so windows and doors are inside it). `depth` takes that many layers inward.
 */
export function faceMask(a: Analysis, face: string, depth = 1): { mask: Mask; note?: string } {
  const m = new Mask();
  if (!a.footprint || !a.walls) return { mask: m, note: "face: no walls were found, so there is no wall plane to select" };
  const side = sideOf(face, a.front);
  const fb = a.footprint.box;
  const box: Box = { min: [fb.min[0], a.walls.bottom, fb.min[2]], max: [fb.max[0], a.walls.top + 1, fb.max[2]] };
  const d = Math.max(1, depth);
  if (side === "north") box.max[2] = Math.min(fb.max[2], fb.min[2] + d);
  if (side === "south") box.min[2] = Math.max(fb.min[2], fb.max[2] - d);
  if (side === "west") box.max[0] = Math.min(fb.max[0], fb.min[0] + d);
  if (side === "east") box.min[0] = Math.max(fb.min[0], fb.max[0] - d);
  return { mask: Mask.fromBox(box) };
}

/** `storey`: the footprint box of storey n (1-based; negative counts from the top, -1 = top storey). */
export function storeyMask(a: Analysis, n: number): Mask {
  const k = a.storeys.length;
  if (!k) throw new Error("storey: analysis found no storeys here (it needs walls and at least one floor with 3 or more layers above it)");
  const i = n < 0 ? k + n : n - 1;
  const s = a.storeys[i];
  if (!s || n === 0) throw new Error(`storey ${n} is out of range: analysis found ${k} storey${k === 1 ? "" : "s"} (floors at y=${a.storeys.map((x) => x.floorY).join(", ")}); use 1..${k} or -1 for the top`);
  return Mask.fromBox(s.box);
}

/**
 * `roof`: the non-air blocks in the roof's box (everything above the top storey), limited to
 * `scope` when given. Gable-end walls above the eaves count as roof, as analysis sees them.
 */
export function roofMask(doc: Document, a: Analysis, scope?: Mask): { mask: Mask; note?: string } {
  const m = new Mask();
  if (!a.roof.box) return { mask: m, note: "roof: analysis found no roof (the top is open)" };
  doc.voxels.forEachInBox(doc.boxToStore(a.roof.box), (sx, sy, sz) => {
    const [x, y, z] = doc.toLocal(sx, sy, sz);
    if (!scope || scope.has(x, y, z)) m.add(x, y, z);
  });
  return { mask: m };
}

export interface OpeningFilter {
  facade?: Facade;
  side?: Side;
  kind?: Opening["kind"];
  storey?: number;
}

/** `openings`: the cells of windows, doors and wide gaps in the wall planes, optionally filtered. */
export function openingsMask(a: Analysis, f: OpeningFilter = {}): { mask: Mask; count: number } {
  const m = new Mask();
  let count = 0;
  for (const o of a.openings) {
    if (f.facade && o.facade !== f.facade) continue;
    if (f.side && o.side !== f.side) continue;
    if (f.kind && o.kind !== f.kind) continue;
    if (f.storey !== undefined && o.storey !== f.storey) continue;
    m.unionWith(Mask.fromBox(o.box));
    count++;
  }
  return { mask: m, count };
}

export interface EnclosedRoom {
  mask: Mask;
  volume: number;
  box: Box;
  floorSize: [number, number];
}

/**
 * Enclosed air: air and decor (torches, carpets…) not reachable from outside, by 6-connected
 * flood fill, as `analyze` finds rooms. Inside `scope`'s bounding box, positions outside the
 * scope count as air, so a shell selection's inside is enclosed. Rooms (≥ 8 positions) come
 * largest floor first, the order `analyze` lists them; smaller pockets go to `pockets`.
 */
export function enclosedAir(doc: Document, scope?: Mask, registry?: Registry): { rooms: EnclosedRoom[]; pockets: Mask } {
  const bounds = doc.localBounds();
  const sb = scope ? scope.bbox() : bounds;
  const area = bounds && sb ? intersectBox(bounds, sb) : undefined;
  const rooms: EnclosedRoom[] = [];
  const pockets = new Mask();
  if (!area || isEmptyBox(area)) return { rooms, pockets };
  if (boxVolume(area) > ANALYZE_MAX_VOLUME) throw new Error(`the area spans ${boxVolume(area).toLocaleString("en-US")} positions; room and interior take at most ${ANALYZE_MAX_VOLUME.toLocaleString("en-US")}. Limit it with a smaller selection.`);
  const [x0, y0, z0] = area.min;
  const W = area.max[0] - x0 + 2, H = area.max[1] - y0 + 2, D = area.max[2] - z0 + 2;
  const WD = W * D, N = W * H * D;
  // 1 = wall (a non-passable block inside the scope); everything else passable.
  const wall = new Uint8Array(N);
  const cache = new Map<number, boolean>();
  doc.voxels.forEachInBox(doc.boxToStore(area), (sx, sy, sz, id) => {
    const [x, y, z] = doc.toLocal(sx, sy, sz);
    if (scope && !scope.has(x, y, z)) return;
    let solid = cache.get(id);
    if (solid === undefined) {
      const c = classifyState(doc.states.get(id), registry);
      cache.set(id, (solid = c !== 0 && c !== 5)); // AIR = 0, DECOR = 5
    }
    if (solid) wall[(y - y0 + 1) * WD + (z - z0 + 1) * W + (x - x0 + 1)] = 1;
  });
  const nbs = (i: number, out: number[]) => {
    const x = i % W, z = Math.floor(i / W) % D, y = Math.floor(i / WD);
    out.length = 0;
    if (x > 0) out.push(i - 1);
    if (x < W - 1) out.push(i + 1);
    if (z > 0) out.push(i - W);
    if (z < D - 1) out.push(i + W);
    if (y > 0) out.push(i - WD);
    if (y < H - 1) out.push(i + WD);
    return out;
  };
  const seen = new Uint8Array(N);
  const buf: number[] = [];
  const stack = [0];
  seen[0] = 1;
  while (stack.length) for (const j of nbs(stack.pop()!, buf)) if (!seen[j] && !wall[j]) (seen[j] = 1), stack.push(j);
  const toLocal = (c: number): Vec3 => [(c % W) - 1 + x0, Math.floor(c / WD) - 1 + y0, (Math.floor(c / W) % D) - 1 + z0];
  for (let i = 0; i < N; i++) {
    if (seen[i] || wall[i]) continue;
    const comp = [i];
    seen[i] = 1;
    for (let k = 0; k < comp.length; k++) for (const j of nbs(comp[k]!, buf)) if (!seen[j] && !wall[j]) (seen[j] = 1), comp.push(j);
    const m = new Mask();
    const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const c of comp) {
      const p = toLocal(c);
      m.add(...p);
      for (let a = 0; a < 3; a++) (min[a] = Math.min(min[a]!, p[a]!)), (max[a] = Math.max(max[a]!, p[a]! + 1));
    }
    if (comp.length < 8) {
      pockets.unionWith(m);
      continue;
    }
    let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
    m.forEach((x, y, z) => {
      if (y !== min[1]) return;
      (fx0 = Math.min(fx0, x)), (fx1 = Math.max(fx1, x + 1)), (fz0 = Math.min(fz0, z)), (fz1 = Math.max(fz1, z + 1));
    });
    rooms.push({ mask: m, volume: comp.length, box: { min, max }, floorSize: [fx1 - fx0, fz1 - fz0] });
  }
  rooms.sort((a, b) => b.floorSize[0] * b.floorSize[1] - a.floorSize[0] * a.floorSize[1] || b.volume - a.volume);
  return { rooms, pockets };
}

/** `interior`: all enclosed air (rooms and small pockets) inside `scope`, or the whole build. */
export function interiorMask(doc: Document, scope?: Mask, registry?: Registry): Mask {
  const { rooms, pockets } = enclosedAir(doc, scope, registry);
  return rooms.reduce((m, r) => m.unionWith(r.mask), pockets.clone());
}

/** `room`: the room holding a seed position, or the n-th room (1-based, as `analyze` lists them). */
export function roomMask(doc: Document, which: Vec3 | number, scope?: Mask, registry?: Registry): { mask: Mask; note?: string } {
  const { rooms, pockets } = enclosedAir(doc, scope, registry);
  if (typeof which === "number") {
    const r = rooms[which - 1];
    if (!r) throw new Error(rooms.length ? `room ${which} is out of range: ${rooms.length} room${rooms.length === 1 ? "" : "s"} found (1 = the largest floor)` : "room: no enclosed rooms found");
    return { mask: r.mask.clone() };
  }
  const r = rooms.find((x) => x.mask.has(...which));
  if (r) return { mask: r.mask.clone() };
  if (pockets.has(...which)) return { mask: new Mask(), note: `room: ${fmt(which)} is in an enclosed air pocket smaller than 8 blocks, not a room` };
  const st = doc.getState(...which);
  return { mask: new Mask(), note: `room: ${fmt(which)} ${st === "minecraft:air" ? "is air connected to the outside" : `is ${st.replace(/^minecraft:/, "")}, not air`}; seed a room with an enclosed air position` };
}

/** `top`: per (x, z) column of `scope`, its highest non-air block (a heightmap surface). */
export function topMask(doc: Document, scope: Mask): Mask {
  const best = new Map<string, Vec3>();
  scope.forEach((x, y, z) => {
    if (doc.getState(x, y, z) === "minecraft:air") return;
    const k = `${x},${z}`;
    const b = best.get(k);
    if (!b || y > b[1]) best.set(k, [x, y, z]);
  });
  const m = new Mask();
  for (const p of best.values()) m.add(...p);
  return m;
}

function fmt(p: Vec3): string {
  return `(${p.join(",")})`;
}
