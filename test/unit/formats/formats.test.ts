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

  it("exports a region, a path with format from the extension, and rejects .bp for now", async () => {
    const doc = sample();
    const env = { defaultDir: join(dir, "ws3"), registry };
    const r = await exportDocument(doc, { target: "path", path: join(dir, "out", "floor.nbt"), region: { min: [0, 0, 0], max: [4, 1, 5] } }, env);
    expect(r.format).toBe("nbt");
    expect(r.size).toEqual([4, 1, 5]);
    expect(r.blocks).toBe(20);
    await expect(exportDocument(doc, { format: "bp" }, env)).rejects.toThrow(/\.bp writing is not available yet/);
    await expect(exportDocument(doc, { target: "path", path: join(dir, "x.zip") }, env)).rejects.toThrow(/can't tell the format/);
  });
});
