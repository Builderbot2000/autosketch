import type { Compound } from "prismarine-nbt";
import { sortedKeys, type Tag } from "./nbt.js";

/**
 * SNBT, Minecraft's text form of NBT, as the golden-vector sidecars write block-entity NBT
 * (docs/design/13-live-world.md, *Wire format*, *Golden vectors*). Java tests parse it with the
 * game's `TagParser`. Printing sorts keys; NaN and infinities are not representable.
 */

export function toSnbt(c: Compound): string {
  return print("compound", c.value);
}

function print(type: string, v: unknown): string {
  switch (type) {
    case "byte":
      return `${v as number}b`;
    case "short":
      return `${v as number}s`;
    case "int":
      return `${v as number}`;
    case "long":
      return `${longToBig(v as [number, number])}L`;
    case "float":
      return `${floatText(v as number)}f`;
    case "double":
      return `${doubleText(v as number)}d`;
    case "string":
      return quote(v as string);
    case "byteArray":
      return `[B;${(v as number[]).map((x) => `${x}b`).join(",")}]`;
    case "intArray":
      return `[I;${(v as number[]).join(",")}]`;
    case "longArray":
      return `[L;${(v as [number, number][]).map((x) => `${longToBig(x)}L`).join(",")}]`;
    case "list": {
      const l = v as { type: string; value: unknown[] };
      return `[${l.value.map((x) => print(l.type, x)).join(",")}]`;
    }
    case "compound": {
      const c = v as Compound["value"];
      return `{${sortedKeys(c)
        .map((k) => `${/^[A-Za-z0-9._+-]+$/.test(k) ? k : quote(k)}:${print(c[k]!.type, c[k]!.value)}`)
        .join(",")}}`;
    }
  }
  throw new Error(`unsupported NBT type "${type}"`);
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function finite(v: number): void {
  if (!Number.isFinite(v)) throw new Error(`SNBT can't represent ${v}`);
}

function floatText(v: number): string {
  finite(v);
  if (Object.is(v, -0)) return "-0.0";
  for (let p = 1; p <= 9; p++) {
    const t = String(Number(v.toPrecision(p)));
    if (Math.fround(Number(t)) === v) return t;
  }
  return String(v);
}

function doubleText(v: number): string {
  finite(v);
  return Object.is(v, -0) ? "-0.0" : String(v);
}

export function longToBig([hi, lo]: [number, number]): bigint {
  return (BigInt(hi | 0) << 32n) | BigInt(lo >>> 0);
}

export function bigToLong(b: bigint): [number, number] {
  const u = BigInt.asUintN(64, b);
  return [Number(BigInt.asIntN(32, u >> 32n)), Number(BigInt.asIntN(32, u & 0xffffffffn))];
}

export function parseSnbt(text: string): Compound {
  const p = new Parser(text);
  const t = p.value();
  p.ws();
  if (p.i !== text.length) p.fail("trailing characters");
  if (t.type !== "compound") p.fail("root must be a compound");
  return t as Compound;
}

class Parser {
  i = 0;
  constructor(readonly s: string) {}

  fail(msg: string): never {
    throw new Error(`SNBT: ${msg} at ${this.i} in ${JSON.stringify(this.s.slice(0, 80))}`);
  }

  ws(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  eat(c: string): boolean {
    this.ws();
    if (this.s[this.i] === c) {
      this.i++;
      return true;
    }
    return false;
  }

  expect(c: string): void {
    if (!this.eat(c)) this.fail(`expected "${c}"`);
  }

  value(): Tag {
    this.ws();
    const c = this.s[this.i];
    if (c === "{") return this.compound();
    if (c === "[") return this.list();
    if (c === '"' || c === "'") return { type: "string", value: this.quoted() };
    return this.scalar(this.bare());
  }

  compound(): Tag {
    this.expect("{");
    const value: Compound["value"] = {};
    if (this.eat("}")) return { type: "compound", value };
    do {
      this.ws();
      const c = this.s[this.i];
      const k = c === '"' || c === "'" ? this.quoted() : this.bare();
      if (!k) this.fail("expected a key");
      this.expect(":");
      value[k] = this.value();
    } while (this.eat(","));
    this.expect("}");
    return { type: "compound", value };
  }

  list(): Tag {
    this.expect("[");
    const arr = /^([BIL]);/.exec(this.s.slice(this.i, this.i + 2));
    if (arr) {
      this.i += 2;
      const kind = arr[1]!;
      const items: Tag[] = [];
      if (!this.eat("]")) {
        do items.push(this.value());
        while (this.eat(","));
        this.expect("]");
      }
      const want = kind === "B" ? "byte" : kind === "I" ? "int" : "long";
      for (const t of items) if (t.type !== want) this.fail(`[${kind};] array holds a ${t.type}`);
      const type = kind === "B" ? "byteArray" : kind === "I" ? "intArray" : "longArray";
      return { type, value: items.map((t) => t.value) } as Tag;
    }
    if (this.eat("]")) return { type: "list", value: { type: "end", value: [] } } as unknown as Tag;
    const items: Tag[] = [];
    do items.push(this.value());
    while (this.eat(","));
    this.expect("]");
    const type = items[0]!.type;
    if (items.some((t) => t.type !== type)) this.fail("list elements of different types");
    return { type: "list", value: { type, value: items.map((t) => t.value) } } as Tag;
  }

  quoted(): string {
    const q = this.s[this.i++]!;
    let out = "";
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) this.fail("unterminated string");
      if (c === q) return out;
      if (c === "\\") {
        const e = this.s[this.i++];
        if (e !== "\\" && e !== '"' && e !== "'") this.fail(`bad escape \\${e}`);
        out += e;
      } else out += c;
    }
  }

  bare(): string {
    this.ws();
    const start = this.i;
    while (this.i < this.s.length && /[A-Za-z0-9._+-]/.test(this.s[this.i]!)) this.i++;
    return this.s.slice(start, this.i);
  }

  scalar(t: string): Tag {
    if (!t) this.fail("expected a value");
    const m = /^([-+]?(?:[0-9]+\.?|[0-9]*\.[0-9]+)(?:e[-+]?[0-9]+)?)([bslfd]?)$/i.exec(t);
    if (m) {
      const num = m[1]!;
      const suf = m[2]!.toLowerCase();
      const integral = /^[-+]?[0-9]+$/.test(num);
      if (suf === "f") return { type: "float", value: Math.fround(Number(num)) };
      if (suf === "d") return { type: "double", value: Number(num) };
      if (integral && suf === "b") return { type: "byte", value: range(Number(num), 8, this) };
      if (integral && suf === "s") return { type: "short", value: range(Number(num), 16, this) };
      if (integral && suf === "l") return { type: "long", value: bigToLong(BigInt(num.replace("+", ""))) };
      if (integral && suf === "") return { type: "int", value: range(Number(num), 32, this) };
      if (!integral && suf === "") return { type: "double", value: Number(num) };
    }
    if (t === "true") return { type: "byte", value: 1 };
    if (t === "false") return { type: "byte", value: 0 };
    return { type: "string", value: t };
  }
}

function range(v: number, bits: number, p: Parser): number {
  const lim = 2 ** (bits - 1);
  if (v < -lim || v >= lim) p.fail(`${v} out of range for a ${bits}-bit integer`);
  return v;
}
