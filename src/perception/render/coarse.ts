import type { Box, Vec3 } from "../../core/region.js";

/**
 * Coarse parts drawn one cube per cell (docs/design/18-select.md, piece 5 and *Measured*: rendering
 * is the cost). The world view holds a coarse read as each cell's block written over the whole cell,
 * so the views and slices stay per block; the renderer draws a cell that is still whole as one cube
 * the cell's size instead of c³ blocks. A cell is drawn per block (exactly as before) where it isn't
 * whole: where another read met it (`except`), where the drawn region, a cutaway or a mask cuts it,
 * or where a highlight or fade covers only part of it.
 */

/** A coarse part as the renderer gets it (`RenderOptions.coarse`). */
export interface CoarseInput {
  /** Half-open, aligned to its cells. */
  box: Box;
  cell: number;
  /** Boxes of other reads that meet it: its cells there may no longer be uniform. */
  except?: Box[];
}

interface Grid {
  min: Vec3;
  n: Vec3;
  c: number;
  /** 1 where the cell is drawn whole (one cube, or nothing when air). */
  whole: Uint8Array;
}

/** The whole cells inside the clip, and the cubes to draw for them. */
export interface CoarseCells {
  /** Cubes: the cell's low corner, its state id, its edge and its render flags. */
  cubes: { x: number[]; y: number[]; z: number[]; id: number[]; size: number[]; flags: number[] };
  /** Edge of the whole cell holding a position, or 0 when it is drawn per block. */
  sizeAt(x: number, y: number, z: number): number;
  /** Whether every position of a box lies in whole cells (so its blocks need no visit). */
  covers(box: Box): boolean;
}

/**
 * Finds the whole cells of `parts` inside `clip` (local, half-open). `idAt` gives the state id at a
 * position (the cell's block, read at its low corner); `flagsOf` gives a cell's render flags, or
 * undefined when the cell's positions don't share them (it is then drawn per block).
 */
export function coarseCells(
  parts: readonly CoarseInput[], clip: Box, idAt: (x: number, y: number, z: number) => number,
  flagsOf: (x0: number, y0: number, z0: number, c: number) => number | undefined,
): CoarseCells | undefined {
  const grids: Grid[] = [];
  const cubes: CoarseCells["cubes"] = { x: [], y: [], z: [], id: [], size: [], flags: [] };
  const sizeAt = (x: number, y: number, z: number): number => {
    for (const g of grids) {
      const i = Math.floor((x - g.min[0]) / g.c), j = Math.floor((y - g.min[1]) / g.c), k = Math.floor((z - g.min[2]) / g.c);
      if (i < 0 || j < 0 || k < 0 || i >= g.n[0] || j >= g.n[1] || k >= g.n[2]) continue;
      if (g.whole[(j * g.n[2] + k) * g.n[0] + i]) return g.c;
    }
    return 0;
  };
  for (const p of parts) {
    const c = p.cell;
    if (!(c >= 2) || !Number.isInteger(c)) continue;
    const min = [0, 1, 2].map((a) => Math.ceil(Math.max(p.box.min[a]!, clip.min[a]!) / c) * c) as Vec3;
    const n = [0, 1, 2].map((a) => Math.floor(Math.min(p.box.max[a]!, clip.max[a]!) / c) - min[a]! / c) as Vec3;
    if (n[0] <= 0 || n[1] <= 0 || n[2] <= 0) continue;
    const whole = new Uint8Array(n[0] * n[1] * n[2]).fill(1);
    for (const e of p.except ?? []) {
      const lo = [0, 1, 2].map((a) => Math.max(0, Math.floor((e.min[a]! - min[a]!) / c)));
      const hi = [0, 1, 2].map((a) => Math.min(n[a]!, Math.ceil((e.max[a]! - min[a]!) / c)));
      for (let j = lo[1]!; j < hi[1]!; j++) for (let k = lo[2]!; k < hi[2]!; k++) for (let i = lo[0]!; i < hi[0]!; i++) whole[(j * n[2] + k) * n[0] + i] = 0;
    }
    let idx = 0;
    for (let j = 0; j < n[1]; j++)
      for (let k = 0; k < n[2]; k++)
        for (let i = 0; i < n[0]; i++, idx++) {
          if (!whole[idx]) continue;
          const x = min[0] + i * c, y = min[1] + j * c, z = min[2] + k * c;
          // An overlapping part on the same grid already holds this cell.
          const flags = sizeAt(x, y, z) ? undefined : flagsOf(x, y, z, c);
          if (flags === undefined) {
            whole[idx] = 0;
            continue;
          }
          const id = idAt(x, y, z);
          if (!id) continue;
          cubes.x.push(x), cubes.y.push(y), cubes.z.push(z), cubes.id.push(id), cubes.size.push(c), cubes.flags.push(flags);
        }
    grids.push({ min, n, c, whole });
  }
  if (!grids.length) return undefined;
  const step = Math.min(...grids.map((g) => g.c));
  return {
    cubes,
    sizeAt,
    covers(box) {
      // Cells are aligned to multiples of their edge, so one point per step-aligned block decides it.
      for (let y = Math.floor(box.min[1] / step) * step; y < box.max[1]; y += step)
        for (let z = Math.floor(box.min[2] / step) * step; z < box.max[2]; z += step)
          for (let x = Math.floor(box.min[0] / step) * step; x < box.max[0]; x += step)
            if (!sizeAt(Math.max(x, box.min[0]), Math.max(y, box.min[1]), Math.max(z, box.min[2]))) return false;
      return true;
    },
  };
}

/** Whether a mask holds all (1), none (0) or some (-1) of a cell; `bb` is the mask's bounding box. */
export function cellIn(m: { has(x: number, y: number, z: number): boolean }, bb: Box | undefined, x0: number, y0: number, z0: number, c: number): 0 | 1 | -1 {
  if (!bb || x0 >= bb.max[0] || x0 + c <= bb.min[0] || y0 >= bb.max[1] || y0 + c <= bb.min[1] || z0 >= bb.max[2] || z0 + c <= bb.min[2]) return 0;
  const first = m.has(x0, y0, z0);
  for (let y = y0; y < y0 + c; y++) for (let z = z0; z < z0 + c; z++) for (let x = x0; x < x0 + c; x++) if (m.has(x, y, z) !== first) return -1;
  return first ? 1 : 0;
}
