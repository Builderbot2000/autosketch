/**
 * Regions (docs/design/01-conventions.md). The public API uses inclusive boxes
 * {min:[x,y,z], max:[x,y,z]} with corners in any order; internally boxes are half-open [min, max).
 */

export type Vec3 = [number, number, number];

/** Half-open box: min inclusive, max exclusive. */
export interface Box {
  min: Vec3;
  max: Vec3;
}

/** Public inclusive box, as tools accept and echo it. */
export interface PublicBox {
  min: Vec3;
  max: Vec3;
}

export function fromPublic(b: PublicBox): Box {
  for (const v of [b.min, b.max]) if (v.length !== 3 || v.some((n) => !Number.isInteger(n))) throw new Error(`box corners must be integer [x,y,z] (got ${JSON.stringify(b)})`);
  const min: Vec3 = [Math.min(b.min[0], b.max[0]), Math.min(b.min[1], b.max[1]), Math.min(b.min[2], b.max[2])];
  const max: Vec3 = [Math.max(b.min[0], b.max[0]) + 1, Math.max(b.min[1], b.max[1]) + 1, Math.max(b.min[2], b.max[2]) + 1];
  return { min, max };
}

export function toPublic(b: Box): PublicBox {
  return { min: [...b.min], max: [b.max[0] - 1, b.max[1] - 1, b.max[2] - 1] };
}

export function boxVolume(b: Box): number {
  return Math.max(0, b.max[0] - b.min[0]) * Math.max(0, b.max[1] - b.min[1]) * Math.max(0, b.max[2] - b.min[2]);
}

export function boxSize(b: Box): Vec3 {
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

export function isEmptyBox(b: Box): boolean {
  return boxVolume(b) === 0;
}

export function unionBox(a: Box | undefined, b: Box): Box {
  if (!a || isEmptyBox(a)) return { min: [...b.min], max: [...b.max] };
  if (isEmptyBox(b)) return { min: [...a.min], max: [...a.max] };
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  };
}

export function intersectBox(a: Box, b: Box): Box {
  return {
    min: [Math.max(a.min[0], b.min[0]), Math.max(a.min[1], b.min[1]), Math.max(a.min[2], b.min[2])],
    max: [Math.min(a.max[0], b.max[0]), Math.min(a.max[1], b.max[1]), Math.min(a.max[2], b.max[2])],
  };
}

export function translateBox(b: Box, d: Vec3): Box {
  return { min: [b.min[0] + d[0], b.min[1] + d[1], b.min[2] + d[2]], max: [b.max[0] + d[0], b.max[1] + d[1], b.max[2] + d[2]] };
}

export function containsPoint(b: Box, x: number, y: number, z: number): boolean {
  return x >= b.min[0] && x < b.max[0] && y >= b.min[1] && y < b.max[1] && z >= b.min[2] && z < b.max[2];
}

/** "(0,0,0)–(15,8,11)" in public inclusive form. */
export function formatBox(b: Box): string {
  if (isEmptyBox(b)) return "(empty)";
  const p = toPublic(b);
  return `(${p.min.join(",")})–(${p.max.join(",")})`;
}

export function formatVec(v: Vec3): string {
  return `(${v.join(",")})`;
}
