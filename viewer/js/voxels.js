// Voxels and meshing for the viewer's 3D views. Pure (no DOM, no WebGL), so tests run it in Node.
//
// Wire formats (src/observe/deltas.ts, src/observe/voxels.ts): records are 16 bytes, int32 x, y, z
// and uint32 state id, little-endian. A voxel payload is "ASVX", u32 header length, header JSON,
// then records.

/** Decodes a voxel payload into its header and records (Int32Array, 4 per block). */
export function decodeVoxels(buf) {
  const bytes = new Uint8Array(buf);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "ASVX") throw new Error("not a voxel payload");
  const len = new DataView(buf).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len)));
  return { header, records: new Int32Array(buf.slice(8 + len)) };
}

/** Records from a raw delta range (an ArrayBuffer whose length is a multiple of 16). */
export const decodeRecords = (buf) => new Int32Array(buf);

const CHUNK = 16;
export const FACE_DIRS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];

/** Sparse voxels in 16³ chunks, with dirty tracking for remeshing. */
export class VoxelGrid {
  constructor() {
    /** @type {Map<string, Uint32Array>} */
    this.chunks = new Map();
    this.dirty = new Set();
  }

  static key(cx, cy, cz) {
    return cx + "," + cy + "," + cz;
  }

  get(x, y, z) {
    const c = this.chunks.get(VoxelGrid.key(x >> 4, y >> 4, z >> 4));
    return c ? c[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] : 0;
  }

  set(x, y, z, id) {
    const cx = x >> 4, cy = y >> 4, cz = z >> 4;
    const k = VoxelGrid.key(cx, cy, cz);
    let c = this.chunks.get(k);
    if (!c) {
      if (!id) return;
      this.chunks.set(k, (c = new Uint32Array(4096)));
    }
    c[((y & 15) << 8) | ((z & 15) << 4) | (x & 15)] = id;
    this.dirty.add(k);
    // Faces against neighbouring chunks may appear or disappear.
    const lx = x & 15, ly = y & 15, lz = z & 15;
    if (lx === 0) this.dirty.add(VoxelGrid.key(cx - 1, cy, cz));
    if (lx === 15) this.dirty.add(VoxelGrid.key(cx + 1, cy, cz));
    if (ly === 0) this.dirty.add(VoxelGrid.key(cx, cy - 1, cz));
    if (ly === 15) this.dirty.add(VoxelGrid.key(cx, cy + 1, cz));
    if (lz === 0) this.dirty.add(VoxelGrid.key(cx, cy, cz - 1));
    if (lz === 15) this.dirty.add(VoxelGrid.key(cx, cy, cz + 1));
  }

  /** Applies records (x, y, z, id); `shift` translates them first. */
  applyRecords(rec, shift = [0, 0, 0]) {
    for (let i = 0; i + 3 < rec.length; i += 4) this.set(rec[i] + shift[0], rec[i + 1] + shift[1], rec[i + 2] + shift[2], rec[i + 3]);
  }

  /** Sets every voxel of an inclusive box to air. */
  clearBox(box) {
    for (let y = box.min[1]; y <= box.max[1]; y++)
      for (let z = box.min[2]; z <= box.max[2]; z++) for (let x = box.min[0]; x <= box.max[0]; x++) if (this.get(x, y, z)) this.set(x, y, z, 0);
  }

  clear() {
    for (const k of this.chunks.keys()) this.dirty.add(k);
    this.chunks.clear();
  }

  /** Inclusive bounds of non-air voxels, or undefined. */
  bounds() {
    let min, max;
    for (const [k, c] of this.chunks) {
      const [cx, cy, cz] = k.split(",").map(Number);
      for (let i = 0; i < 4096; i++) {
        if (!c[i]) continue;
        const x = cx * CHUNK + (i & 15), y = cy * CHUNK + (i >> 8), z = cz * CHUNK + ((i >> 4) & 15);
        if (!min) {
          min = [x, y, z];
          max = [x, y, z];
        } else {
          if (x < min[0]) min[0] = x;
          if (y < min[1]) min[1] = y;
          if (z < min[2]) min[2] = z;
          if (x > max[0]) max[0] = x;
          if (y > max[1]) max[1] = y;
          if (z > max[2]) max[2] = z;
        }
      }
    }
    return min ? { min, max } : undefined;
  }
}

/** Floats per vertex: x y z  u v  r g b a. u < 0 means untextured (colour only). */
export const STRIDE = 9;

const FALLBACK_SEE_THROUGH = /glass|leaves|water|ice|pane|bars|fence|torch|slab|stairs|door|flower|sapling|carpet|rail|button|lever|sign|lantern|chain|wall|grass$|fern|vine/;

/**
 * A model for a state with no baked model (no instance assets, or not baked yet): a cube in a
 * colour hashed from the block id, so blocks stay distinguishable.
 */
export function fallbackModel(state) {
  const id = (state ?? "?").split("[")[0];
  let h = 0x811c9dc5; // FNV-1a, then a final mix so similar ids get distant hues
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  const [r, g, b] = hsl((h % 360) / 360, 0.4, 0.3 + ((h >>> 9) % 40) / 100);
  const shade = [0.5, 1, 0.8, 0.8, 0.6, 0.6];
  const q = FACE_DIRS.map((_, f) => ({ p: cubeFace(f), uv: null, c: [r * shade[f], g * shade[f], b * shade[f]], cull: f }));
  return { q, occ: FALLBACK_SEE_THROUGH.test(id) ? 0 : 63, fallback: true };
}

function cubeFace(f) {
  // TL TR BR BL as seen from outside, matching bake.ts corners().
  switch (f) {
    case 0: return [0, 0, 1, 1, 0, 1, 1, 0, 0, 0, 0, 0];
    case 1: return [0, 1, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1];
    case 2: return [1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0];
    case 3: return [0, 1, 1, 1, 1, 1, 1, 0, 1, 0, 0, 1];
    case 4: return [0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0];
    default: return [1, 1, 1, 1, 1, 0, 1, 0, 0, 1, 0, 1];
  }
}

function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/**
 * Meshes one chunk. `modelFor(id)` returns a baked model (`/assets/models.json` entry) or a
 * fallback. A quad with a cull face is skipped when the neighbour on that side occludes the
 * opposite face. `ghost(x, y, z)` marks context blocks: drawn translucent and desaturated in the
 * blended pass (the `render({ context: "ghost" })` convention, 06).
 * Returns { opaque, blend } vertex arrays (triangles, STRIDE floats per vertex).
 */
export function meshChunk(grid, key, modelFor, atlasSize, ghost) {
  const c = grid.chunks.get(key);
  const opaque = [], blend = [];
  if (!c) return { opaque: new Float32Array(0), blend: new Float32Array(0) };
  const [cx, cy, cz] = key.split(",").map(Number);
  const aw = atlasSize?.[0] || 1, ah = atlasSize?.[1] || 1;
  for (let i = 0; i < 4096; i++) {
    const id = c[i];
    if (!id) continue;
    const m = modelFor(id);
    if (!m) continue;
    const x = cx * CHUNK + (i & 15), y = cy * CHUNK + (i >> 8), z = cz * CHUNK + ((i >> 4) & 15);
    const isGhost = ghost ? ghost(x, y, z) : false;
    for (const q of m.q) {
      if (q.cull >= 0) {
        const d = FACE_DIRS[q.cull];
        const n = grid.get(x + d[0], y + d[1], z + d[2]);
        if (n) {
          const nm = modelFor(n);
          if (nm && nm.occ & (1 << (q.cull ^ 1)) && !(isGhost !== (ghost ? ghost(x + d[0], y + d[1], z + d[2]) : false))) continue;
        }
      }
      const out = isGhost || q.t ? blend : opaque;
      const a = isGhost ? 0.3 : 1;
      let [r, g, b] = q.c;
      if (isGhost) {
        const lum = 0.3 * r + 0.59 * g + 0.11 * b;
        r = g = b = lum * 0.9 + 0.1;
      }
      for (const v of [0, 1, 2, 0, 2, 3]) {
        out.push(x + q.p[v * 3], y + q.p[v * 3 + 1], z + q.p[v * 3 + 2]);
        if (q.uv) out.push(q.uv[v * 2] / aw, q.uv[v * 2 + 1] / ah);
        else out.push(-1, -1);
        out.push(r, g, b, a);
      }
    }
  }
  return { opaque: new Float32Array(opaque), blend: new Float32Array(blend) };
}
