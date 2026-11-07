import { gunzipSync, gzipSync } from "node:zlib";
import nbt, { type Compound, type NBT } from "prismarine-nbt";

/** Small helpers over prismarine-nbt's tagged values, shared by the format codecs (docs/design/08-formats.md). */

export type Tag = Compound["value"][string];

export const T = {
  int: (value: number) => ({ type: "int" as const, value }),
  short: (value: number) => ({ type: "short" as const, value }),
  byte: (value: number) => ({ type: "byte" as const, value }),
  str: (value: string) => ({ type: "string" as const, value }),
  ints: (value: number[]) => ({ type: "intArray" as const, value }),
  bytes: (value: number[]) => ({ type: "byteArray" as const, value }),
  /** 64-bit long as prismarine-nbt's [high, low] pair. */
  long: (n: number) => ({ type: "long" as const, value: [Math.floor(n / 2 ** 32), n | 0] as [number, number] }),
  compound: (value: Compound["value"]): Compound => ({ type: "compound", value }),
  intList: (value: number[]) => ({ type: "list" as const, value: { type: "int" as const, value } }),
  doubleList: (value: number[]) => ({ type: "list" as const, value: { type: "double" as const, value } }),
  strList: (value: string[]) => ({ type: "list" as const, value: { type: "string" as const, value } }),
  compoundList: (value: Compound[]) => ({ type: "list" as const, value: { type: "compound" as const, value: value.map((c) => c.value) } }),
};

export const num = (t: Tag | undefined): number | undefined => (t && typeof t.value === "number" ? t.value : undefined);
export const text = (t: Tag | undefined): string | undefined => (t && t.type === "string" ? t.value : undefined);
export const compound = (t: Tag | undefined): Compound | undefined => (t && t.type === "compound" ? (t as Compound) : undefined);

/** Numbers from an int array, byte array or numeric list. */
export function numbers(t: Tag | undefined): number[] {
  if (!t) return [];
  if (t.type === "intArray" || t.type === "byteArray") return t.value as number[];
  if (t.type === "list" && ["int", "short", "byte", "double", "float"].includes(t.value.type)) return t.value.value as number[];
  return [];
}

/** Compounds of a list tag (as tagged compounds). */
export function compounds(t: Tag | undefined): Compound[] {
  if (!t || t.type !== "list" || t.value.type !== "compound") return [];
  return (t.value.value as Compound["value"][]).map((value) => ({ type: "compound", value }));
}

export function isGzip(buf: Buffer): boolean {
  return buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** Parses big-endian NBT, gzipped or not. */
export function readNbt(buf: Buffer): NBT {
  return nbt.parseUncompressed(isGzip(buf) ? gunzipSync(buf) : buf);
}

export function writeGzipNbt(root: NBT): Buffer {
  return gzipSync(nbt.writeUncompressed(root));
}

/** Copy of a compound without some keys. */
export function without(c: Compound, ...keys: string[]): Compound {
  const value: Compound["value"] = {};
  for (const [k, v] of Object.entries(c.value)) if (!keys.includes(k)) value[k] = v;
  return { type: "compound", value };
}

/** Copy of a compound with some keys set. */
export function withKeys(c: Compound | undefined, set: Compound["value"]): Compound {
  return { type: "compound", value: { ...(c?.value ?? {}), ...set } };
}
