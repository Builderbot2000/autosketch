import { crc32, deflateSync, inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import { GLYPH_H, glyph } from "./font.js";

export type RGBA = [number, number, number, number];

/** Minimal RGBA raster for sheets, tiles and (later) renders. */
export class Image {
  readonly data: Uint8ClampedArray;
  constructor(
    readonly width: number,
    readonly height: number,
    data?: Uint8ClampedArray | Uint8Array,
  ) {
    this.data = data ? new Uint8ClampedArray(data.buffer, data.byteOffset, width * height * 4) : new Uint8ClampedArray(width * height * 4);
  }

  static decodePng(buf: Buffer): Image {
    let png;
    try {
      png = PNG.sync.read(buf);
    } catch {
      // Some optimisers leave bytes after the zlib stream; the game tolerates it, pngjs doesn't.
      png = PNG.sync.read(repackPng(buf));
    }
    return new Image(png.width, png.height, png.data);
  }

  encodePng(): Buffer {
    const png = new PNG({ width: this.width, height: this.height });
    png.data = Buffer.from(this.data.buffer, this.data.byteOffset, this.data.length);
    return PNG.sync.write(png, { colorType: 6 });
  }

  get(x: number, y: number): RGBA {
    const i = (y * this.width + x) * 4;
    const d = this.data;
    return [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!];
  }

  /** Alpha-blends a colour onto the pixel (no-op outside bounds). */
  blend(x: number, y: number, [r, g, b, a]: RGBA): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || a === 0) return;
    const i = (y * this.width + x) * 4;
    const d = this.data;
    if (a === 255) {
      d[i] = r;
      d[i + 1] = g;
      d[i + 2] = b;
      d[i + 3] = 255;
      return;
    }
    const t = a / 255;
    const da = d[i + 3]! / 255;
    const oa = t + da * (1 - t);
    if (oa === 0) return;
    d[i] = (r * t + d[i]! * da * (1 - t)) / oa;
    d[i + 1] = (g * t + d[i + 1]! * da * (1 - t)) / oa;
    d[i + 2] = (b * t + d[i + 2]! * da * (1 - t)) / oa;
    d[i + 3] = oa * 255;
  }

  fillRect(x: number, y: number, w: number, h: number, c: RGBA): void {
    for (let yy = Math.max(0, y); yy < Math.min(this.height, y + h); yy++)
      for (let xx = Math.max(0, x); xx < Math.min(this.width, x + w); xx++) this.blend(xx, yy, c);
  }

  /** Copies another image at (x, y) with alpha blending. */
  draw(src: Image, x: number, y: number): void {
    for (let yy = 0; yy < src.height; yy++)
      for (let xx = 0; xx < src.width; xx++) {
        const i = (yy * src.width + xx) * 4;
        const s = src.data;
        if (s[i + 3]) this.blend(x + xx, y + yy, [s[i]!, s[i + 1]!, s[i + 2]!, s[i + 3]!]);
      }
  }

  text(str: string, x: number, y: number, color: RGBA, scale = 1): void {
    let cx = x;
    for (const ch of str) {
      const g = glyph(ch);
      if (g) {
        for (let gy = 0; gy < GLYPH_H; gy++)
          for (let gx = 0; gx < g[gy]!.length; gx++)
            if (g[gy]![gx]) this.fillRect(cx + gx * scale, y + gy * scale, scale, scale, color);
      }
      cx += 6 * scale;
    }
  }

  /** A rectangular sub-image (copy). */
  crop(x: number, y: number, w: number, h: number): Image {
    const out = new Image(w, h);
    for (let yy = 0; yy < h; yy++) {
      const start = ((y + yy) * this.width + x) * 4;
      out.data.set(this.data.subarray(start, start + w * 4), yy * w * 4);
    }
    return out;
  }
}

/** Rewrites a PNG with its image data inflated tolerantly and re-deflated as a single clean IDAT. */
export function repackPng(buf: Buffer): Buffer {
  const chunks: { type: string; data: Buffer }[] = [];
  let p = 8;
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString("latin1", p + 4, p + 8);
    chunks.push({ type, data: buf.subarray(p + 8, p + 8 + len) });
    p += 12 + len;
    if (type === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)), { finishFlush: 2 /* Z_SYNC_FLUSH */ });
  const out: Buffer[] = [buf.subarray(0, 8)];
  const write = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    out.push(head, data, crc);
  };
  let wroteData = false;
  for (const c of chunks) {
    if (c.type === "IDAT") {
      if (!wroteData) write("IDAT", deflateSync(raw));
      wroteData = true;
    } else if (c.type === "IHDR" || c.type === "PLTE" || c.type === "tRNS" || c.type === "IEND") write(c.type, c.data);
  }
  return Buffer.concat(out);
}
