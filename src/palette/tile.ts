import type { RGB } from "./color.js";
import { Image, type RGBA } from "./image.js";

/**
 * Draws a 3/4 isometric block (top, south face on the left, east face on the right) into a
 * size×size tile, sampling textures with nearest-neighbour. Missing textures draw as magenta.
 */
export interface CubeFaces {
  top?: Image;
  left?: Image; // south
  right?: Image; // east
  topTint?: RGB;
  sideTint?: RGB;
}

const MISSING: RGBA = [255, 0, 255, 255];
const SHADE = { top: 1, left: 0.82, right: 0.64 };

export function drawCube(dst: Image, ox: number, oy: number, size: number, faces: CubeFaces): void {
  const T = size;
  for (let py = 0; py < T; py++)
    for (let px = 0; px < T; px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      // Top face: (x, z) in [0,1)².
      const dx = (cx - T / 2) / (T / 2);
      const dy = cy / (T / 4);
      const x = (dx + dy) / 2;
      const z = (dy - dx) / 2;
      let color: RGBA | undefined;
      if (x >= 0 && x < 1 && z >= 0 && z < 1) {
        color = sample(faces.top, x, z, SHADE.top, faces.topTint);
      } else if (cx < T / 2) {
        const u = cx / (T / 2);
        const v = (cy - T / 4 - (u * T) / 4) / (T / 2);
        if (u >= 0 && u < 1 && v >= 0 && v < 1) color = sample(faces.left, u, v, SHADE.left, faces.sideTint);
      } else {
        const u = (cx - T / 2) / (T / 2);
        const v = (cy - T / 2 + (u * T) / 4) / (T / 2);
        if (u >= 0 && u < 1 && v >= 0 && v < 1) color = sample(faces.right, u, v, SHADE.right, faces.sideTint);
      }
      if (color) dst.blend(ox + px, oy + py, color);
    }
}

function sample(img: Image | undefined, u: number, v: number, shade: number, tint?: RGB): RGBA {
  if (!img) return MISSING;
  const [r, g, b, a] = img.get(Math.min(img.width - 1, Math.floor(u * img.width)), Math.min(img.height - 1, Math.floor(v * img.height)));
  const k = shade / 255;
  return tint ? [r * tint[0] * k, g * tint[1] * k, b * tint[2] * k, a] : [r * shade, g * shade, b * shade, a];
}

/** Shape badge colours (also explained in sheet captions). */
export const BADGES = {
  stairs: [255, 200, 40, 255] as RGBA,
  slab: [60, 200, 255, 255] as RGBA,
  wall: [255, 100, 100, 255] as RGBA,
  fence: [120, 230, 90, 255] as RGBA,
  extras: [230, 110, 255, 255] as RGBA,
};
