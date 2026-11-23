import type { Vec3 } from "../../src/core/region.js";
import { alignBox } from "../../src/world/protocol/body.js";
import {
  FILL_CONNECTIVITY,
  MATCH_SOLID,
  SEARCH_GAP,
  SEARCH_STOP,
  type Cardinal,
  type CoarseRegion,
  type ExpandBy,
  type FillResult,
  type FillStop,
  type FrontierSection,
  type MaskSection,
  type SearchChunk,
  type SearchCluster,
  type SearchResult,
  type WireBox,
} from "../../src/world/protocol/messages.js";

/**
 * The mod's select reads for the fake host (docs/design/18-select.md, pieces 2–5; `13`, *Message
 * schemas*, *Select*), over an in-memory world: the material search in rings, the fill (depth-first in
 * the same neighbour order as `{connected}` in `src/ops/selection.ts`, so a fill with no area or budget
 * limit selects exactly what `{connected}` selects on the same blocks), expand, and the coarse read.
 * What it doesn't model: tick slicing, chunk loading, `maybeHas` (every non-empty section is a yes, and
 * its count is exact).
 */

const AIR = "minecraft:air";
export const BUILD_MIN_Y = -64;
export const BUILD_MAX_Y = 319;
export const MIN_SECTION = BUILD_MIN_Y >> 4;

/** Reads one block's state; positions outside the build height read as air. */
export type StateAt = (x: number, y: number, z: number) => string;

const stateId = (s: string) => {
  const i = s.indexOf("[");
  return i < 0 ? s : s.slice(0, i);
};

/** A match list's test (`18`, piece 3): ids match any state, states exactly, `#tags` through `tags`, `solid` any non-air block. */
export function materialTest(list: readonly string[], tags: Record<string, readonly string[]> = {}): (state: string) => boolean {
  const ids = new Set<string>(), states = new Set<string>();
  let solid = false;
  for (const m of list) {
    if (m === MATCH_SOLID) solid = true;
    else if (m.startsWith("#")) for (const id of tags[m.slice(1)] ?? []) ids.add(id);
    else if (m.includes("[")) states.add(m);
    else ids.add(m);
  }
  return (s) => (solid && s !== AIR) || states.has(s) || ids.has(stateId(s));
}

/** Which material of a list a state counts toward first (search counts each block once, under its first matching material). */
function materialIndex(list: readonly string[], tags: Record<string, readonly string[]>): (state: string) => number {
  const tests = list.map((m) => materialTest([m], tags));
  const memo = new Map<string, number>();
  return (s) => {
    let i = memo.get(s);
    if (i === undefined) memo.set(s, (i = tests.findIndex((t) => t(s))));
    return i;
  };
}

/** The select-mode read grant (`13`, *Read grants in select mode*): chunks within `radius` of `centre`, in one dimension. */
export interface SelectGrant {
  dimension: string;
  centre: [number, number];
  radius: number;
}

export function grantHasChunk(g: SelectGrant, cx: number, cz: number): boolean {
  return Math.max(Math.abs(cx - g.centre[0]), Math.abs(cz - g.centre[1])) <= g.radius;
}

export function grantHasBox(g: SelectGrant, b: WireBox): boolean {
  return grantHasChunk(g, b.min[0] >> 4, b.min[2] >> 4) && grantHasChunk(g, b.max[0] >> 4, b.max[2] >> 4);
}

// ── search ────────────────────────────────────────────────────────────────────────────────────

/** One search's resumable state: the rings walked so far and what they held. */
export class SearchWalk {
  reached = -1;
  private readonly chunks = new Map<string, { chunk: [number, number]; counts: number[]; sections: Set<number>; ring: number; order: number }>();
  private readonly missing: [number, number][] = [];
  private readonly parent = new Map<string, string>();
  private order = 0;

  constructor(
    readonly materials: string[],
    readonly centre: [number, number],
    readonly radius: number,
    readonly clipped: boolean,
    readonly gap: number,
    private readonly grant: SelectGrant,
  ) {}

  /**
   * Walks whole rings from where it stopped until `stop` more clusters are closed than when this call
   * started, or the radius. `world` lists the stored (non-air) blocks; `missing` the ungenerated chunks.
   */
  walk(world: Iterable<[Vec3, string]>, missingChunks: ReadonlySet<string>, stop: number, tags: Record<string, readonly string[]>): void {
    const which = materialIndex(this.materials, tags);
    // Per chunk: per section y, per material, the matching blocks (every non-empty section is a maybeHas yes).
    const index = new Map<string, Map<number, number[]>>();
    for (const [p, s] of world) {
      const m = which(s);
      if (m < 0 || p[1] < BUILD_MIN_Y || p[1] > BUILD_MAX_Y) continue;
      const k = `${p[0] >> 4},${p[2] >> 4}`;
      let secs = index.get(k);
      if (!secs) index.set(k, (secs = new Map()));
      let c = secs.get(p[1] >> 4);
      if (!c) secs.set(p[1] >> 4, (c = this.materials.map(() => 0)));
      c[m]!++;
    }
    const startClosed = this.closedCount();
    while (this.reached < this.radius) {
      const r = this.reached + 1;
      for (let dz = -r; dz <= r; dz++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const cx = this.centre[0] + dx, cz = this.centre[1] + dz;
          if (!grantHasChunk(this.grant, cx, cz)) continue;
          const k = `${cx},${cz}`;
          if (missingChunks.has(k)) {
            this.missing.push([cx, cz]);
            continue;
          }
          const secs = index.get(k);
          if (!secs) continue;
          const counts = this.materials.map(() => 0);
          for (const c of secs.values()) c.forEach((n, i) => (counts[i]! += n));
          this.chunks.set(k, { chunk: [cx, cz], counts, sections: new Set(secs.keys()), ring: r, order: this.order++ });
          this.parent.set(k, k);
          for (let ez = -1; ez <= 1; ez++) for (let ex = -1; ex <= 1; ex++) if ((ex || ez) && this.chunks.has(`${cx + ex},${cz + ez}`)) this.union(k, `${cx + ex},${cz + ez}`);
        }
      this.reached = r;
      if (this.closedCount() - startClosed >= stop) break;
    }
  }

  private find(k: string): string {
    let r = k;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    this.parent.set(k, r);
    return r;
  }

  private union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra === rb) return;
    // The root is the cluster's first chunk in walk order.
    if (this.chunks.get(ra)!.order < this.chunks.get(rb)!.order) this.parent.set(rb, ra);
    else this.parent.set(ra, rb);
  }

  private groups(): Map<string, string[]> {
    const g = new Map<string, string[]>();
    for (const k of this.chunks.keys()) {
      const r = this.find(k);
      let l = g.get(r);
      if (!l) g.set(r, (l = []));
      l.push(k);
    }
    return g;
  }

  private closedCount(): number {
    let n = 0;
    for (const ks of this.groups().values()) if (this.reached >= Math.max(...ks.map((k) => this.chunks.get(k)!.ring)) + this.gap) n++;
    return n;
  }

  result(id: number, dimension: string): SearchResult {
    const roots = [...this.groups().entries()].sort((a, b) => this.chunks.get(a[0])!.order - this.chunks.get(b[0])!.order);
    const clusterOf = new Map<string, number>();
    const clusters: SearchCluster[] = roots.map(([, ks], i) => {
      const cs = ks.map((k) => this.chunks.get(k)!);
      for (const k of ks) clusterOf.set(k, i);
      return {
        min: [Math.min(...cs.map((c) => c.chunk[0])), Math.min(...cs.map((c) => c.chunk[1]))],
        max: [Math.max(...cs.map((c) => c.chunk[0])), Math.max(...cs.map((c) => c.chunk[1]))],
        chunks: cs.length,
        blocks: cs.reduce((n, c) => n + c.counts.reduce((a, b) => a + b, 0), 0),
        closed: this.reached >= Math.max(...cs.map((c) => c.ring)) + this.gap,
      };
    });
    const byZX = (a: [number, number], b: [number, number]) => a[1] - b[1] || a[0] - b[0];
    const chunks: SearchChunk[] = [...this.chunks.entries()]
      .map(([k, c]) => ({ chunk: c.chunk, counts: c.counts, cluster: clusterOf.get(k)!, sections: [...c.sections].sort((a, b) => a - b) }))
      .sort((a, b) => byZX(a.chunk, b.chunk));
    return {
      type: "search.result",
      id,
      dimension,
      materials: this.materials,
      centre: this.centre,
      radius: this.radius,
      ...(this.clipped ? { clipped: true as const } : {}),
      reached: this.reached,
      minSection: MIN_SECTION,
      clusters,
      chunks,
      missing: [...this.missing].sort(byZX),
    };
  }
}

export function newSearch(m: { materials: string[]; radius?: number; around?: Vec3; gap?: number }, grant: SelectGrant, selectChunks: number): SearchWalk {
  const asked = m.radius ?? selectChunks;
  const centre: [number, number] = m.around ? [m.around[0] >> 4, m.around[2] >> 4] : grant.centre;
  return new SearchWalk(m.materials, centre, Math.min(asked, selectChunks), asked > selectChunks, m.gap ?? SEARCH_GAP, grant);
}

export { SEARCH_STOP };

// ── fill and expand ───────────────────────────────────────────────────────────────────────────

/** `{connected}`'s neighbour offsets, in its order (`src/ops/selection.ts`). */
export function neighbours(connectivity: number): Vec3[] {
  const out: Vec3[] = [];
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++) {
        const n = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (n === 0 || (connectivity === 6 && n > 1) || (connectivity === 18 && n > 2)) continue;
        out.push([dx, dy, dz]);
      }
  return out;
}

/** The face-mask bits (down 1, up 2, north 4, south 8, west 16, east 32) an offset lies toward. */
function faceBits(d: Vec3): number {
  return (d[1] < 0 ? 1 : 0) | (d[1] > 0 ? 2 : 0) | (d[2] < 0 ? 4 : 0) | (d[2] > 0 ? 8 : 0) | (d[0] < 0 ? 16 : 0) | (d[0] > 0 ? 32 : 0);
}
const DIR: Record<Cardinal, [number, number]> = { north: [0, -1], south: [0, 1], west: [-1, 0], east: [1, 0] };

const pkey = (x: number, y: number, z: number) => `${x},${y},${z}`;
const unkey = (k: string) => k.split(",").map(Number) as Vec3;
const ckey = (cx: number, cz: number) => `${cx},${cz}`;

/** One fill's resumable state (`18`, pieces 3 and 4): the shape, the read area and where exploration stopped. */
export class WorldFill {
  readonly shape = new Set<string>();
  readonly area = new Set<string>();
  /** Shape positions whose neighbours weren't all explored because the budget ran out. */
  private pending: string[] = [];
  /** Shape positions with a neighbour outside the read area. */
  private readonly blocked = new Set<string>();
  private readonly nbrs: Vec3[];
  private readonly test: (s: string) => boolean;
  private lastStop: FillStop = "complete";

  constructor(
    readonly seed: Vec3,
    match: readonly string[],
    connectivity: number | undefined,
    private readonly grant: SelectGrant,
    private readonly missing: ReadonlySet<string>,
    area: number,
    tags: Record<string, readonly string[]> = {},
  ) {
    this.nbrs = neighbours(connectivity ?? FILL_CONNECTIVITY);
    this.test = materialTest(match, tags);
    const sx = seed[0] >> 4, sz = seed[2] >> 4;
    for (let dz = -area; dz <= area; dz++) for (let dx = -area; dx <= area; dx++) this.addChunk(sx + dx, sz + dz);
  }

  private addChunk(cx: number, cz: number): void {
    if (grantHasChunk(this.grant, cx, cz)) this.area.add(ckey(cx, cz));
  }

  /** Readable: inside the build height, the read area, and a generated chunk. */
  private inArea(x: number, z: number): boolean {
    return this.area.has(ckey(x >> 4, z >> 4));
  }

  private readable(x: number, y: number, z: number): boolean {
    return y >= BUILD_MIN_Y && y <= BUILD_MAX_Y && this.inArea(x, z) && !this.missing.has(ckey(x >> 4, z >> 4));
  }

  /** Runs one step with `budget` blocks; returns the keys added. */
  run(at: StateAt, budget: number): Set<string> {
    const added = new Set<string>();
    let stack: string[];
    if (!this.shape.size) {
      const [x, y, z] = this.seed;
      if (!this.readable(x, y, z) || !this.test(at(x, y, z))) {
        this.lastStop = "complete";
        return added;
      }
      const k = pkey(x, y, z);
      this.shape.add(k);
      added.add(k);
      stack = [k];
    } else {
      // Resume: the positions left pending, then those cut by the area's edge, in a stable order.
      stack = [...this.pending, ...[...this.blocked].filter((k) => !this.pending.includes(k))];
      this.blocked.clear();
    }
    this.pending = [];
    let out = false;
    while (stack.length) {
      const k = stack.pop()!;
      const [x, y, z] = unkey(k);
      for (const d of this.nbrs) {
        const q: Vec3 = [x + d[0], y + d[1], z + d[2]];
        const qk = pkey(...q);
        if (this.shape.has(qk)) continue;
        if (q[1] < BUILD_MIN_Y || q[1] > BUILD_MAX_Y || this.missing.has(ckey(q[0] >> 4, q[2] >> 4))) continue;
        if (!this.inArea(q[0], q[2])) {
          this.blocked.add(k);
          continue;
        }
        if (added.size >= budget) {
          out = true;
          break;
        }
        if (!this.test(at(...q))) continue;
        this.shape.add(qk);
        added.add(qk);
        stack.push(qk);
      }
      if (out) {
        this.pending = [...stack, k];
        break;
      }
    }
    this.lastStop = out ? "budget" : this.blocked.size ? "edge" : "complete";
    return added;
  }

  /** Grows the read area (clipped to the grant). */
  expand(by: ExpandBy): void {
    if (by === "frontier") {
      // The chunks one step across any combination of a frontier position's horizontal faces.
      for (const f of this.frontierFaces()) {
        const dxs = [0, ...(f.faces & 16 ? [-1] : []), ...(f.faces & 32 ? [1] : [])];
        const dzs = [0, ...(f.faces & 4 ? [-1] : []), ...(f.faces & 8 ? [1] : [])];
        for (const dx of dxs) for (const dz of dzs) this.addChunk((f.pos[0] + dx) >> 4, (f.pos[2] + dz) >> 4);
      }
      return;
    }
    if ("box" in by) {
      for (let cz = by.box.min[2] >> 4; cz <= by.box.max[2] >> 4; cz++) for (let cx = by.box.min[0] >> 4; cx <= by.box.max[0] >> 4; cx++) this.addChunk(cx, cz);
      return;
    }
    const [ex, ez] = DIR[by.direction];
    for (const k of [...this.area]) {
      const [cx, cz] = k.split(",").map(Number) as [number, number];
      for (let i = 1; i <= by.chunks; i++) this.addChunk(cx + ex * i, cz + ez * i);
    }
  }

  /**
   * Every frontier position with its faces: the sides each unexplored neighbour lies toward (both
   * sides for a diagonal one). At the area's edge only the horizontal sides count (the area is whole
   * chunk columns); for the budget, every neighbour not in the shape counts.
   */
  private frontierFaces(): { pos: Vec3; faces: number }[] {
    const out = new Map<string, number>();
    const add = (k: string, m: number) => m && out.set(k, (out.get(k) ?? 0) | m);
    for (const k of this.blocked) {
      const [x, , z] = unkey(k);
      let m = 0;
      for (const d of this.nbrs) if (!this.inArea(x + d[0], z + d[2])) m |= faceBits([d[0], 0, d[2]]);
      add(k, m);
    }
    for (const k of this.pending) {
      const [x, y, z] = unkey(k);
      let m = 0;
      for (const d of this.nbrs) if (!this.shape.has(pkey(x + d[0], y + d[1], z + d[2]))) m |= faceBits(d);
      add(k, m);
    }
    return [...out.entries()].map(([k, faces]) => ({ pos: unkey(k), faces }));
  }

  /** The answer: the whole shape, or with `changed` only the sections holding those positions (an expand's delta). */
  result(id: number, dimension: string, changed?: Set<string>): FillResult {
    const bySection = new Map<string, Vec3[]>();
    for (const k of this.shape) {
      const p = unkey(k);
      const sk = pkey(p[0] >> 4, p[1] >> 4, p[2] >> 4);
      let l = bySection.get(sk);
      if (!l) bySection.set(sk, (l = []));
      l.push(p);
    }
    const order = (a: Vec3, b: Vec3) => a[1] - b[1] || a[2] - b[2] || a[0] - b[0];
    const wanted = changed ? new Set([...changed].map((k) => (([x, y, z]) => pkey(x >> 4, y >> 4, z >> 4))(unkey(k)))) : undefined;
    const sections: MaskSection[] = [...bySection.entries()]
      .filter(([sk]) => !wanted || wanted.has(sk))
      .map(([sk, ps]) => {
        const section = unkey(sk);
        if (ps.length === 4096) return { section, mask: "full" as const };
        const mask = new Uint8Array(512);
        for (const p of ps) {
          const i = (p[0] & 15) + 16 * ((p[2] & 15) + 16 * (p[1] & 15));
          mask[i >> 3]! |= 1 << (i & 7);
        }
        return { section, mask };
      })
      .sort((a, b) => order(a.section, b.section));
    const fr = new Map<string, { index: number; faces: number }[]>();
    for (const f of this.frontierFaces()) {
      const sk = pkey(f.pos[0] >> 4, f.pos[1] >> 4, f.pos[2] >> 4);
      let l = fr.get(sk);
      if (!l) fr.set(sk, (l = []));
      l.push({ index: (f.pos[0] & 15) + 16 * ((f.pos[2] & 15) + 16 * (f.pos[1] & 15)), faces: f.faces });
    }
    const frontier: FrontierSection[] = [...fr.entries()]
      .map(([sk, l]) => {
        l.sort((a, b) => a.index - b.index);
        return { section: unkey(sk), index: l.map((e) => e.index), faces: l.map((e) => e.faces) };
      })
      .sort((a, b) => order(a.section, b.section));
    let box: WireBox | null = null;
    for (const k of this.shape) {
      const p = unkey(k);
      if (!box) box = { min: [...p], max: [...p] };
      else
        for (let a = 0; a < 3; a++) {
          box.min[a] = Math.min(box.min[a]!, p[a]!);
          box.max[a] = Math.max(box.max[a]!, p[a]!);
        }
    }
    const missing = [...this.area]
      .filter((k) => this.missing.has(k))
      .map((k) => k.split(",").map(Number) as [number, number])
      .sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    return {
      type: "fill.result",
      id,
      dimension,
      seed: this.seed,
      count: this.shape.size,
      box,
      stopped: this.lastStop,
      ...(changed ? { delta: true as const } : {}),
      missing,
      sections,
      frontier,
    };
  }
}

// ── coarse ────────────────────────────────────────────────────────────────────────────────────

/** One coarse region: per cell, its most common non-air state (ties: first met in index order), air when all air. */
export function coarseRegion(box: WireBox, cell: number, at: StateAt, palette: string[], index: Map<string, number>): CoarseRegion {
  const b = alignBox(box, cell);
  const n = [0, 1, 2].map((a) => (b.max[a]! - b.min[a]! + 1) / cell) as Vec3;
  const states = new Uint32Array(n[0] * n[1] * n[2]);
  let i = 0;
  for (let cy = 0; cy < n[1]; cy++)
    for (let cz = 0; cz < n[2]; cz++)
      for (let cx = 0; cx < n[0]; cx++) {
        const counts = new Map<string, number>(); // insertion order = first met in index order
        for (let y = 0; y < cell; y++)
          for (let z = 0; z < cell; z++)
            for (let x = 0; x < cell; x++) {
              const s = at(b.min[0] + cx * cell + x, b.min[1] + cy * cell + y, b.min[2] + cz * cell + z);
              if (s !== AIR) counts.set(s, (counts.get(s) ?? 0) + 1);
            }
        let best = AIR, most = 0;
        for (const [s, c] of counts) if (c > most) [best, most] = [s, c];
        let p = index.get(best);
        if (p === undefined) index.set(best, (p = palette.push(best) - 1));
        states[i++] = p;
      }
  return { box: b, states };
}

/** Chunks `[cx, cz]` the boxes touch that are in `missing`, ascending by cz, then cx. */
export function missingIn(boxes: readonly WireBox[], missing: ReadonlySet<string>): [number, number][] {
  const out = new Set<string>();
  for (const b of boxes) for (let cz = b.min[2] >> 4; cz <= b.max[2] >> 4; cz++) for (let cx = b.min[0] >> 4; cx <= b.max[0] >> 4; cx++) if (missing.has(ckey(cx, cz))) out.add(ckey(cx, cz));
  return [...out].map((k) => k.split(",").map(Number) as [number, number]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
