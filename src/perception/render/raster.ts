import type { RGB } from "../../palette/color.js";
import type { Image } from "../../palette/image.js";

/**
 * Pure-JS triangle rasterizer with a z-buffer (docs/design/06-perception.md). Orthographic cameras
 * interpolate textures affinely, which is exact for them. Perspective cameras (06, *Cameras*)
 * divide by depth: the z-buffer holds -1/depth (linear in screen space) and textures are
 * interpolated perspective-correctly. Callers clip geometry to the near plane before projecting
 * (render.ts). Draws at a supersampled size and downsamples for anti-aliasing.
 */

export type V3 = [number, number, number];

export interface Camera {
  right: V3;
  up: V3;
  /** Into the scene: larger dot(p, forward) = farther away. */
  forward: V3;
  /** Pixels per block; for a perspective camera, the focal length in pixels (image half-height / tan(fov/2)). */
  scale: number;
  /** Screen-space centre (in camera units) placed at the image centre. */
  cx: number;
  cy: number;
  width: number;
  height: number;
  /** Perspective camera: the eye (world point). The image centre looks along `forward`; cx and cy are 0. */
  eye?: V3;
}

/** Near-plane distance of perspective cameras, in blocks: geometry closer to the eye is clipped. */
export const NEAR = 0.05;

export function dot(a: V3, b: V3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function normalize(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Camera basis looking along -toward (toward = direction from the scene to the camera). */
export function basis(toward: V3, upHint: V3 = [0, 1, 0]): { right: V3; up: V3; forward: V3 } {
  const forward = normalize([-toward[0], -toward[1], -toward[2]]);
  let right = cross(forward, upHint);
  if (Math.hypot(...right) < 1e-6) right = cross(forward, [0, 0, -1]);
  right = normalize(right);
  const up = cross(right, forward);
  return { right, up, forward };
}

export class Raster {
  readonly color: Float32Array;
  readonly depth: Float32Array;
  /** Perspective camera (cam.eye set). */
  readonly persp: boolean;
  /**
   * Depth peeling (06, *Cameras*): the previous layer's depth per pixel. When set, only fragments
   * clearly beyond it are drawn, so each pass finds the next surface.
   */
  floor?: Float32Array;

  constructor(
    readonly width: number,
    readonly height: number,
    readonly cam: Camera,
  ) {
    this.color = new Float32Array(width * height * 3);
    this.depth = new Float32Array(width * height).fill(Infinity);
    this.persp = !!cam.eye;
  }

  /** Camera-space coordinates [right, up, depth] of a world point (perspective: relative to the eye). */
  viewSpace(x: number, y: number, z: number): V3 {
    const c = this.cam;
    if (c.eye) (x -= c.eye[0]), (y -= c.eye[1]), (z -= c.eye[2]);
    return [x * c.right[0] + y * c.right[1] + z * c.right[2], x * c.up[0] + y * c.up[1] + z * c.up[2], x * c.forward[0] + y * c.forward[1] + z * c.forward[2]];
  }

  /** Perspective: camera-space point (beyond the near plane) → [px, py, -1/depth]. */
  projectView(vx: number, vy: number, vz: number): V3 {
    const k = this.cam.scale / vz;
    return [vx * k + this.width / 2, -vy * k + this.height / 2, -1 / vz];
  }

  /**
   * World point → [px, py, depth] in this raster's pixels. Perspective: depth is -1/distance along
   * the view (smaller is nearer, as for orthographic), and the point must lie beyond the near plane.
   */
  project(x: number, y: number, z: number): V3 {
    const c = this.cam;
    if (c.eye) return this.projectView(...this.viewSpace(x, y, z));
    const sx = x * c.right[0] + y * c.right[1] + z * c.right[2];
    const sy = x * c.up[0] + y * c.up[1] + z * c.up[2];
    const d = x * c.forward[0] + y * c.forward[1] + z * c.forward[2];
    return [(sx - c.cx) * c.scale + this.width / 2, -(sy - c.cy) * c.scale + this.height / 2, d];
  }

  fillBackground(top: RGB, bottom: RGB): void {
    for (let y = 0; y < this.height; y++) {
      const t = y / Math.max(1, this.height - 1);
      const r = top[0] + (bottom[0] - top[0]) * t, g = top[1] + (bottom[1] - top[1]) * t, b = top[2] + (bottom[2] - top[2]) * t;
      for (let x = 0; x < this.width; x++) {
        const i = (y * this.width + x) * 3;
        this.color[i] = r;
        this.color[i + 1] = g;
        this.color[i + 2] = b;
      }
    }
  }

  /**
   * Textured triangle. p: screen points; uv: texture coords 0..1. mode "opaque" alpha-tests and
   * writes depth; "blend" alpha-blends behind nearer opaque pixels without writing depth.
   * `overlay` mixes a colour over the shaded result ([r, g, b, amount 0..1], for highlights);
   * `alphaScale` scales the blended alpha (x-ray).
   */
  triangle(p0: V3, p1: V3, p2: V3, uv: number[], img: Image, tint: RGB | undefined, shade: number, mode: "opaque" | "blend", flat?: RGB, overlay?: [number, number, number, number], alphaScale = 1): void {
    const minX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
    const maxX = Math.min(this.width - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
    const minY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));
    if (minX > maxX || minY > maxY) return;
    const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]);
    if (Math.abs(area) < 1e-9) return;
    const inv = 1 / area;
    const tw = img.width, th = img.height, td = img.data;
    const tr = tint ? tint[0] / 255 : 1, tg = tint ? tint[1] / 255 : 1, tb = tint ? tint[2] / 255 : 1;
    const persp = this.persp;
    // Perspective: 1/depth per vertex, for perspective-correct texture coordinates.
    const q0 = -p0[2], q1 = -p1[2], q2 = -p2[2];
    const floor = this.floor;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const w0 = ((p1[0] - px) * (p2[1] - py) - (p1[1] - py) * (p2[0] - px)) * inv;
        const w1 = ((p2[0] - px) * (p0[1] - py) - (p2[1] - py) * (p0[0] - px)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
        const z = w0 * p0[2] + w1 * p1[2] + w2 * p2[2];
        const di = y * this.width + x;
        // Small bias so coplanar overlays (e.g. a pane against glass) favour the later quad
        // (relative to the depth for perspective, whose depths shrink with distance).
        if (persp ? z >= this.depth[di]! + z * 1e-5 : z >= this.depth[di]! - 1e-5) continue;
        // Peeling: skip the previous layer and anything nearer (a relative margin for perspective).
        if (floor && (persp ? z <= floor[di]! * (1 - 1e-4) : z <= floor[di]! + 1e-3)) continue;
        let r: number, g: number, b: number, a: number;
        if (flat) {
          [r, g, b] = flat;
          a = 255;
        } else if (persp) {
          const a0 = w0 * q0, a1 = w1 * q1, a2 = w2 * q2, k = 1 / (a0 + a1 + a2);
          const u = (a0 * uv[0]! + a1 * uv[2]! + a2 * uv[4]!) * k;
          const v = (a0 * uv[1]! + a1 * uv[3]! + a2 * uv[5]!) * k;
          const tx = Math.min(tw - 1, Math.max(0, Math.floor(u * tw)));
          const ty = Math.min(th - 1, Math.max(0, Math.floor(v * th)));
          const ti = (ty * tw + tx) * 4;
          r = td[ti]!;
          g = td[ti + 1]!;
          b = td[ti + 2]!;
          a = td[ti + 3]!;
        } else {
          const u = w0 * uv[0]! + w1 * uv[2]! + w2 * uv[4]!;
          const v = w0 * uv[1]! + w1 * uv[3]! + w2 * uv[5]!;
          const tx = Math.min(tw - 1, Math.max(0, Math.floor(u * tw)));
          const ty = Math.min(th - 1, Math.max(0, Math.floor(v * th)));
          const ti = (ty * tw + tx) * 4;
          r = td[ti]!;
          g = td[ti + 1]!;
          b = td[ti + 2]!;
          a = td[ti + 3]!;
        }
        if (mode === "opaque" && a < 128) continue;
        if (a === 0) continue;
        r *= tr * shade;
        g *= tg * shade;
        b *= tb * shade;
        if (overlay) {
          const k = overlay[3];
          r = r * (1 - k) + overlay[0] * k;
          g = g * (1 - k) + overlay[1] * k;
          b = b * (1 - k) + overlay[2] * k;
        }
        a *= alphaScale;
        const ci = di * 3;
        if (mode === "opaque") {
          this.color[ci] = r;
          this.color[ci + 1] = g;
          this.color[ci + 2] = b;
          this.depth[di] = z;
        } else {
          const t = a / 255;
          this.color[ci] = this.color[ci]! * (1 - t) + r * t;
          this.color[ci + 1] = this.color[ci + 1]! * (1 - t) + g * t;
          this.color[ci + 2] = this.color[ci + 2]! * (1 - t) + b * t;
        }
      }
    }
  }

  /** Line in screen space (Xiaolin-free: simple stepping), blended, no depth test. */
  line(a: V3, b: V3, rgb: RGB, alpha: number, width = 1, depthTest = false): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))));
    const half = Math.floor(width / 2);
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = Math.round(a[0] + (b[0] - a[0]) * t), y = Math.round(a[1] + (b[1] - a[1]) * t), z = a[2] + (b[2] - a[2]) * t;
      for (let dy = -half; dy < width - half; dy++)
        for (let dx = -half; dx < width - half; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= this.width || yy >= this.height) continue;
          const di = yy * this.width + xx;
          if (depthTest && z >= this.depth[di]!) continue;
          const ci = di * 3;
          this.color[ci] = this.color[ci]! * (1 - alpha) + rgb[0] * alpha;
          this.color[ci + 1] = this.color[ci + 1]! * (1 - alpha) + rgb[1] * alpha;
          this.color[ci + 2] = this.color[ci + 2]! * (1 - alpha) + rgb[2] * alpha;
        }
    }
  }

  /** Box-filter downsample by an integer factor into an RGBA image region. */
  /**
   * Box-filters into `dst`. With `transparent`, pixels nothing was drawn on stay clear and edges get
   * partial alpha (coverage from the depth buffer), for thumbnails.
   */
  downsampleInto(dst: Image, ox: number, oy: number, factor: number, transparent = false): void {
    const w = Math.floor(this.width / factor), h = Math.floor(this.height / factor);
    const n = factor * factor;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, covered = 0;
        for (let sy = 0; sy < factor; sy++)
          for (let sx = 0; sx < factor; sx++) {
            const pi = (y * factor + sy) * this.width + (x * factor + sx);
            if (transparent && this.depth[pi] === Infinity) continue;
            covered++;
            r += this.color[pi * 3]!;
            g += this.color[pi * 3 + 1]!;
            b += this.color[pi * 3 + 2]!;
          }
        const X = ox + x, Y = oy + y;
        if (X < 0 || Y < 0 || X >= dst.width || Y >= dst.height) continue;
        const di = (Y * dst.width + X) * 4;
        const k = Math.max(1, covered);
        dst.data[di] = r / k;
        dst.data[di + 1] = g / k;
        dst.data[di + 2] = b / k;
        dst.data[di + 3] = transparent ? Math.round((covered / n) * 255) : 255;
      }
  }
}
