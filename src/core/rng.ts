/**
 * Deterministic per-position randomness for material expressions (01: "same seed → same result").
 * A stateless hash of (seed, salt, x, y, z), so results don't depend on iteration order.
 */

function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Uniform in [0, 1). */
export function hash01(seed: number, salt: number, x: number, y: number, z: number): number {
  let h = mix(seed | 0);
  h = mix(h ^ (salt | 0));
  h = mix(h ^ (x | 0));
  h = mix(h ^ (y | 0));
  h = mix(h ^ (z | 0));
  return h / 4294967296;
}

/** 32-bit hash of a string (stable salts for nested expressions). */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** Smooth 3D value noise in [0, 1), scale = feature size in blocks. */
export function valueNoise(seed: number, salt: number, x: number, y: number, z: number, scale: number): number {
  const s = Math.max(1, scale);
  const fx = x / s, fy = y / s, fz = z / s;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
  const tx = smooth(fx - x0), ty = smooth(fy - y0), tz = smooth(fz - z0);
  const c = (dx: number, dy: number, dz: number) => hash01(seed, salt, x0 + dx, y0 + dy, z0 + dz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const x00 = lerp(c(0, 0, 0), c(1, 0, 0), tx), x10 = lerp(c(0, 1, 0), c(1, 1, 0), tx);
  const x01 = lerp(c(0, 0, 1), c(1, 0, 1), tx), x11 = lerp(c(0, 1, 1), c(1, 1, 1), tx);
  return Math.min(0.999999, lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz));
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
