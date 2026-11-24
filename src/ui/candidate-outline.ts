import type { Mask } from "../core/mask.js";
import { CANDIDATE_FILL, UI_FILL_SPANS, type UiFill, type UiSpan } from "../world/protocol/messages.js";

/**
 * The select candidate drawn in the world (docs/design/18-select.md, piece 8; `13`, *In-game UI*,
 * Fill): the steady fill record the feed sends for the world view's `candidate`. The MCP computes
 * both drawings so the client stays thin (`16`):
 *
 * - `faces`: the tinted shell, the outer faces of the 16³ sections the shape occupies. A face
 *   between two occupied sections is left out, so the tint never doubles; the rest are merged into
 *   rectangles per plane.
 * - `edges`: the shape's outline, every block edge where the mask's surface bends (one or three of
 *   the four blocks around the edge in the shape, or two diagonally), merged into segments along
 *   each line, across sections too.
 *
 * Measurements only: nothing here decides what the shape is. Past {@link UI_FILL_SPANS} the edges
 * are left out whole (a partial outline would show a shape that isn't there), then the faces cut.
 */

/** The candidate's colour: a pale gold, lighter than any job colour (`jobColour`, lightness 0.55) and not the save flash's white. */
export const CANDIDATE_COLOUR = "#ffe680";
/** The shell's constant alpha: a faint tint that leaves the build readable through it. */
export const CANDIDATE_ALPHA = 48;

/** The candidate's fill record: shell faces and outline edges, in world corner coordinates. */
export function candidateFill(mask: Mask, dimension: string): UiFill {
  const sections = sectionsOf(mask);
  const faces = shellFaces(sections.keys());
  const edges = faces.length >= UI_FILL_SPANS ? [] : maskEdges(sections, UI_FILL_SPANS - faces.length);
  return {
    id: CANDIDATE_FILL,
    colour: CANDIDATE_COLOUR,
    alpha: CANDIDATE_ALPHA,
    dimension,
    faces: faces.slice(0, UI_FILL_SPANS),
    edges: edges ?? [],
  };
}

// -- sections ----------------------------------------------------------------------------------

/** A section's key (as `core/mask.ts`'s): 4096 sections either way on x and z, 128 on y. */
const key = (sx: number, sy: number, sz: number) => ((sx + 4096) * 8192 + (sz + 4096)) * 256 + (sy + 128);
const unkey = (k: number): [number, number, number] => {
  const sy = (k % 256) - 128;
  const r = Math.floor(k / 256);
  return [Math.floor(r / 8192) - 4096, sy, (r % 8192) - 4096];
};

interface Section {
  /** One byte per position, `x + 16·(z + 16·y)`. */
  bits: Uint8Array;
  count: number;
}

/** The mask per occupied 16³ section. */
function sectionsOf(mask: Mask): Map<number, Section> {
  const out = new Map<number, Section>();
  let lastKey = NaN, last: Section | undefined;
  mask.forEach((x, y, z) => {
    const k = key(x >> 4, y >> 4, z >> 4);
    if (k !== lastKey) {
      lastKey = k;
      last = out.get(k);
      if (!last) out.set(k, (last = { bits: new Uint8Array(4096), count: 0 }));
    }
    last!.bits[(x & 15) | ((z & 15) << 4) | ((y & 15) << 8)] = 1;
    last!.count++;
  });
  return out;
}

// -- shell faces -------------------------------------------------------------------------------

/**
 * The outer faces of the occupied sections (section coordinates as {@link key}s), merged into
 * rectangles per plane, in world corner coordinates. Two sections facing each other hide both faces.
 */
export function shellFaces(occupied: Iterable<number>): UiSpan[] {
  const set = new Set(occupied);
  // Per axis and plane (in sections): the cells (u, v) of the other two axes, in axis order.
  const planes = new Map<string, { axis: number; plane: number; cells: Set<string> }>();
  for (const k of set) {
    const s = unkey(k);
    for (let axis = 0; axis < 3; axis++)
      for (const dir of [-1, 1]) {
        const n: [number, number, number] = [s[0], s[1], s[2]];
        n[axis]! += dir;
        if (set.has(key(...n))) continue;
        const plane = s[axis]! + (dir > 0 ? 1 : 0);
        const [u, v] = others(axis).map((a) => s[a]!) as [number, number];
        const pk = `${axis},${plane}`;
        let p = planes.get(pk);
        if (!p) planes.set(pk, (p = { axis, plane, cells: new Set() }));
        p.cells.add(`${u},${v}`);
      }
  }
  const out: UiSpan[] = [];
  for (const { axis, plane, cells } of planes.values())
    for (const r of mergeRects(cells)) {
      const [ua, va] = others(axis);
      const lo: [number, number, number] = [0, 0, 0], hi: [number, number, number] = [0, 0, 0];
      lo[axis] = hi[axis] = plane * 16;
      lo[ua] = r.u * 16;
      hi[ua] = (r.u + r.w) * 16;
      lo[va] = r.v * 16;
      hi[va] = (r.v + r.h) * 16;
      out.push([lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]]);
    }
  return out.sort(cmpSpan);
}

/** The two axes other than `axis`, in order. */
const others = (axis: number): [number, number] => (axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1]);

/** Greedy rectangles over a set of `"u,v"` cells: runs along v, grown along u while the whole run continues. */
function mergeRects(cells: Set<string>): { u: number; v: number; w: number; h: number }[] {
  const list = [...cells].map((c) => c.split(",").map(Number) as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const used = new Set<string>();
  const free = (u: number, v: number) => cells.has(`${u},${v}`) && !used.has(`${u},${v}`);
  const out: { u: number; v: number; w: number; h: number }[] = [];
  for (const [u, v] of list) {
    if (used.has(`${u},${v}`)) continue;
    let h = 1;
    while (free(u, v + h)) h++;
    let w = 1;
    for (;;) {
      let row = true;
      for (let j = 0; j < h && row; j++) row = free(u + w, v + j);
      if (!row) break;
      w++;
    }
    for (let i = 0; i < w; i++) for (let j = 0; j < h; j++) used.add(`${u + i},${v + j}`);
    out.push({ u, v, w, h });
  }
  return out;
}

// -- outline edges -----------------------------------------------------------------------------

/** Padded section: positions −1 … 15 on each axis, so every edge a section owns sees its four blocks. */
const P = 17;
const pad = (x: number, y: number, z: number) => x + 1 + P * (z + 1 + P * (y + 1));

/**
 * The mask's outline as segments, in world corner coordinates. A unit edge along an axis lies on the
 * line between four blocks; it is drawn when the surface bends there (one or three of the four in the
 * shape, or two diagonally), not where the surface is flat (two side by side) or absent. Each section
 * owns the edges on lines through its own corners (corner coordinates 0 … 15 within it), so every
 * edge is looked at once; runs are then merged along each line across sections.
 *
 * Undefined past `limit` segments: each line holds at least one, so it stops as soon as more lines
 * than that carry an edge, and otherwise counts the merged segments.
 */
function maskEdges(sections: Map<number, Section>, limit = Infinity): UiSpan[] | undefined {
  // Sections owning an edge next to the shape: each occupied one and its neighbours above on each axis.
  const owners = new Set<number>();
  for (const k of sections.keys()) {
    const [sx, sy, sz] = unkey(k);
    for (let d = 0; d < 8; d++) owners.add(key(sx + (d & 1), sy + ((d >> 1) & 1), sz + ((d >> 2) & 1)));
  }
  const lines = new Map<string, number[]>();
  const grid = new Uint8Array(P * P * P);
  for (const k of owners) {
    const [sx, sy, sz] = unkey(k);
    // The eight sections whose blocks reach this one's padded grid (itself and those below on each axis).
    const parts: { s: Section | undefined; d: number }[] = [];
    let full = 0, present = 0;
    for (let d = 0; d < 8; d++) {
      const s = sections.get(key(sx - (d & 1), sy - ((d >> 1) & 1), sz - ((d >> 2) & 1)));
      parts.push({ s, d });
      if (s) present++;
      if (s?.count === 4096) full++;
    }
    if (full === 8) continue; // solid all round: no surface here
    grid.fill(0);
    for (const { s, d } of parts) {
      if (!s) continue;
      const xs = d & 1 ? [15] : RANGE, ys = (d >> 1) & 1 ? [15] : RANGE, zs = (d >> 2) & 1 ? [15] : RANGE;
      const ox = d & 1 ? -16 : 0, oy = (d >> 1) & 1 ? -16 : 0, oz = (d >> 2) & 1 ? -16 : 0;
      for (const y of ys) for (const z of zs) for (const x of xs) if (s.bits[x | (z << 4) | (y << 8)]) grid[pad(x + ox, y + oy, z + oz)] = 1;
    }
    if (!present) continue;
    const bx = sx * 16, by = sy * 16, bz = sz * 16;
    for (let axis = 0; axis < 3; axis++)
      for (let a = 0; a < 16; a++)
        for (let b = 0; b < 16; b++) {
          // The line along `axis` through corner (a, b) of the other two axes; t runs along it.
          let start = -1;
          for (let t = 0; t <= 16; t++) {
            const on = t < 16 && bends(grid, axis, t, a, b);
            if (on && start < 0) start = t;
            else if (!on && start >= 0) {
              const [ua, va] = others(axis);
              const base: [number, number, number] = [bx, by, bz];
              const lk = `${axis},${base[ua]! + a},${base[va]! + b}`;
              let l = lines.get(lk);
              if (!l) {
                if (lines.size >= limit) return undefined;
                lines.set(lk, (l = []));
              }
              l.push(base[axis]! + start, base[axis]! + t);
              start = -1;
            }
          }
        }
  }
  const out: UiSpan[] = [];
  for (const [lk, runs] of lines) {
    const [axis, p, q] = lk.split(",").map(Number) as [number, number, number];
    const pairs: [number, number][] = [];
    for (let i = 0; i < runs.length; i += 2) pairs.push([runs[i]!, runs[i + 1]!]);
    pairs.sort((x, y) => x[0] - y[0]);
    let cur: [number, number] | undefined;
    const emit = (r: [number, number]) => {
      const [ua, va] = others(axis);
      const lo: [number, number, number] = [0, 0, 0], hi: [number, number, number] = [0, 0, 0];
      lo[axis] = r[0];
      hi[axis] = r[1];
      lo[ua] = hi[ua] = p;
      lo[va] = hi[va] = q;
      out.push([lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]]);
    };
    for (const r of pairs) {
      if (cur && r[0] <= cur[1]) cur[1] = Math.max(cur[1], r[1]);
      else {
        if (cur) emit(cur);
        cur = [r[0], r[1]];
      }
    }
    if (cur) emit(cur);
    if (out.length > limit) return undefined;
  }
  return out.sort(cmpSpan);
}

const RANGE = Array.from({ length: 16 }, (_, i) => i);

/** Whether the surface bends on the unit edge at `t` along `axis`, on the line through corner (a, b) of the other two axes. */
function bends(g: Uint8Array, axis: number, t: number, a: number, b: number): boolean {
  let q00: number, q10: number, q01: number, q11: number;
  if (axis === 0) {
    // a = y, b = z
    q00 = g[pad(t, a - 1, b - 1)]!;
    q10 = g[pad(t, a, b - 1)]!;
    q01 = g[pad(t, a - 1, b)]!;
    q11 = g[pad(t, a, b)]!;
  } else if (axis === 1) {
    // a = x, b = z
    q00 = g[pad(a - 1, t, b - 1)]!;
    q10 = g[pad(a, t, b - 1)]!;
    q01 = g[pad(a - 1, t, b)]!;
    q11 = g[pad(a, t, b)]!;
  } else {
    // a = x, b = y
    q00 = g[pad(a - 1, b - 1, t)]!;
    q10 = g[pad(a, b - 1, t)]!;
    q01 = g[pad(a - 1, b, t)]!;
    q11 = g[pad(a, b, t)]!;
  }
  const n = q00 + q10 + q01 + q11;
  return n === 1 || n === 3 || (n === 2 && q00 === q11);
}

function cmpSpan(a: UiSpan, b: UiSpan): number {
  for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}
