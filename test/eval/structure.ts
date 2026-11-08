/**
 * Architectural structure detection for eval scoring only (docs/design/10, tier 3 Scoring).
 *
 * This is the labelling analyzer the server used before 06 switched to "measure, don't interpret".
 * Agents never see it: the server's analyze tool reports measurements only. The eval harness
 * keeps it to check storeys, door facades, roofs and floating blocks against the prompt.
 */
import type { Registry } from "../../src/assets/registry.js";
import { parseState, shortState, stateId } from "../../src/core/blockstate.js";
import { Mask } from "../../src/core/mask.js";
import { boxSize, boxVolume, formatBox, formatVec, intersectBox, isEmptyBox, type Box, type Vec3 } from "../../src/core/region.js";
import type { Document, Facing } from "../../src/document/document.js";
import type { PaletteIndex } from "../../src/palette/index.js";

/**
 * Structural analysis (docs/design/06-perception.md, "Structural analysis"): a compact
 * architectural description of a build, computed from the voxels alone.
 *
 *   footprint  the commonest per-layer bounding box of wall-like blocks (stairs, slabs and decor
 *              excluded, so roof overhangs don't count)
 *   walls      layers where at least 3 of the 4 footprint sides are ≥ 50% covered
 *   storeys    floors are layers whose footprint interior is ≥ 60% covered; a floor with < 3
 *              layers above it before the next floor or the top of the walls is a roof deck
 *   openings   4-connected gaps, glass, panes, bars and doors in each footprint side's plane
 *   roof       the heightmap above the top storey: flat (with parapet/battlements), gable, shed,
 *              hip or pyramid; pitch from the slope profile, overhang beyond the footprint
 *   rooms      6-connected air (and decor) not reachable from outside the build
 *   issues     floating groups (not connected to the bottom layer, even diagonally), roof gaps
 *              (heightmap pits)
 *
 * The vocabulary (storey, facade, opening, pitch, overhang) is shared with knowledge packs (07).
 */

export const ANALYZE_MAX_VOLUME = 4_000_000;

const AIR = 0, SOLID = 1, ROOF = 2, WINDOW = 3, DOOR = 4, DECOR = 5, PARTIAL = 6;
type Cls = typeof AIR | typeof SOLID | typeof ROOF | typeof WINDOW | typeof DOOR | typeof DECOR | typeof PARTIAL;

const DECOR_RE =
  /(torch|lantern|flower|sapling|carpet|_sign$|banner|button|pressure_plate|rail$|ladder|vine|candle|redstone_wire|lever|tripwire|_head$|skull|flower_pot|potted_|cobweb|short_grass|tall_grass|^fern$|large_fern|mushroom$|^snow$|trapdoor|chain$|end_rod|lily_pad|dead_bush|seagrass|kelp|bell$|campfire|item_frame|painting|scaffolding)/;

/** Coarse structural class of a block state, from its id (and the registry's shape when known). */
export function classifyState(state: string, registry?: Registry): Cls {
  const id = stateId(state);
  const name = id.slice(id.indexOf(":") + 1);
  if (name === "air" || name === "cave_air" || name === "void_air") return AIR;
  if (/_door$|fence_gate$/.test(name)) return DOOR;
  if (/glass|_bars$/.test(name)) return WINDOW;
  if (/_stairs$|_slab$/.test(name)) return ROOF;
  if (DECOR_RE.test(name)) return DECOR;
  if (/_wall$|_fence$/.test(name)) return PARTIAL;
  const b = registry?.get(id);
  if (b?.shape === "none") return DECOR;
  if (b?.shape === "partial") return PARTIAL;
  return SOLID;
}

const wallLike = (c: number) => c === SOLID || c === PARTIAL || c === WINDOW || c === DOOR;
const floorLike = (c: number) => c === SOLID || c === PARTIAL || c === ROOF;
const passable = (c: number) => c === AIR || c === DECOR;

export type Side = "north" | "south" | "east" | "west";
export type Facade = "front" | "back" | "left" | "right";
const SIDE_VEC: Record<Side, [number, number]> = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const FACADES: Facade[] = ["front", "back", "left", "right"];

/** Facade name of the side facing `side`, given the document's front (01): right = the viewer's right when facing the front. */
export function facadeOf(side: Side, front: Facing): Facade {
  const F = SIDE_VEC[front], S = SIDE_VEC[side];
  if (S[0] === F[0] && S[1] === F[1]) return "front";
  if (S[0] === -F[0] && S[1] === -F[1]) return "back";
  // Right side vector (Fz, -Fx) in (x, z): front = south → east.
  return S[0] === F[1] && S[1] === -F[0] ? "right" : "left";
}

export interface Opening {
  kind: "window" | "door" | "gap";
  facade: Facade;
  side: Side;
  /** Local half-open box of the opening's cells. */
  box: Box;
  /** 1-based storey index (0 = below the first storey or none detected). */
  storey: number;
  glazed: boolean;
}

export interface Storey {
  floorY: number;
  height: number;
  box: Box;
}

export interface Room {
  volume: number;
  box: Box;
  /** Footprint (x × z) of the room's lowest layer. */
  floorSize: [number, number];
  storey: number;
}

export type RoofType = "none" | "flat" | "gable" | "shed" | "hip" | "pyramid" | "other";

export interface RoofInfo {
  type: RoofType;
  /** Axis the ridge runs along (gable, hip, shed: the axis the slope does not climb). */
  ridgeAxis?: "x" | "z";
  /** y of the highest roof block. */
  ridgeY?: number;
  /** rise / run. */
  pitch?: number;
  /** Blocks the roof extends beyond the footprint: along the slope (eaves) and along the ridge (gables). */
  overhang?: { eaves: number; gables: number };
  /** Flat roofs: y of the deck (the level interior). */
  deckY?: number;
  /** Flat roofs: a raised rim around the edge. */
  rim?: "parapet" | "battlements";
  box?: Box;
}

export interface Issue {
  kind: "floating" | "roof_gap";
  positions: Vec3[];
  /** Block count of a floating group. */
  count?: number;
  box?: Box;
}

export interface ProposedComponent {
  id: string;
  kind: string;
  box: Box;
}

export interface Analysis {
  /** Local box analysed (tight around the content). */
  box: Box;
  front: Facing;
  footprint?: { box: Box; shape: "rectangular" | "round" | "irregular" };
  walls?: { bottom: number; top: number; thickness: number; material: [string, number][] };
  storeys: Storey[];
  openings: Opening[];
  roof: RoofInfo;
  rooms: Room[];
  /** Enclosed air pockets too small to be rooms (< 8 blocks). */
  pockets: number;
  /** The footprint interior is connected to the outside air. */
  interiorOpen: boolean;
  issues: Issue[];
  proposed: ProposedComponent[];
}

export interface AnalyzeOptions {
  /** Restrict to this local half-open box or mask (default: the whole document). */
  region?: Box | Mask;
  registry?: Registry;
  index?: PaletteIndex;
}

/** Dense class grid over a box, with one layer of air padding on every side. */
class Grid {
  readonly W: number;
  readonly H: number;
  readonly D: number;
  readonly cls: Uint8Array;
  readonly ids: Uint16Array;
  constructor(readonly box: Box) {
    const s = boxSize(box);
    this.W = s[0] + 2;
    this.H = s[1] + 2;
    this.D = s[2] + 2;
    this.cls = new Uint8Array(this.W * this.H * this.D);
    this.ids = new Uint16Array(this.W * this.H * this.D);
  }
  /** Index of a local position (may be in the padding). */
  idx(x: number, y: number, z: number): number {
    return ((y - this.box.min[1] + 1) * this.D + (z - this.box.min[2] + 1)) * this.W + (x - this.box.min[0] + 1);
  }
  inPad(x: number, y: number, z: number): boolean {
    const b = this.box;
    return x >= b.min[0] - 1 && x <= b.max[0] && y >= b.min[1] - 1 && y <= b.max[1] && z >= b.min[2] - 1 && z <= b.max[2];
  }
  at(x: number, y: number, z: number): number {
    return this.inPad(x, y, z) ? this.cls[this.idx(x, y, z)]! : AIR;
  }
}

export function analyzeStructure(doc: Document, opts: AnalyzeOptions = {}): Analysis {
  const bounds = doc.localBounds();
  const mask = opts.region instanceof Mask ? opts.region : undefined;
  let area = bounds;
  if (area && opts.region) area = intersectBox(area, mask ? (mask.bbox() ?? { min: [0, 0, 0], max: [0, 0, 0] }) : (opts.region as Box));
  if (!area || isEmptyBox(area)) throw new Error("Nothing to analyze: the document (or the region) is empty.");

  // Tight box around the content inside the area.
  let lo: Vec3 | undefined, hi: Vec3 | undefined;
  const cells: [number, number, number, number][] = [];
  doc.voxels.forEachInBox(doc.boxToStore(area), (sx, sy, sz, id) => {
    const [x, y, z] = doc.toLocal(sx, sy, sz);
    if (mask && !mask.has(x, y, z)) return;
    cells.push([x, y, z, id]);
    if (!lo || !hi) {
      lo = [x, y, z];
      hi = [x + 1, y + 1, z + 1];
    } else {
      lo = [Math.min(lo[0], x), Math.min(lo[1], y), Math.min(lo[2], z)];
      hi = [Math.max(hi[0], x + 1), Math.max(hi[1], y + 1), Math.max(hi[2], z + 1)];
    }
  });
  if (!lo || !hi) throw new Error("Nothing to analyze: the region holds only air.");
  const box: Box = { min: lo, max: hi };
  if (boxVolume(box) > ANALYZE_MAX_VOLUME) throw new Error(`the build spans ${boxVolume(box).toLocaleString("en-US")} positions; analyze takes at most ${ANALYZE_MAX_VOLUME.toLocaleString("en-US")}. Pass region or component to analyse one part.`);

  const g = new Grid(box);
  const clsCache = new Map<number, Cls>();
  for (const [x, y, z, id] of cells) {
    let c = clsCache.get(id);
    if (c === undefined) clsCache.set(id, (c = classifyState(doc.states.get(id), opts.registry)));
    const i = g.idx(x, y, z);
    g.cls[i] = c;
    g.ids[i] = id;
  }

  const front = doc.meta.front;
  const out: Analysis = { box, front, storeys: [], openings: [], roof: { type: "none" }, rooms: [], pockets: 0, interiorOpen: false, issues: [], proposed: [] };
  const [x0, y0, z0] = box.min, [x1, y1, z1] = box.max;

  // ---- footprint: the commonest per-layer bbox of wall-like blocks ----------------------------
  const layerBox = new Map<string, { b: Box; n: number; first: number }>();
  for (let y = y0; y < y1; y++) {
    let ax = Infinity, az = Infinity, bx = -Infinity, bz = -Infinity;
    for (let z = z0; z < z1; z++)
      for (let x = x0; x < x1; x++)
        if (wallLike(g.at(x, y, z))) {
          ax = Math.min(ax, x);
          bx = Math.max(bx, x + 1);
          az = Math.min(az, z);
          bz = Math.max(bz, z + 1);
        }
    if (ax === Infinity) continue;
    const k = `${ax},${az},${bx},${bz}`;
    const e = layerBox.get(k);
    if (e) e.n++;
    else layerBox.set(k, { b: { min: [ax, y, az], max: [bx, y + 1, bz] }, n: 1, first: y });
  }
  const best = [...layerBox.values()].sort((a, b) => b.n - a.n || a.first - b.first)[0];
  if (!best) {
    finishIssues(g, out);
    return out;
  }
  const fx0 = best.b.min[0], fx1 = best.b.max[0], fz0 = best.b.min[2], fz1 = best.b.max[2];
  const sideCells = (s: Side): [number, number][] => {
    const r: [number, number][] = [];
    if (s === "north" || s === "south") for (let x = fx0; x < fx1; x++) r.push([x, s === "north" ? fz0 : fz1 - 1]);
    else for (let z = fz0; z < fz1; z++) r.push([s === "west" ? fx0 : fx1 - 1, z]);
    return r;
  };
  const SIDES: Side[] = ["south", "north", "west", "east"];
  const coverage = (y: number, s: Side) => {
    const cs = sideCells(s);
    return cs.filter(([x, z]) => wallLike(g.at(x, y, z))).length / cs.length;
  };
  const isWallLayer = (y: number) => SIDES.filter((s) => coverage(y, s) >= 0.5).length >= 3;

  // ---- walls -----------------------------------------------------------------------------------
  let wallBottom: number | undefined, wallTop: number | undefined;
  for (let y = y0; y < y1; y++) {
    if (isWallLayer(y)) {
      if (wallBottom === undefined) wallBottom = y;
      wallTop = y;
    } else if (wallBottom !== undefined) break;
  }

  // Footprint shape, from the union of wall layers' occupied cells.
  {
    const fw = fx1 - fx0, fd = fz1 - fz0;
    const occ = new Uint8Array(fw * fd);
    const ya = wallBottom ?? best.first, yb = wallTop ?? best.first;
    for (let y = ya; y <= yb; y++) for (let z = fz0; z < fz1; z++) for (let x = fx0; x < fx1; x++) if (wallLike(g.at(x, y, z))) occ[(z - fz0) * fw + (x - fx0)] = 1;
    const perim: [number, number][] = [];
    for (const s of SIDES) perim.push(...sideCells(s));
    const edgeCover = perim.filter(([x, z]) => occ[(z - fz0) * fw + (x - fx0)]).length / perim.length;
    const corners = [[fx0, fz0], [fx1 - 1, fz0], [fx0, fz1 - 1], [fx1 - 1, fz1 - 1]].filter(([x, z]) => occ[(z! - fz0) * fw + (x! - fx0)]).length;
    const shape = edgeCover >= 0.85 ? "rectangular" : corners === 0 && fw >= 5 && fd >= 5 ? "round" : "irregular";
    out.footprint = { box: { min: [fx0, wallBottom ?? best.first, fz0], max: [fx1, (wallTop ?? best.first) + 1, fz1] }, shape };
  }
  if (wallBottom === undefined || wallTop === undefined) {
    analyzeRoof(g, out, fx0, fx1, fz0, fz1, y0, doc, opts.registry);
    finishIssues(g, out);
    return out;
  }

  // ---- floors and storeys ----------------------------------------------------------------------
  const ix0 = fx1 - fx0 > 2 ? fx0 + 1 : fx0, ix1 = fx1 - fx0 > 2 ? fx1 - 1 : fx1;
  const iz0 = fz1 - fz0 > 2 ? fz0 + 1 : fz0, iz1 = fz1 - fz0 > 2 ? fz1 - 1 : fz1;
  const interiorCover = (y: number) => {
    let c = 0;
    for (let z = iz0; z < iz1; z++) for (let x = ix0; x < ix1; x++) if (floorLike(g.at(x, y, z))) c++;
    return c / ((ix1 - ix0) * (iz1 - iz0));
  };
  const floorRuns: number[] = [];
  for (let y = y0; y <= Math.min(y1 - 1, wallTop + 1); y++) {
    if (interiorCover(y) < 0.6) continue;
    // A thick floor counts once, at its top layer.
    if (floorRuns.length && floorRuns[floorRuns.length - 1] === y - 1) floorRuns[floorRuns.length - 1] = y;
    else floorRuns.push(y);
  }
  if (!floorRuns.length || floorRuns[0]! > wallBottom + 2) floorRuns.unshift(wallBottom);
  let roofBase = wallTop + 1;
  const floorSet = new Set<number>();
  for (let i = 0; i < floorRuns.length; i++) {
    const f = floorRuns[i]!;
    const next = Math.min(floorRuns[i + 1] ?? wallTop + 1, wallTop + 1);
    if (next - f < 3) {
      roofBase = f;
      break;
    }
    floorSet.add(f);
    out.storeys.push({ floorY: f, height: next - f, box: { min: [fx0, f, fz0], max: [fx1, next, fz1] } });
  }
  const storeyOf = (y: number) => {
    let s = 0;
    out.storeys.forEach((st, i) => {
      if (y >= st.floorY) s = i + 1;
    });
    return y >= roofBase ? 0 : s;
  };

  // Wall thickness (median inward run at the first storey's mid-height) and material.
  {
    const ys = out.storeys.length ? Math.min(wallTop, out.storeys[0]!.floorY + 2) : wallBottom;
    const runs: number[] = [];
    for (const s of SIDES) {
      const [dx, dz] = SIDE_VEC[s];
      const cs = sideCells(s).slice(1, -1);
      for (const [x, z] of cs) {
        let k = 0;
        while (k < 8 && (g.at(x - dx * k, ys, z - dz * k) === SOLID || g.at(x - dx * k, ys, z - dz * k) === PARTIAL)) k++;
        if (k) runs.push(k);
      }
    }
    runs.sort((a, b) => a - b);
    const counts = new Map<string, number>();
    for (let y = wallBottom; y < roofBase; y++) {
      if (floorSet.has(y)) continue;
      for (const s of SIDES)
        for (const [x, z] of sideCells(s)) {
          const c = g.at(x, y, z);
          if (c !== SOLID && c !== PARTIAL) continue;
          const id = stateId(doc.states.get(g.ids[g.idx(x, y, z)]!));
          const f = opts.index?.familyOfBlock(id)?.id ?? id;
          counts.set(f, (counts.get(f) ?? 0) + 1);
        }
    }
    out.walls = { bottom: wallBottom, top: Math.min(wallTop, roofBase - 1), thickness: runs.length ? runs[Math.floor(runs.length / 2)]! : 0, material: [...counts].sort((a, b) => b[1] - a[1]) };
  }

  // ---- openings --------------------------------------------------------------------------------
  const openLo = (out.storeys[0]?.floorY ?? wallBottom) + 1, openHi = roofBase - 1;
  for (const s of SIDES) {
    const cs = sideCells(s);
    const w = cs.length, h = openHi - openLo + 1;
    if (h <= 0) continue;
    const isOpen = (u: number, v: number) => {
      const [x, z] = cs[u]!;
      const y = openLo + v;
      if (floorSet.has(y)) return false;
      const c = g.at(x, y, z);
      return c === AIR || c === WINDOW || c === DOOR || c === DECOR;
    };
    const seen = new Uint8Array(w * h);
    for (let v = 0; v < h; v++)
      for (let u = 0; u < w; u++) {
        if (seen[v * w + u] || !isOpen(u, v)) continue;
        const stack: [number, number][] = [[u, v]];
        seen[v * w + u] = 1;
        let ua = u, ub = u, va = v, vb = v, door = false, glazed = false, solidAir = true;
        while (stack.length) {
          const [cu, cv] = stack.pop()!;
          ua = Math.min(ua, cu);
          ub = Math.max(ub, cu);
          va = Math.min(va, cv);
          vb = Math.max(vb, cv);
          const [x, z] = cs[cu]!;
          const c = g.at(x, openLo + cv, z);
          if (c === DOOR) door = true;
          if (c === WINDOW) glazed = true;
          if (c !== AIR) solidAir = false;
          for (const [du, dv] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nu = cu + du, nv = cv + dv;
            if (nu < 0 || nv < 0 || nu >= w || nv >= h || seen[nv * w + nu] || !isOpen(nu, nv)) continue;
            seen[nv * w + nu] = 1;
            stack.push([nu, nv]);
          }
        }
        const yA = openLo + va, yB = openLo + vb;
        const st = storeyOf(yA);
        const onFloor = out.storeys.some((x) => x.floorY + 1 === yA);
        const kind: Opening["kind"] = ub - ua + 1 > 5 || (vb - va + 1) * (ub - ua + 1) > 15 ? "gap" : door || (solidAir && onFloor && vb - va >= 1) ? "door" : "window";
        const [xa, za] = cs[ua]!, [xb, zb] = cs[ub]!;
        out.openings.push({
          kind,
          facade: facadeOf(s, front),
          side: s,
          box: { min: [Math.min(xa, xb), yA, Math.min(za, zb)], max: [Math.max(xa, xb) + 1, yB + 1, Math.max(za, zb) + 1] },
          storey: st,
          glazed,
        });
      }
  }

  analyzeRoof(g, out, fx0, fx1, fz0, fz1, roofBase, doc, opts.registry);

  // ---- rooms -----------------------------------------------------------------------------------
  {
    const N = g.cls.length;
    const outside = new Uint8Array(N);
    const stack: number[] = [0];
    outside[0] = 1;
    const W = g.W, WD = g.W * g.D;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % W, z = Math.floor(i / W) % g.D, y = Math.floor(i / WD);
      const nbs = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, z > 0 ? i - W : -1, z < g.D - 1 ? i + W : -1, y > 0 ? i - WD : -1, y < g.H - 1 ? i + WD : -1];
      for (const j of nbs) if (j >= 0 && !outside[j] && passable(g.cls[j]!)) (outside[j] = 1), stack.push(j);
    }
    const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (outside[i] || seen[i] || !passable(g.cls[i]!)) continue;
      const comp: number[] = [i];
      seen[i] = 1;
      for (let k = 0; k < comp.length; k++) {
        const c = comp[k]!;
        const x = c % W, z = Math.floor(c / W) % g.D, y = Math.floor(c / WD);
        const nbs = [x > 0 ? c - 1 : -1, x < W - 1 ? c + 1 : -1, z > 0 ? c - W : -1, z < g.D - 1 ? c + W : -1, y > 0 ? c - WD : -1, y < g.H - 1 ? c + WD : -1];
        for (const j of nbs) if (j >= 0 && !seen[j] && !outside[j] && passable(g.cls[j]!)) (seen[j] = 1), comp.push(j);
      }
      if (comp.length < 8) {
        out.pockets++;
        continue;
      }
      const toLocal = (c: number): Vec3 => [(c % W) - 1 + x0, Math.floor(c / WD) - 1 + y0, (Math.floor(c / W) % g.D) - 1 + z0];
      const pts = comp.map(toLocal);
      const minY = Math.min(...pts.map((p) => p[1]));
      const bottom = pts.filter((p) => p[1] === minY);
      const rb = boundsOf(pts);
      const fb = boundsOf(bottom);
      out.rooms.push({ volume: comp.length, box: rb, floorSize: [fb.max[0] - fb.min[0], fb.max[2] - fb.min[2]], storey: storeyOf(minY) });
    }
    out.rooms.sort((a, b) => b.floorSize[0] * b.floorSize[1] - a.floorSize[0] * a.floorSize[1] || b.volume - a.volume);
    // Is the middle of the ground storey outside air?
    const cy = (out.storeys[0]?.floorY ?? wallBottom) + 1;
    const cx = Math.floor((fx0 + fx1) / 2), cz = Math.floor((fz0 + fz1) / 2);
    if (g.inPad(cx, cy, cz) && outside[g.idx(cx, cy, cz)]) out.interiorOpen = true;
  }

  finishIssues(g, out);

  // ---- proposed components ---------------------------------------------------------------------
  out.storeys.forEach((s, i) => out.proposed.push({ id: `storey_${i + 1}`, kind: "storey", box: s.box }));
  if (out.roof.box) out.proposed.push({ id: "roof", kind: "roof", box: out.roof.box });
  const doors = out.openings.filter((o) => o.kind === "door");
  const main = doors.find((o) => o.facade === "front" && o.storey === 1) ?? doors.find((o) => o.facade === "front") ?? doors[0];
  if (main) out.proposed.push({ id: "door_main", kind: "door", box: main.box });
  return out;
}

function boundsOf(pts: Vec3[]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts)
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a]!, p[a]!);
      max[a] = Math.max(max[a]!, p[a]! + 1);
    }
  return { min, max };
}

/** Top surface height of a block, in blocks above its y (bottom slabs are half height). */
function topOf(state: string): number {
  const { id, props } = parseState(state);
  if (id.endsWith("_slab") && props.type === "bottom") return 0.5;
  return 1;
}

function analyzeRoof(g: Grid, out: Analysis, fx0: number, fx1: number, fz0: number, fz1: number, roofBase: number, doc: Document, _registry?: Registry): void {
  const [x0, , z0] = g.box.min, [x1, y1, z1] = g.box.max;
  // Column heights of roof material (anything but decor) at or above roofBase.
  const W = x1 - x0, D = z1 - z0;
  const h = new Float64Array(W * D).fill(NaN);
  let rx0 = Infinity, rx1 = -Infinity, rz0 = Infinity, rz1 = -Infinity, ry0 = Infinity, ry1 = -Infinity;
  for (let z = z0; z < z1; z++)
    for (let x = x0; x < x1; x++)
      for (let y = y1 - 1; y >= roofBase; y--) {
        const c = g.at(x, y, z);
        if (c === AIR || c === DECOR) continue;
        if (Number.isNaN(h[(z - z0) * W + (x - x0)]!)) h[(z - z0) * W + (x - x0)] = y + topOf(doc.states.get(g.ids[g.idx(x, y, z)]!));
        rx0 = Math.min(rx0, x);
        rx1 = Math.max(rx1, x + 1);
        rz0 = Math.min(rz0, z);
        rz1 = Math.max(rz1, z + 1);
        ry0 = Math.min(ry0, y);
        ry1 = Math.max(ry1, y + 1);
      }
  if (rx0 === Infinity) {
    out.roof = { type: "none" };
    return;
  }
  const H = (x: number, z: number) => (x < x0 || x >= x1 || z < z0 || z >= z1 ? NaN : h[(z - z0) * W + (x - x0)]!);
  const roofBox: Box = { min: [rx0, ry0, rz0], max: [rx1, ry1, rz1] };
  const overhang = { x: Math.max(0, fx0 - rx0, rx1 - fx1), z: Math.max(0, fz0 - rz0, rz1 - fz1) };
  const ridgeY = ry1 - 1;

  // Flat: the interior of the footprint is level (within one block).
  const ix0 = fx1 - fx0 > 2 ? fx0 + 1 : fx0, ix1 = fx1 - fx0 > 2 ? fx1 - 1 : fx1;
  const iz0 = fz1 - fz0 > 2 ? fz0 + 1 : fz0, iz1 = fz1 - fz0 > 2 ? fz1 - 1 : fz1;
  const inner: number[] = [];
  for (let z = iz0; z < iz1; z++) for (let x = ix0; x < ix1; x++) if (!Number.isNaN(H(x, z))) inner.push(H(x, z));
  if (inner.length) {
    const mn = Math.min(...inner), mx = Math.max(...inner);
    if (mx - mn <= 1) {
      const level = inner.sort((a, b) => a - b)[Math.floor(inner.length / 2)]!;
      const ring: number[] = [];
      for (let x = fx0; x < fx1; x++) ring.push(H(x, fz0), H(x, fz1 - 1));
      for (let z = fz0 + 1; z < fz1 - 1; z++) ring.push(H(fx0, z), H(fx1 - 1, z));
      const raised = ring.filter((v) => v > level).length / ring.length;
      out.roof = {
        type: "flat",
        ridgeY,
        deckY: Math.ceil(level) - 1,
        overhang: { eaves: Math.max(overhang.x, overhang.z), gables: Math.max(overhang.x, overhang.z) },
        box: roofBox,
        ...(raised >= 0.95 ? { rim: "parapet" as const } : raised >= 0.3 ? { rim: "battlements" as const } : {}),
      };
      return;
    }
  }

  // Slope statistics: mean height change between neighbours along each axis.
  let gx = 0, nx = 0, gz = 0, nz = 0;
  for (let z = rz0; z < rz1; z++)
    for (let x = rx0; x < rx1; x++) {
      const v = H(x, z);
      if (Number.isNaN(v)) continue;
      const ex = H(x + 1, z), ez = H(x, z + 1);
      if (!Number.isNaN(ex)) (gx += Math.abs(ex - v)), nx++;
      if (!Number.isNaN(ez)) (gz += Math.abs(ez - v)), nz++;
    }
  gx = nx ? gx / nx : 0;
  gz = nz ? gz / nz : 0;
  /** Mean profile along an axis (averaged over the other). */
  const profile = (axis: "x" | "z"): { pos: number; h: number }[] => {
    const r: { pos: number; h: number }[] = [];
    const [a0, a1, b0, b1] = axis === "x" ? [rx0, rx1, rz0, rz1] : [rz0, rz1, rx0, rx1];
    for (let a = a0; a < a1; a++) {
      let s = 0, k = 0;
      for (let b = b0; b < b1; b++) {
        const v = axis === "x" ? H(a, b) : H(b, a);
        if (!Number.isNaN(v)) (s += v), k++;
      }
      if (k) r.push({ pos: a, h: s / k });
    }
    return r;
  };
  const pitchOf = (p: { pos: number; h: number }[]) => {
    const top = p.reduce((m, e) => (e.h > m.h ? e : m), p[0]!);
    const first = p[0]!, last = p[p.length - 1]!;
    const side = Math.abs(top.pos - first.pos) >= Math.abs(last.pos - top.pos) ? first : last;
    const run = Math.abs(top.pos - side.pos);
    return run ? (top.h - side.h) / run : undefined;
  };

  let type: RoofType;
  let ridgeAxis: "x" | "z" | undefined;
  let slopeAxis: "x" | "z";
  if (gx < 0.25 * gz || gz < 0.25 * gx) {
    ridgeAxis = gx < gz ? "x" : "z";
    slopeAxis = ridgeAxis === "x" ? "z" : "x";
    const p = profile(slopeAxis);
    const peak = p.reduce((m, e, i) => (e.h > p[m]!.h ? i : m), 0);
    type = peak > 0 && peak < p.length - 1 ? "gable" : "shed";
  } else {
    // Both axes slope: a hip (ridge line) or a pyramid (point).
    const tops: Vec3[] = [];
    const hmax = Math.max(...[...h].filter((v) => !Number.isNaN(v)));
    for (let z = rz0; z < rz1; z++) for (let x = rx0; x < rx1; x++) if (H(x, z) === hmax) tops.push([x, 0, z]);
    const tb = boundsOf(tops);
    const tw = tb.max[0] - tb.min[0], td = tb.max[2] - tb.min[2];
    if (tw <= 2 && td <= 2) type = "pyramid";
    else if (tops.length >= 0.8 * Math.max(tw, td) && Math.min(tw, td) <= 2) {
      type = "hip";
      ridgeAxis = tw >= td ? "x" : "z";
    } else type = "other";
    slopeAxis = (ridgeAxis ?? (rx1 - rx0 <= rz1 - rz0 ? "z" : "x")) === "x" ? "z" : "x";
    if (!ridgeAxis && type === "pyramid") slopeAxis = rx1 - rx0 <= rz1 - rz0 ? "x" : "z";
  }
  // Pitch along the middle of the roof (an average would mix in a hip's sloped ends).
  const centre = slopeAxis === "z" ? Math.floor((rx0 + rx1 - 1) / 2) : Math.floor((rz0 + rz1 - 1) / 2);
  const line: { pos: number; h: number }[] = [];
  for (let a = slopeAxis === "z" ? rz0 : rx0; a < (slopeAxis === "z" ? rz1 : rx1); a++) {
    const v = slopeAxis === "z" ? H(centre, a) : H(a, centre);
    if (!Number.isNaN(v)) line.push({ pos: a, h: v });
  }
  const pitch = type === "other" || line.length < 2 ? undefined : pitchOf(line);
  out.roof = {
    type,
    ...(ridgeAxis ? { ridgeAxis } : {}),
    ridgeY,
    ...(pitch !== undefined ? { pitch } : {}),
    overhang: { eaves: slopeAxis === "z" ? overhang.z : overhang.x, gables: slopeAxis === "z" ? overhang.x : overhang.z },
    box: roofBox,
  };

  // Roof gaps: footprint columns under a sloped roof with no roof block, or a pit ≥ 2 below all four neighbours.
  const gaps: Vec3[] = [];
  for (let z = Math.max(fz0, rz0); z < Math.min(fz1, rz1); z++)
    for (let x = Math.max(fx0, rx0); x < Math.min(fx1, rx1); x++) {
      const v = H(x, z);
      const nb = [H(x + 1, z), H(x - 1, z), H(x, z + 1), H(x, z - 1)].filter((n) => !Number.isNaN(n));
      if (nb.length < 4) continue;
      const lowest = Math.min(...nb);
      // A missing block sits about where its neighbours' mean surface is.
      if (Number.isNaN(v)) gaps.push([x, Math.round(nb.reduce((s, n) => s + n, 0) / 4) - 1, z]);
      else if (v <= lowest - 2) gaps.push([x, Math.floor(v), z]);
    }
  if (gaps.length) out.issues.push({ kind: "roof_gap", positions: gaps, count: gaps.length });
}

/**
 * Floating groups: non-air blocks not connected to the bottom layer. Connection counts edges and
 * corners (26 neighbours), since stair roofs step diagonally and hold in the game.
 */
function finishIssues(g: Grid, out: Analysis): void {
  const [x0, y0, z0] = g.box.min;
  const N = g.cls.length, W = g.W, WD = g.W * g.D;
  const offsets: number[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) offsets.push(dy * WD + dz * W + dx);
  const seen = new Uint8Array(N);
  const solid = (i: number) => g.cls[i] !== AIR;
  const groups: { n: number; pts: Vec3[] }[] = [];
  for (let i = 0; i < N; i++) {
    if (seen[i] || !solid(i)) continue;
    const comp: number[] = [i];
    seen[i] = 1;
    let grounded = false;
    for (let k = 0; k < comp.length; k++) {
      const c = comp[k]!;
      if (Math.floor(c / WD) === 1) grounded = true;
      // Real block cells never touch the grid edge (one layer of padding), so offsets stay in range.
      for (const o of offsets) {
        const j = c + o;
        if (j >= 0 && j < N && !seen[j] && solid(j)) (seen[j] = 1), comp.push(j);
      }
    }
    if (!grounded) groups.push({ n: comp.length, pts: comp.slice(0, 64).map((c) => [(c % W) - 1 + x0, Math.floor(c / WD) - 1 + y0, (Math.floor(c / W) % g.D) - 1 + z0] as Vec3) });
  }
  for (const gr of groups.sort((a, b) => a.n - b.n)) out.issues.push({ kind: "floating", positions: gr.pts, count: gr.n, box: boundsOf(gr.pts) });
}

// ---- text ----------------------------------------------------------------------------------------

const plural = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;

function ratio(p: number): string {
  if (p <= 0) return "0";
  const r = (v: number) => String(Math.round(v * 2) / 2);
  return p >= 1 ? `${r(p)}:1` : `1:${r(1 / p)}`;
}

/** The text block from 06, kept to about 200–400 tokens. */
export function formatAnalysis(a: Analysis, registry?: Registry): string {
  const lines: string[] = [];
  if (!a.footprint) {
    lines.push(`no wall-like structure found in ${formatBox(a.box)}`);
  } else {
    const fb = a.footprint.box;
    lines.push(`footprint: ${fb.max[0] - fb.min[0]}×${fb.max[2] - fb.min[2]} at x ${fb.min[0]}..${fb.max[0] - 1}, z ${fb.min[2]}..${fb.max[2] - 1}, ${a.footprint.shape}, front=${a.front}`);
  }
  if (a.storeys.length)
    lines.push(`storeys: ${a.storeys.length} (floor y=${a.storeys.map((s) => s.floorY).join(", ")}; heights ${a.storeys.map((s) => s.height).join(",")})`);
  if (a.walls) {
    const total = a.walls.material.reduce((s, [, c]) => s + c, 0);
    const [top, topN] = a.walls.material[0] ?? ["", 0];
    const mix = total && topN / total < 0.85;
    const mat = !top
      ? "unknown"
      : mix
      ? `${shortState(top, registry)} mix (${a.walls.material.slice(0, 3).map(([m, c]) => `${shortState(m, registry)} ${Math.round((100 * c) / total)}%`).join(", ")})`
      : shortState(top, registry);
    lines.push(`walls: y ${a.walls.bottom}..${a.walls.top}, thickness ${a.walls.thickness}, material ${mat}`);
  }
  if (a.footprint && a.walls) {
    const parts = FACADES.map((f) => {
      const os = a.openings.filter((o) => o.facade === f);
      const win = os.filter((o) => o.kind === "window"), doors = os.filter((o) => o.kind === "door"), gaps = os.filter((o) => o.kind === "gap");
      const bits: string[] = [];
      if (win.length) {
        const per = a.storeys.map((_, i) => win.filter((o) => o.storey === i + 1));
        const extra: string[] = [];
        if (a.storeys.length > 1) {
          const ns = per.map((p) => p.length);
          extra.push(ns.every((v) => v === ns[0]) ? `${ns[0]} per storey` : `${ns.join("+")} by storey`);
        }
        const rh = rhythm(per.length ? per : [win]);
        if (rh) extra.push(`rhythm ${rh}`);
        const open = win.filter((o) => !o.glazed).length;
        if (open) extra.push(`${open} unglazed`);
        bits.push(`${plural(win.length, "window")}${extra.length ? ` (${extra.join(", ")})` : ""}`);
      }
      for (const d of doors) {
        const side = d.side === "north" || d.side === "south" ? 0 : 2;
        const fb = a.footprint!.box;
        const mid = (fb.min[side]! + fb.max[side]! - 1) / 2, c = (d.box.min[side]! + d.box.max[side]! - 1) / 2;
        const where = Math.abs(c - mid) <= 0.5 ? "center" : `${side === 0 ? "x" : "z"}=${d.box.min[side]}${d.box.max[side]! - d.box.min[side]! > 1 ? `..${d.box.max[side]! - 1}` : ""}`;
        bits.push(`1 door (${where}${a.storeys.length > 1 && d.storey !== 1 ? `, storey ${d.storey}` : ""})`);
      }
      if (gaps.length) bits.push(`${plural(gaps.length, "wide gap")} (${gaps.map((o) => formatBox(o.box)).join(", ")})`);
      return `${f} ${bits.length ? bits.join(", ") : "0"}`;
    });
    lines.push(`openings: ${parts.join("; ")}`);
  }
  lines.push(`roof: ${formatRoof(a.roof)}`);
  if (a.walls) {
    const r = a.rooms;
    let t = `rooms: ${r.length} enclosed`;
    if (r.length) t += ` (largest ${r[0]!.floorSize[0]}×${r[0]!.floorSize[1]} ${r[0]!.storey ? `on storey ${r[0]!.storey}` : "under the roof"})`;
    if (a.pockets) t += `, ${plural(a.pockets, "small air pocket")}`;
    if (a.interiorOpen) t += "; the interior is open to outside air (an unglazed opening, doorway or gap)";
    lines.push(t);
  }
  const issues: string[] = [];
  const floating = a.issues.filter((i) => i.kind === "floating");
  const singles = floating.filter((i) => (i.count ?? 0) <= 3);
  if (singles.length) {
    const pts = singles.flatMap((i) => i.positions);
    issues.push(`${plural(pts.length, "floating block")} at ${pts.slice(0, 4).map(formatVec).join(",")}${pts.length > 4 ? " …" : ""}`);
  }
  for (const f of floating.filter((i) => (i.count ?? 0) > 3).slice(0, 3)) issues.push(`floating group of ${f.count} blocks in ${formatBox(f.box!)}`);
  const gaps = a.issues.find((i) => i.kind === "roof_gap");
  if (gaps) issues.push(`roof ${gaps.positions.length === 1 ? "gap" : `${gaps.positions.length} gaps`} at ${gaps.positions.slice(0, 3).map(formatVec).join(",")}${gaps.positions.length > 3 ? " …" : ""}`);
  lines.push(`issues: ${issues.length ? issues.join("; ") : "none found"}`);
  if (a.proposed.length) lines.push(`proposed components: ${a.proposed.map((p) => `${p.id} ${formatBox(p.box)}`).join(", ")}`);
  return lines.join("\n");
}

function formatRoof(r: RoofInfo): string {
  if (r.type === "none") return "none (open top)";
  const bits: string[] = [r.type];
  if (r.rim) bits[0] += ` with ${r.rim}`;
  if (r.type === "flat") bits.push(`deck at y=${r.deckY}`);
  else if (r.ridgeAxis && r.type !== "shed") bits.push(`ridge along ${r.ridgeAxis} at y=${r.ridgeY}`);
  else if (r.type === "shed") bits.push(`high side at y=${r.ridgeY}, slope across ${r.ridgeAxis === "x" ? "z" : "x"}`);
  else bits.push(`top at y=${r.ridgeY}`);
  if (r.pitch !== undefined) bits.push(`pitch ${ratio(r.pitch)}`);
  if (r.overhang) {
    const { eaves, gables } = r.overhang;
    bits.push(r.type === "gable" && eaves !== gables ? `overhang ${eaves} (eaves), ${gables} (gables)` : `overhang ${Math.max(eaves, gables)}`);
  }
  return bits.join(", ");
}

/** Spacing between window centres when every storey's spacing is the same single value. */
function rhythm(groups: Opening[][]): number | undefined {
  const gaps = new Set<number>();
  for (const g of groups) {
    const axis = g[0] && (g[0].side === "north" || g[0].side === "south") ? 0 : 2;
    const cs = g.map((o) => (o.box.min[axis]! + o.box.max[axis]!) / 2).sort((a, b) => a - b);
    for (let i = 1; i < cs.length; i++) gaps.add(cs[i]! - cs[i - 1]!);
  }
  return gaps.size === 1 ? [...gaps][0] : undefined;
}
