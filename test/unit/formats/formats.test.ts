import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Compound } from "prismarine-nbt";
import { canonicalState } from "../../../src/core/blockstate.js";
import { Document } from "../../../src/document/document.js";
import { detectFormat, exportDocument, importFile, readCreateLimitKb } from "../../../src/formats/index.js";
import { materialList, vanillaItems } from "../../../src/formats/materials.js";
import { readNbt, T } from "../../../src/formats/nbt.js";
import { BP_MAGIC, decodeBlueprint, encodeBlueprint, packLongs, splitBlueprint, unpackLongs } from "../../../src/formats/axiom.js";
import nbt from "prismarine-nbt";
import { PNG } from "pngjs";
import { gzipSync } from "node:zlib";
import { documentFromSnapshot, snapshotOf } from "../../../src/formats/snapshot.js";
import { decodeSponge, decodeVarints, encodeSponge, encodeVarints } from "../../../src/formats/sponge.js";
import { decodeStructure, encodeStructure, splitToFit } from "../../../src/formats/structure.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";

const dir = mkdtempSync(join(tmpdir(), "autosketch-fmt-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const registry = fakeRegistry([
  { id: "minecraft:stone" },
  { id: "minecraft:oak_planks" },
  partial("minecraft:oak_stairs", {
    properties: { facing: ["north", "south", "west", "east"], half: ["top", "bottom"] },
    defaults: { facing: "north", half: "bottom" },
    exactProperties: true,
  }),
  { id: "minecraft:chest", properties: { facing: ["north", "south", "west", "east"] }, defaults: { facing: "north" } },
]);
const S = (s: string) => canonicalState(s, registry).state;
const chestNbt: Compound = T.compound({ id: T.str("minecraft:chest"), Lock: T.str("k"), Items: T.compoundList([]) });
const pig: Compound = T.compound({ id: T.str("minecraft:pig"), Health: T.int(10) });

/** A small document exercising everything the formats must keep: states, NBT, unknown blocks, entities, negative coordinates. */
function sample(): Document {
  const doc = Document.create({ name: "sample", dataVersion: 3955, seed: 1, size: [4, 3, 5] });
  doc.edit("test", "build", (tx) => {
    for (let x = 0; x < 4; x++) for (let z = 0; z < 5; z++) tx.set(x, 0, z, S("stone"));
    tx.set(1, 1, 1, S("oak_stairs[facing=east,half=top]"));
    tx.set(2, 1, 2, S("chest[facing=south]"), chestNbt);
    tx.set(3, 2, 4, "somemod:mystery[glow=true]");
    tx.set(-1, 1, 0, S("oak_planks")); // overhang below zero
  });
  doc.entities = [{ type: "compound", value: { ...pig.value, Pos: T.doubleList([1.5, 1, 2.5]) } }];
  return doc;
}

/** Observable content relative to the minimum corner: blocks, block entities, entities. */
function content(doc: Document) {
  const b = doc.bounds!;
  const blocks: string[] = [];
  doc.voxels.forEach((x, y, z, id) => blocks.push(`${x - b.min[0]},${y - b.min[1]},${z - b.min[2]}=${doc.states.get(id)}`));
  const nbt = [...doc.blockEntities].map(([k, v]) => {
    const [x, y, z] = k.split(",").map(Number) as [number, number, number];
    return [`${x - b.min[0]},${y - b.min[1]},${z - b.min[2]}`, v.value];
  });
  return { size: b.max.map((v, i) => v - b.min[i]!), blocks: blocks.sort(), nbt, entities: doc.entities.length };
}

describe("varints", () => {
  it("round-trips small and large indices", () => {
    const vals = [0, 1, 127, 128, 300, 16383, 16384, 65535];
    const bytes = encodeVarints(vals);
    expect(bytes.every((b) => b >= -128 && b <= 127)).toBe(true);
    expect([...decodeVarints(bytes, vals.length)]).toEqual(vals);
    expect(() => decodeVarints(bytes.slice(0, 3), vals.length)).toThrow(/ends after/);
  });
});

describe("Sponge .schem", () => {
  for (const version of [3, 2] as const) {
    it(`v${version} round-trips states, unknown blocks, block-entity NBT and entities`, () => {
      const doc = sample();
      const snap = snapshotOf(doc);
      expect(snap.offset).toEqual([-1, 0, 0]);
      const buf = encodeSponge(snap, { version });
      const dec = decodeSponge(buf, { registry });
      expect(dec.version).toBe(version);
      expect(dec.warnings.join()).toMatch(/unknown block somemod:mystery/);
      const back = documentFromSnapshot(dec.snapshot, { name: "back", dataVersion: dec.snapshot.dataVersion, source: "test" });
      expect(content(back)).toEqual(content(doc));
      expect(dec.snapshot.dataVersion).toBe(3955);
      expect(dec.snapshot.entities[0]!.pos).toEqual([2.5, 1, 2.5]);
      expect(dec.snapshot.blockEntities[0]!.nbt.value.Lock).toEqual(T.str("k"));
    });
  }

  it("writes the v3 layout (Schematic wrapper, Blocks container, short dimensions)", () => {
    const root = readNbt(encodeSponge(snapshotOf(sample())));
    const s = (root.value.Schematic as Compound).value;
    expect(s.Version).toEqual(T.int(3));
    expect(s.Width).toEqual(T.short(5));
    expect(s.Height).toEqual(T.short(3));
    expect(s.Length).toEqual(T.short(5));
    const blocks = (s.Blocks as Compound).value;
    expect((blocks.Palette as Compound).value["minecraft:air"]).toEqual(T.int(0));
    expect(blocks.Data!.type).toBe("byteArray");
  });

  it("canonicalises states and keeps ones the registry rejects", () => {
    const doc = Document.create({ name: "x", dataVersion: 3955, size: [2, 1, 1] });
    doc.edit("t", "t", (tx) => {
      tx.set(0, 0, 0, "minecraft:oak_stairs[facing=east]"); // missing half: filled from defaults on import
      tx.set(1, 0, 0, "minecraft:oak_stairs[shape=weird]"); // invalid property: kept verbatim
    });
    const dec = decodeSponge(encodeSponge(snapshotOf(doc)), { registry });
    expect(dec.snapshot.palette).toContain("minecraft:oak_stairs[facing=east,half=bottom]");
    expect(dec.snapshot.palette).toContain("minecraft:oak_stairs[shape=weird]");
    expect(dec.warnings.join()).toMatch(/kept as written/);
  });
});

describe("Axiom .bp", () => {
  it("packs indices like vanilla sections (no straddling, low bits first)", () => {
    for (const bits of [4, 5, 6, 7, 9, 13]) {
      const ids = new Uint16Array(4096).map((_, i) => (i * 2654435761) % (1 << bits));
      const longs = packLongs(ids, bits);
      expect(longs.length).toBe(Math.ceil(4096 / Math.floor(64 / bits)));
      expect(unpackLongs(longs, bits)).toEqual(ids);
    }
    // 4 bits: index i sits at bits 4i..4i+3 of the first long.
    const ids = new Uint16Array(4096);
    ids[0] = 1;
    ids[15] = 0xf;
    expect(packLongs(ids, 4)[0]).toEqual([0xf0000000 | 0, 1]);
    expect(unpackLongs([], 4).every((v) => v === 0)).toBe(true);
  });

  it("writes the verified container layout and round-trips blocks", () => {
    const doc = sample();
    const snap = snapshotOf(doc);
    const thumb = PNG.sync.write(Object.assign(new PNG({ width: 96, height: 96 }), {}));
    const buf = encodeBlueprint(snap, { thumbnail: thumb, author: "me", tags: ["test"] });
    expect(buf.readInt32BE(0)).toBe(BP_MAGIC | 0);
    const parts = splitBlueprint(buf);
    expect(parts.thumbnail.equals(thumb)).toBe(true);
    const header = nbt.simplify(nbt.parseUncompressed(parts.header));
    expect(header).toMatchObject({ Name: "sample", Author: "me", Tags: ["test"], Version: 2, ContainsAir: 0, BlockCount: doc.blockCount() });
    const data = readNbt(parts.data).value;
    expect(Object.keys(data).sort()).toEqual(["BlockEntities", "BlockRegion", "DataVersion", "Entities"]);

    const dec = decodeBlueprint(buf, { registry });
    expect(dec.header.author).toBe("me");
    const back = documentFromSnapshot(dec.snapshot, { name: "b", dataVersion: 3955, source: "t" });
    const blocksOf = (c: ReturnType<typeof content>) => c.blocks;
    expect(blocksOf(content(back))).toEqual(blocksOf(content(doc)));
  });

  it("treats void_air as empty, explicit air as air, and finds the extent of a centred blueprint", () => {
    // Hand-built blueprint: one section at section coords (-1,0,-1) with two blocks.
    const ids = new Uint16Array(4096);
    ids[(2 << 8) | (15 << 4) | 14] = 1; // (-2, 2, -1)
    ids[(0 << 8) | (13 << 4) | 15] = 2; // (-1, 0, -3)
    ids[(0 << 8) | (15 << 4) | 14] = 3; // explicit air at (-2, 0, -1): inside the extent, but no block
    const pal = ["minecraft:void_air", "minecraft:stone", "minecraft:oak_stairs[facing=east]", "minecraft:air"].map((st) => {
      const [name, props] = st.split("[");
      return { Name: T.str(name!), ...(props ? { Properties: T.compound({ facing: T.str("east") }) } : {}) };
    });
    const data = nbt.writeUncompressed({
      type: "compound", name: "",
      value: {
        DataVersion: T.int(3955),
        BlockRegion: T.compoundList([T.compound({ X: T.int(-1), Y: T.int(0), Z: T.int(-1), BlockStates: T.compound({ palette: T.compoundList(pal.map((p) => T.compound(p))), data: { type: "longArray", value: packLongs(ids, 4) } }) })]),
      },
    });
    const header = nbt.writeUncompressed({ type: "compound", name: "", value: { Name: T.str("hand"), Version: T.int(2), BlockCount: T.int(2) } });
    const gz = gzipSync(data);
    const thumb = Buffer.from([1, 2, 3]);
    const buf = Buffer.alloc(16 + header.length + thumb.length + gz.length);
    let o = buf.writeInt32BE(BP_MAGIC | 0, 0);
    o = buf.writeInt32BE(header.length, o); o += header.copy(buf, o);
    o = buf.writeInt32BE(thumb.length, o); o += thumb.copy(buf, o);
    o = buf.writeInt32BE(gz.length, o); gz.copy(buf, o);

    const d = decodeBlueprint(buf, { registry });
    expect(d.snapshot.size).toEqual([2, 3, 3]); // x -2..-1, y 0..2, z -3..-1
    const back = documentFromSnapshot(d.snapshot, { name: "h", dataVersion: 3955, source: "t" });
    expect(content(back).blocks).toEqual(["0,2,2=minecraft:stone", "1,0,0=minecraft:oak_stairs[facing=east,half=bottom]"]);
    expect(() => decodeBlueprint(buf.subarray(0, 30))).toThrow(/truncated blueprint/);
    expect(() => decodeBlueprint(Buffer.from("not a blueprint"))).toThrow(/bad magic/);
  });

  it("writes explicit air with includeAir", () => {
    const dec = decodeBlueprint(encodeBlueprint(snapshotOf(sample()), { includeAir: true }));
    expect(dec.header.containsAir).toBe(true);
  });
});

describe("structure .nbt", () => {
  it("round-trips and omits air unless asked", () => {
    const doc = sample();
    const buf = encodeStructure(snapshotOf(doc));
    const v = readNbt(buf).value;
    const nBlocks = (v.blocks as { value: { value: unknown[] } }).value.value.length;
    expect(nBlocks).toBe(doc.blockCount());
    const dec = decodeStructure(buf, { registry });
    expect(content(documentFromSnapshot(dec.snapshot, { name: "b", dataVersion: 3955, source: "t" }))).toEqual(content(doc));

    const withAir = readNbt(encodeStructure(snapshotOf(doc), { includeAir: true })).value;
    expect((withAir.blocks as { value: { value: unknown[] } }).value.value.length).toBe(5 * 3 * 5);
  });

  it("splits an oversized export into pieces that fit and reassemble exactly", () => {
    const doc = Document.create({ name: "big", dataVersion: 3955, seed: 1 });
    let r = 12345;
    const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    doc.edit("t", "noise", (tx) => {
      for (let x = 0; x < 40; x++) for (let y = 0; y < 8; y++) for (let z = 0; z < 40; z++) tx.set(x, y, z, `test:b${Math.floor(rnd() * 200)}`);
    });
    const snap = snapshotOf(doc);
    const limit = 16 * 1024;
    expect(encodeStructure(snap).length).toBeGreaterThan(limit);
    const pieces = splitToFit(snap, limit, (s) => encodeStructure(s));
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.buf.length).toBeLessThanOrEqual(limit);
    expect(pieces.map((p) => p.snapshot.name)).toEqual(pieces.map((_, i) => `big_${i + 1}`));

    const seen = new Map<string, string>();
    for (const p of pieces) {
      const s = decodeStructure(p.buf).snapshot;
      const back = documentFromSnapshot(s, { name: "p", dataVersion: 3955, source: "t" });
      back.voxels.forEach((x, y, z, id) => seen.set(`${x + p.at[0]},${y + p.at[1]},${z + p.at[2]}`, back.states.get(id)));
    }
    const want = new Map<string, string>();
    doc.voxels.forEach((x, y, z, id) => want.set(`${x},${y},${z}`, doc.states.get(id)));
    expect(seen).toEqual(want);
  });
});

describe("materials", () => {
  it("maps blocks to items", () => {
    expect(vanillaItems("minecraft:oak_door[half=upper]")).toEqual([]);
    expect(vanillaItems("minecraft:oak_door[half=lower]")).toEqual([{ item: "minecraft:oak_door", count: 1 }]);
    expect(vanillaItems("minecraft:red_bed[part=head]")).toEqual([]);
    expect(vanillaItems("minecraft:stone_slab[type=double]")).toEqual([{ item: "minecraft:stone_slab", count: 2 }]);
    expect(vanillaItems("minecraft:wall_torch[facing=east]")).toEqual([{ item: "minecraft:torch", count: 1 }]);
    expect(vanillaItems("minecraft:oak_wall_sign[facing=east]")).toEqual([{ item: "minecraft:oak_sign", count: 1 }]);
    expect(vanillaItems("minecraft:potted_poppy")).toEqual([{ item: "minecraft:flower_pot", count: 1 }, { item: "minecraft:poppy", count: 1 }]);
    expect(vanillaItems("minecraft:candle[candles=3,lit=false]")).toEqual([{ item: "minecraft:candle", count: 3 }]);
    expect(vanillaItems("minecraft:water[level=0]")).toBe("none");
    expect(vanillaItems("create:andesite_casing")).toEqual([{ item: "create:andesite_casing", count: 1 }]);
  });

  it("totals a snapshot and asks plugins first", () => {
    const snap = snapshotOf(sample());
    const m = materialList(snap, [{ id: "mystery", namespaces: ["somemod"], items: (s) => (s.startsWith("somemod:") ? [{ item: "somemod:dust", count: 4 }] : undefined) }]);
    expect(m.items).toContainEqual({ item: "minecraft:stone", count: 20 });
    expect(m.items).toContainEqual({ item: "somemod:dust", count: 4 });
    expect(m.items).toContainEqual({ item: "minecraft:chest", count: 1 });
  });
});

describe("export and import", () => {
  it("writes Axiom exports as blueprints with a rendered thumbnail and imports them back", async () => {
    const doc = sample();
    const instance2 = join(dir, "instance-axiom");
    let asked: unknown;
    const thumb = PNG.sync.write(new PNG({ width: 96, height: 96 }));
    const r = await exportDocument(doc, { target: "axiom" }, { instanceRoot: instance2, defaultDir: join(dir, "wsA"), registry, thumbnail: async (b) => ((asked = b), thumb) });
    expect(r.format).toBe("bp");
    expect(r.files[0]!.path).toBe(join(instance2, "config", "axiom", "blueprints", "sample.bp"));
    expect(r.hint).toMatch(/Axiom → Blueprints → sample/);
    expect(asked).toEqual(doc.localBounds());
    const buf = await readFile(r.files[0]!.path);
    expect(splitBlueprint(buf).thumbnail.equals(thumb)).toBe(true);
    expect(detectFormat(buf, "whatever.dat")).toBe("bp");
    const imp = await importFile(r.files[0]!.path, { name: "fromBp", registry });
    expect(content(imp.doc).blocks).toEqual(content(doc).blocks);

    const schem = await exportDocument(doc, { target: "axiom", format: "schem" }, { instanceRoot: instance2, defaultDir: join(dir, "wsA") });
    expect(schem.files[0]!.path).toBe(join(instance2, "schematics", "sample.schem"));
  });

  const instance = join(dir, "instance");

  it("writes Create exports into the instance, reading its size limit, and refuses to overwrite", async () => {
    await mkdir(join(instance, "config"), { recursive: true });
    await writeFile(join(instance, "config", "create-server.toml"), "[schematics]\n\tmaxTotalSchematicSize = 300\n");
    expect(await readCreateLimitKb(instance)).toBe(300);
    const doc = sample();
    const env = { instanceRoot: instance, defaultDir: join(dir, "ws", "exports"), registry, dataVersion: 3955 };
    const r = await exportDocument(doc, { target: "create" }, env);
    expect(r.format).toBe("nbt");
    expect(r.files[0]!.path).toBe(join(instance, "schematics", "sample.nbt"));
    expect(r.limitKb).toBe(300);
    expect(r.offset).toEqual([-1, 0, 0]);
    expect(r.materials!.items.length).toBeGreaterThan(0);
    expect(r.warnings.join()).toMatch(/somemod:mystery/);
    expect(r.hint).toMatch(/Schematic Table/);
    await expect(exportDocument(doc, { target: "create" }, env)).rejects.toThrow(/already exists/);
    await exportDocument(doc, { target: "create", overwrite: true }, env);
  });

  it("fails clearly over the Create limit and splits on request", async () => {
    const doc = Document.create({ name: "wide", dataVersion: 3955 });
    let r = 7;
    doc.edit("t", "noise", (tx) => {
      for (let x = 0; x < 48; x++) for (let z = 0; z < 48; z++) for (let y = 0; y < 4; y++) tx.set(x, y, z, `test:b${(r = (r * 48271) % 2147483647) % 300}`);
    });
    const env = { instanceRoot: instance, defaultDir: join(dir, "ws2"), createLimitKb: 16 };
    await expect(exportDocument(doc, { target: "create" }, env)).rejects.toThrow(/over Create's 16 KB schematic limit.*split:true/);
    const res = await exportDocument(doc, { target: "create", split: true }, env);
    const pieces = res.files.filter((f) => f.path.endsWith(".nbt"));
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(p.bytes).toBeLessThanOrEqual(16 * 1024);
    expect(await readFile(res.files.at(-1)!.path, "utf8")).toMatch(/wide_1\.nbt at \(0,0,0\)/);
  });

  it("defaults to the exports folder, overwriting there, and imports the result back", async () => {
    const doc = sample();
    const env = { defaultDir: join(dir, "ws", "exports"), registry };
    const a = await exportDocument(doc, {}, env);
    const b = await exportDocument(doc, {}, env);
    expect(a.files[0]!.path).toBe(join(dir, "ws", "exports", "sample.schem"));
    expect(b.files[0]!.path).toBe(a.files[0]!.path);
    const buf = await readFile(a.files[0]!.path);
    expect(detectFormat(buf, a.files[0]!.path)).toBe("schem");
    const imp = await importFile(a.files[0]!.path, { name: "again", registry, dataVersion: 3955 });
    expect(imp.format).toBe("schem");
    expect(content(imp.doc)).toEqual(content(doc));
    expect(imp.doc.localBounds()!.min).toEqual([0, 0, 0]);
  });

  it("exports a region, a path with format from the extension, and .bp with a warning for dropped NBT", async () => {
    const doc = sample();
    const env = { defaultDir: join(dir, "ws3"), registry };
    const r = await exportDocument(doc, { target: "path", path: join(dir, "out", "floor.nbt"), region: { min: [0, 0, 0], max: [4, 1, 5] } }, env);
    expect(r.format).toBe("nbt");
    expect(r.size).toEqual([4, 1, 5]);
    expect(r.blocks).toBe(20);
    const bp = await exportDocument(doc, { format: "bp" }, env);
    expect(bp.files[0]!.path).toMatch(/sample\.bp$/);
    expect(bp.warnings.join()).toMatch(/left out 1 block entities .* and 1 entities/);
    await expect(exportDocument(doc, { target: "path", path: join(dir, "x.zip") }, env)).rejects.toThrow(/can't tell the format/);
  });
});
