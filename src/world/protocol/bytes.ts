/**
 * Byte-level primitives of the bridge wire format (docs/design/13-live-world.md, *Wire format*,
 * *Primitives*): unsigned LEB128 varints, standard UTF-8 strings for bodies, Java modified UTF-8
 * for NBT strings, big-endian fixed-width numbers.
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Growable big-endian byte writer. */
export class ByteWriter {
  private buf: Uint8Array;
  private view: DataView;
  length = 0;

  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(n: number): void {
    const need = this.length + n;
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.length++] = v & 0xff;
  }

  i8(v: number): void {
    this.u8(v);
  }

  i16(v: number): void {
    this.ensure(2);
    this.view.setInt16(this.length, v);
    this.length += 2;
  }

  u16(v: number): void {
    this.ensure(2);
    this.view.setUint16(this.length, v);
    this.length += 2;
  }

  i32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.length, v);
    this.length += 4;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.length, v);
    this.length += 4;
  }

  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.length, v);
    this.length += 4;
  }

  f64(v: number): void {
    this.ensure(8);
    this.view.setFloat64(this.length, v);
    this.length += 8;
  }

  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.length);
    this.length += b.length;
  }

  /** Unsigned LEB128, 0 ≤ v ≤ 2^53 − 1. */
  varint(v: number): void {
    if (v < 0x80 && v >= 0) {
      this.ensure(1);
      this.buf[this.length++] = v;
      return;
    }
    if (!Number.isInteger(v) || v < 0 || v > MAX_SAFE) throw new Error(`varint out of range: ${v}`);
    this.ensure(8);
    while (v >= 0x80) {
      this.buf[this.length++] = (v % 0x80) | 0x80;
      v = Math.floor(v / 0x80);
    }
    this.buf[this.length++] = v;
  }

  /** Body string: varint byte length, then standard UTF-8. */
  str(s: string): void {
    const b = utf8.encode(s);
    this.varint(b.length);
    this.bytes(b);
  }

  /** NBT string: u16 byte length, then Java modified UTF-8 (`DataOutput.writeUTF`). */
  mutf8(s: string): void {
    const b = encodeModifiedUtf8(s);
    if (b.length > 0xffff) throw new Error(`NBT string too long (${b.length} bytes, max 65535)`);
    this.u16(b.length);
    this.bytes(b);
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.length);
  }
}

/** Big-endian byte reader over one buffer; every read is bounds-checked. */
export class ByteReader {
  private readonly view: DataView;
  pos: number;

  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.pos = start;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  private need(n: number): number {
    const p = this.pos;
    if (p + n > this.end) throw new Error(`truncated: needed ${n} bytes at offset ${p}, ${this.end - p} left`);
    this.pos = p + n;
    return p;
  }

  u8(): number {
    return this.buf[this.need(1)]!;
  }

  i8(): number {
    return this.view.getInt8(this.need(1));
  }

  i16(): number {
    return this.view.getInt16(this.need(2));
  }

  u16(): number {
    return this.view.getUint16(this.need(2));
  }

  i32(): number {
    return this.view.getInt32(this.need(4));
  }

  u32(): number {
    return this.view.getUint32(this.need(4));
  }

  f32(): number {
    return this.view.getFloat32(this.need(4));
  }

  f64(): number {
    return this.view.getFloat64(this.need(8));
  }

  bytes(n: number): Uint8Array {
    const p = this.need(n);
    return this.buf.subarray(p, p + n);
  }

  varint(): number {
    const b0 = this.buf[this.pos];
    if (b0 !== undefined && b0 < 0x80 && this.pos < this.end) {
      this.pos++;
      return b0;
    }
    let result = 0;
    let mul = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      result += (b & 0x7f) * mul;
      if (b < 0x80) {
        if (i > 0 && b === 0) throw new Error(`overlong varint at offset ${this.pos - 1}`);
        if (result > MAX_SAFE) throw new Error(`varint exceeds 2^53 − 1 at offset ${this.pos}`);
        return result;
      }
      mul *= 0x80;
    }
    throw new Error(`varint longer than 8 bytes at offset ${this.pos}`);
  }

  str(): string {
    const n = this.varint();
    return utf8Decoder.decode(this.bytes(n));
  }

  mutf8(): string {
    const n = this.u16();
    return decodeModifiedUtf8(this.bytes(n));
  }
}

/** Java modified UTF-8: U+0000 as C0 80, supplementary characters as two 3-byte surrogates. */
export function encodeModifiedUtf8(s: string): Uint8Array {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c >= 1 && c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  const out = new Uint8Array(n);
  let p = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 1 && c < 0x80) out[p++] = c;
    else if (c < 0x800) {
      out[p++] = 0xc0 | (c >> 6);
      out[p++] = 0x80 | (c & 0x3f);
    } else {
      out[p++] = 0xe0 | (c >> 12);
      out[p++] = 0x80 | ((c >> 6) & 0x3f);
      out[p++] = 0x80 | (c & 0x3f);
    }
  }
  return out;
}

export function decodeModifiedUtf8(b: Uint8Array): string {
  let ascii = true;
  for (let i = 0; i < b.length; i++) if (b[i]! >= 0x80 || b[i] === 0) ascii = false;
  if (ascii) return latin(b);
  const codes: number[] = [];
  for (let i = 0; i < b.length; ) {
    const x = b[i]!;
    if (x < 0x80 && x !== 0) {
      codes.push(x);
      i++;
    } else if ((x & 0xe0) === 0xc0 && i + 1 < b.length && (b[i + 1]! & 0xc0) === 0x80) {
      codes.push(((x & 0x1f) << 6) | (b[i + 1]! & 0x3f));
      i += 2;
    } else if ((x & 0xf0) === 0xe0 && i + 2 < b.length && (b[i + 1]! & 0xc0) === 0x80 && (b[i + 2]! & 0xc0) === 0x80) {
      codes.push(((x & 0x0f) << 12) | ((b[i + 1]! & 0x3f) << 6) | (b[i + 2]! & 0x3f));
      i += 3;
    } else throw new Error(`bad modified UTF-8 byte 0x${x.toString(16)} at ${i}`);
  }
  let s = "";
  for (let i = 0; i < codes.length; i += 4096) s += String.fromCharCode(...codes.slice(i, i + 4096));
  return s;
}

function latin(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode(...b.subarray(i, i + 4096));
  return s;
}

/** 16 lowercase hex digits ↔ 8 bytes. */
export function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2) throw new Error(`bad hex "${hex}"`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
