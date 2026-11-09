import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Compound } from "prismarine-nbt";
import { describe, expect, it } from "vitest";
import { ByteReader, ByteWriter } from "../../../src/world/protocol/bytes.js";
import { decodeFrame, decodeMessage, encodeMessage, ProtocolError } from "../../../src/world/protocol/codec.js";
import { FrameReader } from "../../../src/world/protocol/frame.js";
import { canonicalNbt, DEFAULT_VOLATILE, mergeVolatile, nbtHash, sectionHash, sectionHashes, sectionsOf } from "../../../src/world/protocol/hash.js";
import type { Message, PatchBlock, Sender, WorldBlock } from "../../../src/world/protocol/messages.js";
import { decodeNbt, encodeNbt } from "../../../src/world/protocol/nbt.js";
import { formatPairing, parsePairing, readPairing, writePairing } from "../../../src/world/protocol/pairing.js";
import { parseSnbt, toSnbt } from "../../../src/world/protocol/snbt.js";
import { isCanonicalForm } from "../../../src/world/protocol/state.js";
import { messageOf, sidecarOf, type Sidecar } from "../../data/world-protocol/sidecar.js";

const DIR = join(import.meta.dirname, "../../data/world-protocol");
const vectors = readdirSync(DIR)
  .filter((f) => f.endsWith(".bin"))
  .map((f) => f.slice(0, -4));
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function largePatchBlocks(): PatchBlock[] {
  const pal = ["minecraft:oak_planks", "minecraft:stone_bricks", "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]", "minecraft:glass"];
  const blocks: PatchBlock[] = [];
  for (let dy = 0; dy < 16; dy++)
    for (let dz = 0; dz < 40; dz++)
      for (let dx = 0; dx < 40; dx++) {
        if ((dx + 3 * dy + 7 * dz) % 5 === 0) continue;
        blocks.push({ pos: [100 + dx, 64 + dy, -200 + dz], expected: dy < 8 ? "minecraft:air" : "minecraft:stone", state: pal[(dx + dy + dz) % 4]! });
      }
  return blocks;
}

describe("golden vectors", () => {
  it("has a vector for every message kind", () => {
    const kinds = new Set(vectors.map((v) => (JSON.parse(readFileSync(join(DIR, `${v}.json`), "utf8")) as Sidecar).header.type));
    expect([...kinds].sort()).toEqual(["chat", "dirty", "error", "hashes", "hashes.result", "hello", "notice", "patch", "patch.ack", "prompt", "prompt.result", "snapshot", "snapshot.result", "volumes", "volumes.extend"]);
  });

  for (const name of vectors) {
    it(`${name}: decodes to its sidecar and re-encodes byte for byte`, () => {
      const bin = new Uint8Array(readFileSync(join(DIR, `${name}.bin`)));
      const side = JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")) as Sidecar;
      const decoded = decodeFrame(bin, side.sender);
      if (side.generated) {
        expect(decoded.type).toBe("patch");
        const m = { ...(messageOf({ ...side, body: { blocks: [] } }) as object), blocks: largePatchBlocks() } as Message;
        expect(hex(encodeMessage(m))).toBe(hex(bin));
        expect((decoded as { blocks: unknown[] }).blocks.length).toBe(side.header.count);
        return;
      }
      const again = sidecarOf(side.description, side.sender, decoded, bin);
      expect(again).toEqual({ ...side, generated: undefined, ...(side.body ? {} : { body: undefined }) });
      expect(hex(encodeMessage(messageOf(side)))).toBe(hex(bin));
      expect(hex(encodeMessage(decoded))).toBe(hex(bin));
    });
  }

  it("patch-one matches the hand-derived bytes in the spec's worked example", () => {
    const bin = readFileSync(join(DIR, "patch-one.bin"));
    const header = '{"type":"patch","id":21,"link":3,"dimension":"minecraft:overworld","origin":[100,64,-200],"size":[1,1,1],"count":1}';
    const body = "02" + "0d" + Buffer.from("minecraft:air").toString("hex") + "0f" + Buffer.from("minecraft:stone").toString("hex") + "01" + "00" + "00" + "01" + "00" + "00";
    const payload = "00000073" + Buffer.from(header).toString("hex") + body;
    expect(header.length).toBe(0x73);
    expect(bin.toString("hex")).toBe((payload.length / 2).toString(16).padStart(8, "0") + payload);
  });
});

describe("hash vectors", () => {
  const nbt = JSON.parse(readFileSync(join(DIR, "hash-nbt.json"), "utf8")) as { cases: { name: string; snbt: string; volatile: Record<string, string[] | "state_only">; canonical: string | null; hash: string | null }[] };
  for (const c of nbt.cases)
    it(`NBT ${c.name}`, () => {
      const v = parseSnbt(c.snbt);
      const canon = canonicalNbt(v, c.volatile);
      expect(canon ? hex(canon) : null).toBe(c.canonical);
      expect(nbtHash(v, c.volatile) ?? null).toBe(c.hash);
      if (canon) expect(createHash("sha256").update(canon).digest("hex").slice(0, 16)).toBe(c.hash);
    });

  it("the empty compound hashes as SHA-256 of 0a 00 00 00", () => {
    expect(nbtHash({ type: "compound", value: {} }, {})).toBe(createHash("sha256").update(Buffer.from("0a000000", "hex")).digest("hex").slice(0, 16));
  });

  it("volatile-only changes keep the hash; contents changes don't", () => {
    const a = parseSnbt('{id:"minecraft:hopper",TransferCooldown:8,Items:[]}');
    const b = parseSnbt('{id:"minecraft:hopper",TransferCooldown:0,Items:[]}');
    const c = parseSnbt('{id:"minecraft:hopper",TransferCooldown:0,Items:[{Slot:0b,id:"minecraft:stone",count:1}]}');
    expect(nbtHash(a, DEFAULT_VOLATILE)).toBe(nbtHash(b, DEFAULT_VOLATILE));
    expect(nbtHash(b, DEFAULT_VOLATILE)).not.toBe(nbtHash(c, DEFAULT_VOLATILE));
    expect(a.value.TransferCooldown).toBeDefined();
  });

  const sections = JSON.parse(readFileSync(join(DIR, "hash-sections.json"), "utf8")) as {
    cases: { name: string; section: [number, number, number]; boxes: { min: [number, number, number]; max: [number, number, number] }[]; volatile: Record<string, string[] | "state_only">; fill: string; blocks: { pos: number[]; state: string; nbt?: string }[]; hash: string }[];
  };
  for (const c of sections.cases)
    it(`section ${c.name}`, () => {
      const m = new Map(c.blocks.map((b) => [b.pos.join(","), { state: b.state, nbt: b.nbt ? parseSnbt(b.nbt) : undefined }]));
      expect(sectionHash(c.section, c.boxes, (x, y, z) => m.get(`${x},${y},${z}`) ?? { state: c.fill }, c.volatile)).toBe(c.hash);
    });

  it("sections are listed ascending by y, z, x, and only when a box touches them", () => {
    expect(sectionsOf([{ min: [-1, 15, 0], max: [16, 16, 0] }])).toEqual([
      [-1, 0, 0], [0, 0, 0], [1, 0, 0],
      [-1, 1, 0], [0, 1, 0], [1, 1, 0],
    ]);
    const hs = sectionHashes([{ min: [0, 0, 0], max: [0, 0, 0] }], () => ({ state: "minecraft:air" }), {});
    expect(hs.map((h) => h.section)).toEqual([[0, 0, 0]]);
  });

  it("merges volatile lists, state_only winning", () => {
    expect(mergeVolatile({ a: ["x"], b: ["y"] }, { a: ["z", "x"], b: "state_only" })).toEqual({ a: ["x", "z"], b: "state_only" });
  });
});

// ── round trips ──────────────────────────────────────────────────────────────────────────────────

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomNbt(r: () => number, depth = 0): Compound {
  const value: Compound["value"] = { id: { type: "string", value: "test:thing" } };
  const n = 1 + Math.floor(r() * 5);
  for (let i = 0; i < n; i++) {
    const k = `k${Math.floor(r() * 1000)}${r() < 0.2 ? "é😀" : ""}`;
    const pick = Math.floor(r() * (depth > 2 ? 8 : 11));
    const int = () => Math.floor(r() * 2 ** 32) - 2 ** 31;
    const tags: (() => Compound["value"][string])[] = [
      () => ({ type: "byte", value: Math.floor(r() * 256) - 128 }),
      () => ({ type: "short", value: Math.floor(r() * 65536) - 32768 }),
      () => ({ type: "int", value: int() }),
      () => ({ type: "long", value: [int(), int()] }),
      () => ({ type: "float", value: Math.fround((r() - 0.5) * 1000) }),
      () => ({ type: "double", value: (r() - 0.5) * 1e6 }),
      () => ({ type: "string", value: r() < 0.5 ? "plain" : "\u0000nul and \u{1F600}" }),
      () => ({ type: "intArray", value: [int(), int()] }),
      () => ({ type: "compound", value: randomNbt(r, depth + 1).value }),
      () => ({ type: "list", value: { type: "compound", value: [randomNbt(r, depth + 1).value, randomNbt(r, depth + 1).value] } }),
      () => ({ type: "list", value: { type: "end", value: [] } } as never),
    ];
    value[k] = tags[pick]!();
  }
  return { type: "compound", value };
}

const STATES = ["minecraft:air", "minecraft:stone", "minecraft:oak_planks", "minecraft:chest[facing=north,type=single,waterlogged=false]", "mod:thing[a=1,b=2]"];

function randomPositions(r: () => number, n: number): [number, number, number][] {
  const seen = new Set<string>();
  const out: [number, number, number][] = [];
  const ox = Math.floor(r() * 2000) - 1000, oy = Math.floor(r() * 300) - 64, oz = Math.floor(r() * 2000) - 1000;
  while (out.length < n) {
    const p: [number, number, number] = [ox + Math.floor(r() * 50), oy + Math.floor(r() * 20), oz + Math.floor(r() * 50)];
    const k = p.join(",");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

function randomMessage(r: () => number): [Message, Sender] {
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)]!;
  const n = Math.floor(r() * 40);
  const block = (pos: [number, number, number]): WorldBlock => ({ pos, state: pick(STATES), ...(r() < 0.2 ? { nbt: randomNbt(r) } : {}) });
  switch (Math.floor(r() * 4)) {
    case 0:
      return [
        {
          type: "patch",
          id: 1 + Math.floor(r() * 1e6),
          link: Math.floor(r() * 10),
          dimension: "minecraft:the_nether",
          ...(r() < 0.3 ? { force: true } : {}),
          blocks: randomPositions(r, n).map((pos) => ({ pos, expected: pick(STATES), state: pick(STATES), ...(r() < 0.2 ? { expectedNbtHash: Math.floor(r() * 2 ** 32).toString(16).padStart(16, "0") } : {}), ...(r() < 0.2 ? { nbt: randomNbt(r) } : {}) })),
        },
        "mcp",
      ];
    case 1: {
      const ps = randomPositions(r, n * 3);
      const skipped = ps.slice(0, n).map(block);
      return [{ type: "patch.ack", id: 7, applied: n + 3, overwritten: 2, skipped, rejected: ps.slice(n, 2 * n).map((pos) => ({ pos, reason: pick(["unknown_state", "bad_nbt", "outside_volumes", "stale_link"] as const) })), normalized: ps.slice(2 * n).map((pos) => (r() < 0.5 ? { pos } : { pos, nbt: randomNbt(r) })) }, "mod"];
    }
    case 2:
      return [{ type: "dirty", everything: false, blocks: randomPositions(r, n).map(block) }, "mod"];
    default: {
      const box = (): { min: [number, number, number]; max: [number, number, number] } => {
        const min: [number, number, number] = [Math.floor(r() * 100) - 50, Math.floor(r() * 100) - 64, Math.floor(r() * 100) - 50];
        return { min, max: [min[0] + Math.floor(r() * 4), min[1] + Math.floor(r() * 4), min[2] + Math.floor(r() * 4)] };
      };
      const boxes = Array.from({ length: Math.floor(r() * 3) }, box);
      const palette = [...STATES];
      const regions = boxes.map((b) => {
        const vol = (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1);
        return { box: b, states: Uint32Array.from({ length: vol }, () => Math.floor(r() * palette.length)), blockEntities: r() < 0.7 ? [{ pos: b.max, nbt: randomNbt(r) }] : [] };
      });
      return [{ type: "snapshot.result", id: 3, dimension: "minecraft:overworld", palette, regions }, "mod"];
    }
  }
}

describe("codec round trips", () => {
  it("random messages re-encode byte for byte after a decode", () => {
    const r = rng(1234);
    for (let i = 0; i < 300; i++) {
      const [m, sender] = randomMessage(r);
      const a = encodeMessage(m);
      const decoded = decodeFrame(a, sender);
      expect(decoded.type).toBe(m.type);
      const b = encodeMessage(decoded);
      expect(hex(b)).toBe(hex(a));
    }
  });

  it("decoded patches hold exactly the input blocks, sorted by grid index", () => {
    const r = rng(99);
    const [m] = randomMessage(r);
    const blocks: PatchBlock[] = randomPositions(r, 200).map((pos, i) => ({ pos, expected: STATES[i % 5]!, state: STATES[(i + 1) % 5]!, ...(i % 7 === 0 ? { nbt: randomNbt(r) } : {}) }));
    const d = decodeFrame(encodeMessage({ type: "patch", id: 1, link: 0, dimension: "minecraft:overworld", blocks }), "mcp");
    expect(m).toBeDefined();
    const key = (b: PatchBlock) => b.pos.join(",");
    const want = new Map(blocks.map((b) => [key(b), b]));
    if (d.type !== "patch") throw new Error();
    expect(d.blocks.length).toBe(blocks.length);
    for (const b of d.blocks) {
      const w = want.get(key(b))!;
      expect(b.expected).toBe(w.expected);
      expect(b.state).toBe(w.state);
      expect(b.nbt ? toSnbt(b.nbt) : undefined).toBe(w.nbt ? toSnbt(w.nbt) : undefined);
    }
    const order = d.blocks.map((b) => (b.pos[1] * 100000 + b.pos[2]) * 100000 + b.pos[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("NBT round-trips through binary and SNBT, writing keys sorted", () => {
    const r = rng(5);
    for (let i = 0; i < 100; i++) {
      const c = randomNbt(r);
      const bin = encodeNbt(c);
      expect(hex(encodeNbt(decodeNbt(bin)))).toBe(hex(bin));
      expect(hex(encodeNbt(parseSnbt(toSnbt(c))))).toBe(hex(bin));
    }
    expect(hex(encodeNbt(parseSnbt('{b:1b,a:1b,B:1b}')))).toBe("0a0000" + "01000142" + "01" + "01000161" + "01" + "01000162" + "01" + "00");
  });
});

describe("codec errors", () => {
  const ok = encodeMessage({ type: "patch", id: 1, link: 0, dimension: "minecraft:overworld", blocks: [{ pos: [0, 0, 0], expected: "minecraft:air", state: "minecraft:stone" }] });

  it("rejects unknown types, wrong senders and bodies on JSON-only messages", () => {
    const frame = (header: object, body = new Uint8Array(0)) => {
      const h = new TextEncoder().encode(JSON.stringify(header));
      const out = new Uint8Array(4 + h.length + body.length);
      new DataView(out.buffer).setUint32(0, h.length);
      out.set(h, 4);
      out.set(body, 4 + h.length);
      return out;
    };
    expect(() => decodeMessage(frame({ type: "bogus" }), "mcp")).toThrow(ProtocolError);
    expect(() => decodeMessage(frame({ type: "volumes", link: 1, work: null }), "mcp")).toThrow(/unknown message type/);
    expect(() => decodeMessage(frame({ type: "notice", text: "x", player: null }, Uint8Array.of(1)), "mcp")).toThrow(/no body/);
    expect(() => decodeMessage(frame({ type: "notice", text: "x" }), "mcp")).toThrow(/player/);
    expect(() => decodeMessage(frame({ type: "hashes", id: 1, dimension: "d", boxes: [{ min: [1, 0, 0], max: [0, 0, 0] }] }), "mcp")).toThrow(/min must not exceed max/);
  });

  it("rejects a patch whose header count disagrees with its body", () => {
    const bad = Buffer.from(ok);
    bad[bad.indexOf('"count":1') + 8] = 0x32;
    expect(() => decodeFrame(bad, "mcp")).toThrow(/count/);
  });

  it("refuses to encode duplicate positions", () => {
    expect(() =>
      encodeMessage({
        type: "patch",
        id: 1,
        link: 0,
        dimension: "d",
        blocks: [
          { pos: [1, 2, 3], expected: "a:a", state: "a:b" },
          { pos: [1, 2, 3], expected: "a:a", state: "a:c" },
        ],
      }),
    ).toThrow(/twice/);
  });

  it("NBT readers refuse duplicate keys and End lists, accept typed empty lists, and writers refuse long strings", () => {
    const dup = Buffer.from("0a0000" + "0100016101" + "0100016102" + "00", "hex");
    expect(() => decodeNbt(dup)).toThrow(/twice/);
    const endList = Buffer.from("0a0000" + "0900016c" + "00" + "00000001" + "00", "hex");
    expect(() => decodeNbt(endList)).toThrow(/End/);
    const typedEmpty = Buffer.from("0a0000" + "0900016c" + "0a" + "00000000" + "00", "hex");
    expect(hex(encodeNbt(decodeNbt(typedEmpty)))).toBe("0a0000" + "0900016c" + "00" + "00000000" + "00");
    expect(() => encodeNbt({ type: "compound", value: { s: { type: "string", value: "é".repeat(32768) } } })).toThrow(/65536 bytes, max 65535/);
    expect(encodeNbt({ type: "compound", value: { s: { type: "string", value: "a".repeat(65535) } } }).length).toBe(3 + 3 + 1 + 2 + 65535 + 1);
  });

  it("varints are minimal and bounded", () => {
    const w = new ByteWriter();
    for (const v of [0, 1, 127, 128, 300, 2 ** 31, 2 ** 53 - 1]) w.varint(v);
    const r = new ByteReader(w.finish());
    for (const v of [0, 1, 127, 128, 300, 2 ** 31, 2 ** 53 - 1]) expect(r.varint()).toBe(v);
    expect(() => new ByteReader(Uint8Array.of(0x80, 0x00)).varint()).toThrow(/overlong/);
    expect(hex(Uint8Array.from((() => { const x = new ByteWriter(); x.varint(300); return x.finish(); })()))).toBe("ac02");
  });

  it("the frame reader reassembles frames split at any byte", () => {
    const frames = [ok, encodeMessage({ type: "notice", text: "hi", player: null }), ok];
    const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
    let p = 0;
    for (const f of frames) {
      all.set(f, p);
      p += f.length;
    }
    for (const step of [1, 3, 7, 50, all.length]) {
      const fr = new FrameReader();
      const got: Uint8Array[] = [];
      for (let i = 0; i < all.length; i += step) got.push(...fr.push(all.subarray(i, i + step)));
      expect(got.map((g) => decodeMessage(g, "mcp").type)).toEqual(["patch", "notice", "patch"]);
      expect(fr.pending).toBe(0);
    }
    expect(() => new FrameReader().push(Uint8Array.of(0x7f, 0xff, 0xff, 0xff))).toThrow(/frame length/);
  });
});

describe("block states and pairing", () => {
  it("checks the canonical form", () => {
    expect(isCanonicalForm("minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]")).toBe(true);
    expect(isCanonicalForm("minecraft:stone")).toBe(true);
    expect(isCanonicalForm("stone")).toBe(false);
    expect(isCanonicalForm("minecraft:oak_stairs[half=bottom,facing=east]")).toBe(false);
    expect(isCanonicalForm("minecraft:cave_air")).toBe(false);
    expect(isCanonicalForm("minecraft:oak_stairs[facing=east, half=bottom]")).toBe(false);
  });

  it("formats, parses and writes the pairing file", async () => {
    const p = { protocol: 1, host: "127.0.0.1", port: 52817, token: "ab".repeat(32), pid: 4242, started: "2026-11-08T10:15:30Z" };
    expect(parsePairing(formatPairing(p))).toEqual(p);
    expect(() => parsePairing('protocol = 1\nhost = "127.0.0.1"\nport = 5\ntoken = "short"\n')).toThrow(/token/);
    expect(parsePairing('# c\n\nprotocol = 1\nhost = "127.0.0.1"\nport = 5\ntoken = "' + "0".repeat(64) + '"\nfuture = "ignored"\n').port).toBe(5);
    const dir = await mkdtemp(join(tmpdir(), "as-pair-"));
    try {
      await writePairing(dir, p);
      expect(await readPairing(dir)).toEqual(p);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("performance", () => {
  it("encodes a one-million-block patch well under a second", () => {
    const states = ["minecraft:air", "minecraft:stone_bricks", "minecraft:oak_planks", "minecraft:glass", "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]"];
    const blocks: PatchBlock[] = [];
    for (let y = 0; y < 100; y++) for (let z = 0; z < 100; z++) for (let x = 0; x < 100; x++) blocks.push({ pos: [1000 + x, 64 + y, -500 + z], expected: states[0]!, state: states[1 + ((x + y + z) % 4)]! });
    blocks.reverse();
    const m: Message = { type: "patch", id: 1, link: 1, dimension: "minecraft:overworld", blocks };
    encodeMessage(m); // warm up
    const t0 = performance.now();
    const frame = encodeMessage(m);
    const ms = performance.now() - t0;
    const t1 = performance.now();
    const d = decodeFrame(frame, "mcp");
    const decodeMs = performance.now() - t1;
    process.stdout.write(`\n1,000,000-block patch: encode ${ms.toFixed(0)} ms, decode ${decodeMs.toFixed(0)} ms, ${frame.length.toLocaleString("en-US")} bytes (${(frame.length / 1e6).toFixed(2)} bytes/block)\n`);
    expect(d.type === "patch" && d.blocks.length).toBe(1_000_000);
    expect(ms).toBeLessThan(1000);
  });
});
