import type { Compound } from "prismarine-nbt";
import { ByteReader, ByteWriter } from "./bytes.js";

/**
 * Binary NBT for the bridge (docs/design/13-live-world.md, *Wire format*, *NBT*): big-endian,
 * uncompressed, root compound with an empty name (as `NbtIo.write` writes it), strings in Java
 * modified UTF-8, compound keys written in sorted order (UTF-16 code unit order, as Java's
 * `String.compareTo`), empty lists with element type End. Values use prismarine-nbt's tagged shape,
 * the document's own representation of block-entity NBT (`04`).
 */

export type Tag = NonNullable<Compound["value"][string]>;

const IDS: Record<string, number> = { end: 0, byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6, byteArray: 7, string: 8, list: 9, compound: 10, intArray: 11, longArray: 12 };
const NAMES = Object.fromEntries(Object.entries(IDS).map(([k, v]) => [v, k])) as Record<number, string>;
const MAX_DEPTH = 512;

/** Compound keys in wire order (Java `String.compareTo`, which JS `<` matches). */
export function sortedKeys(value: Compound["value"]): string[] {
  return Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Encodes a compound as a named root with an empty name. */
export function encodeNbt(c: Compound): Uint8Array {
  const w = new ByteWriter(256);
  writeNbt(w, c);
  return w.finish();
}

export function writeNbt(w: ByteWriter, c: Compound): void {
  w.u8(10);
  w.u16(0);
  writePayload(w, "compound", c.value, 0);
}

function writePayload(w: ByteWriter, type: string, value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) throw new Error(`NBT nested deeper than ${MAX_DEPTH}`);
  switch (type) {
    case "byte":
      return w.i8(value as number);
    case "short":
      return w.i16(value as number);
    case "int":
      return w.i32(value as number);
    case "long": {
      const [hi, lo] = value as [number, number];
      w.i32(hi);
      return w.i32(lo);
    }
    case "float":
      return w.f32(value as number);
    case "double":
      return w.f64(value as number);
    case "string":
      return w.mutf8(value as string);
    case "byteArray": {
      const a = value as number[];
      w.i32(a.length);
      for (const v of a) w.i8(v);
      return;
    }
    case "intArray": {
      const a = value as number[];
      w.i32(a.length);
      for (const v of a) w.i32(v);
      return;
    }
    case "longArray": {
      const a = value as [number, number][];
      w.i32(a.length);
      for (const [hi, lo] of a) {
        w.i32(hi);
        w.i32(lo);
      }
      return;
    }
    case "list": {
      const l = value as { type: string; value: unknown[] };
      if (l.value.length === 0) {
        w.u8(0);
        return w.i32(0);
      }
      const id = IDS[l.type];
      if (id === undefined || id === 0) throw new Error(`NBT list of unsupported type "${l.type}"`);
      w.u8(id);
      w.i32(l.value.length);
      for (const v of l.value) writePayload(w, l.type, v, depth + 1);
      return;
    }
    case "compound": {
      const c = value as Compound["value"];
      for (const k of sortedKeys(c)) {
        const t = c[k]!;
        const id = IDS[t.type];
        if (id === undefined || id === 0) throw new Error(`NBT tag "${k}" has unsupported type "${t.type}"`);
        w.u8(id);
        w.mutf8(k);
        writePayload(w, t.type, t.value, depth + 1);
      }
      w.u8(0);
      return;
    }
    default:
      throw new Error(`unsupported NBT type "${type}"`);
  }
}

/** Decodes a named root compound (any name); keys keep their wire order. */
export function decodeNbt(bytes: Uint8Array): Compound {
  const r = new ByteReader(bytes);
  const c = readNbt(r);
  if (r.remaining) throw new Error(`${r.remaining} trailing bytes after NBT`);
  return c;
}

export function readNbt(r: ByteReader): Compound {
  const id = r.u8();
  if (id !== 10) throw new Error(`NBT root must be a compound (tag 10), got tag ${id}`);
  r.mutf8();
  return { type: "compound", value: readPayload(r, "compound", 0) as Compound["value"] };
}

function readPayload(r: ByteReader, type: string, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new Error(`NBT nested deeper than ${MAX_DEPTH}`);
  switch (type) {
    case "byte":
      return r.i8();
    case "short":
      return r.i16();
    case "int":
      return r.i32();
    case "long":
      return [r.i32(), r.i32()];
    case "float":
      return r.f32();
    case "double":
      return r.f64();
    case "string":
      return r.mutf8();
    case "byteArray":
      return Array.from({ length: count(r, 1) }, () => r.i8());
    case "intArray":
      return Array.from({ length: count(r, 4) }, () => r.i32());
    case "longArray":
      return Array.from({ length: count(r, 8) }, () => [r.i32(), r.i32()]);
    case "list": {
      const id = r.u8();
      const n = r.i32();
      if (n < 0) throw new Error(`negative NBT list length ${n}`);
      const t = NAMES[id];
      if (t === undefined) throw new Error(`unknown NBT tag ${id}`);
      if (n === 0) return { type: "end", value: [] };
      if (id === 0) throw new Error("non-empty NBT list of End tags");
      const value: unknown[] = [];
      for (let i = 0; i < n; i++) value.push(readPayload(r, t, depth + 1));
      return { type: t, value };
    }
    case "compound": {
      const out: Compound["value"] = {};
      for (;;) {
        const id = r.u8();
        if (id === 0) return out;
        const t = NAMES[id];
        if (t === undefined) throw new Error(`unknown NBT tag ${id}`);
        const k = r.mutf8();
        out[k] = { type: t, value: readPayload(r, t, depth + 1) } as Tag;
      }
    }
    default:
      throw new Error(`unsupported NBT type "${type}"`);
  }
}

function count(r: ByteReader, size: number): number {
  const n = r.i32();
  if (n < 0 || n * size > r.remaining) throw new Error(`bad NBT array length ${n}`);
  return n;
}
