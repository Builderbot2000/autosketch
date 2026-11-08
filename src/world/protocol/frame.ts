import { ProtocolError } from "./codec.js";
import { MAX_FRAME } from "./messages.js";

/**
 * Streaming frame reader (docs/design/13-live-world.md, *Wire format*, *Framing*): feed it socket
 * chunks in order and it returns each complete frame payload (the bytes after the 4-byte length
 * prefix). A length below 4 or above `MAX_FRAME` is a protocol error; the connection should close.
 */
export class FrameReader {
  private chunks: Uint8Array[] = [];
  private buffered = 0;

  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const out: Uint8Array[] = [];
    for (;;) {
      if (this.buffered < 4) return out;
      const head = this.peek(4);
      const len = ((head[0]! << 24) | (head[1]! << 16) | (head[2]! << 8) | head[3]!) >>> 0;
      if (len < 4 || len > MAX_FRAME) throw new ProtocolError(`frame length ${len} outside 4…${MAX_FRAME}`);
      if (this.buffered < 4 + len) return out;
      out.push(this.take(4 + len).subarray(4));
    }
  }

  /** Bytes received but not yet part of a complete frame. */
  get pending(): number {
    return this.buffered;
  }

  private peek(n: number): Uint8Array {
    const first = this.chunks[0]!;
    if (first.length >= n) return first.subarray(0, n);
    const out = new Uint8Array(n);
    let p = 0;
    for (const c of this.chunks) {
      const k = Math.min(c.length, n - p);
      out.set(c.subarray(0, k), p);
      p += k;
      if (p === n) break;
    }
    return out;
  }

  private take(n: number): Uint8Array {
    const first = this.chunks[0]!;
    let out: Uint8Array;
    if (first.length >= n) {
      out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
    } else {
      out = new Uint8Array(n);
      let p = 0;
      while (p < n) {
        const c = this.chunks[0]!;
        const k = Math.min(c.length, n - p);
        out.set(c.subarray(0, k), p);
        p += k;
        if (k === c.length) this.chunks.shift();
        else this.chunks[0] = c.subarray(k);
      }
    }
    this.buffered -= n;
    return out;
  }
}
