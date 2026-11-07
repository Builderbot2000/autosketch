import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Compound, NBT } from "prismarine-nbt";
import { canonicalState } from "../../../src/core/blockstate.js";
import { Document } from "../../../src/document/document.js";
import { detectFormat, exportDocument, importFile } from "../../../src/formats/index.js";
import { bitsFor, decodeLitematic, encodeLitematic, packTight, unpackTight } from "../../../src/formats/litematic.js";
import { readNbt, T, writeGzipNbt } from "../../../src/formats/nbt.js";
import { documentFromSnapshot, snapshotOf } from "../../../src/formats/snapshot.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";

const dir = mkdtempSync(join(tmpdir(), "autosketch-lite-"));
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
const chestNbt: Compound = T.compound({ id: T.str("minecraft:chest"), Lock: T.str("k") });

function sample(): Document {
  const doc = Document.create({ name: "sample", dataVersion: 3955, seed: 1, size: [4, 3, 5] });
  doc.edit("test", "build", (tx) => {
    for (let x = 0; x < 4; x++) for (let z = 0; z < 5; z++) tx.set(x, 0, z, S("stone"));
    tx.set(1, 1, 1, S("oak_stairs[facing=east,half=top]"));
    tx.set(2, 1, 2, S("chest[facing=south]"), chestNbt);
    tx.set(3, 2, 4, "somemod:mystery[glow=true]");
    tx.set(-1, 1, 0, S("oak_planks"));
  });
  doc.entities = [T.compound({ id: T.str("minecraft:pig"), Pos: T.doubleList([1.5, 1, 2.5]) })];
  return doc;
}

function blocksOf(doc: Document): string[] {
  const b = doc.bounds!;
  const out: string[] = [];
  doc.voxels.forEach((x, y, z, id) => out.push(`${x - b.min[0]},${y - b.min[1]},${z - b.min[2]}=${doc.states.get(id)}`));
  return out.sort();
}

describe("Litematica bit array", () => {
  it("packs tightly, straddling longs, low bits first", () => {
    for (const bits of [2, 3, 5, 7, 13]) {
      const vals = Array.from({ length: 1000 }, (_, i) => (i * 2654435761) % (1 << bits));
      const longs = packTight(vals, bits);
      expect(longs.length).toBe(Math.ceil((1000 * bits) / 64));
      expect([...unpackTight(longs, bits, 1000)]).toEqual(vals);
    }
    // 3 bits: entry 21 occupies bits 63..65, straddling the first and second long.
    const vals = new Array(23).fill(0);
    vals[21] = 0b111;
    expect(packTight(vals, 3)).toEqual([[0x80000000 | 0, 0], [0, 0b11]]);
    expect(bitsFor(1)).toBe(2);
    expect(bitsFor(5)).toBe(3);
  });
});

describe("Litematica .litematic", () => {
  it("round-trips states, unknown blocks, block-entity NBT and entities", () => {
    const doc = sample();
    const buf = encodeLitematic(snapshotOf(doc), { author: "me", date: 0 });
    const root = readNbt(buf).value;
    expect(root.Version).toEqual(T.int(7));
    expect(root.MinecraftDataVersion).toEqual(T.int(3955));
    const meta = (root.Metadata as Compound).value;
    expect(meta.TotalBlocks).toEqual(T.int(doc.blockCount()));
    expect(meta.EnclosingSize).toEqual(T.compound({ x: T.int(5), y: T.int(3), z: T.int(5) }));
    expect(Object.keys((root.Regions as Compound).value)).toEqual(["sample"]);

    const dec = decodeLitematic(buf, { registry });
    expect(dec.warnings.join()).toMatch(/unknown block somemod:mystery/);
    expect(dec.snapshot.author).toBe("me");
    expect(dec.regions).toEqual([{ name: "sample", box: { min: [0, 0, 0], max: [5, 3, 5] } }]);
    const back = documentFromSnapshot(dec.snapshot, { name: "b", dataVersion: 3955, source: "t" });
    expect(blocksOf(back)).toEqual(blocksOf(doc));
    // The chest sits at local (2,1,2), i.e. (3,1,2) from the minimum corner (x starts at -1).
    expect(dec.snapshot.blockEntities).toEqual([{ pos: [3, 1, 2], nbt: chestNbt }]);
    expect(dec.snapshot.entities[0]!.pos).toEqual([2.5, 1, 2.5]);
  });

  it("merges a hand-built multi-region file with a negative size and registers regions as components", async () => {
    // Region "base": 2×1×1 at (0,0,0). Region "Tower Top": Position (1,3,0), Size (-2,1,1) → x 0..1, y 3.
    const region = (pos: number[], size: number[], palette: string[], idx: number[]) =>
      T.compound({
        Position: T.compound({ x: T.int(pos[0]!), y: T.int(pos[1]!), z: T.int(pos[2]!) }),
        Size: T.compound({ x: T.int(size[0]!), y: T.int(size[1]!), z: T.int(size[2]!) }),
        BlockStatePalette: T.compoundList(palette.map((n) => T.compound({ Name: T.str(n) }))),
        BlockStates: { type: "longArray", value: packTight(idx, bitsFor(palette.length)) },
        TileEntities: T.compoundList([]),
        Entities: T.compoundList([]),
      });
    const root: NBT = {
      type: "compound",
      name: "",
      value: {
        MinecraftDataVersion: T.int(3955),
        Version: T.int(6),
        Metadata: T.compound({ Name: T.str("two") }),
        Regions: T.compound({
          base: region([0, 0, 0], [2, 1, 1], ["minecraft:air", "minecraft:stone"], [1, 1]),
          "Tower Top": region([1, 3, 0], [-2, 1, 1], ["minecraft:air", "minecraft:oak_planks"], [0, 1]),
        }),
      },
    };
    const file = join(dir, "two.litematic");
    await writeFile(file, writeGzipNbt(root));
    expect(detectFormat(writeGzipNbt(root), "x.nbt")).toBe("litematic");

    const imp = await importFile(file, { name: "two", registry });
    expect(imp.format).toBe("litematic");
    expect(imp.warnings.join()).toMatch(/2 regions merged/);
    expect(blocksOf(imp.doc)).toEqual(["0,0,0=minecraft:stone", "1,0,0=minecraft:stone", "1,3,0=minecraft:oak_planks"]);
    expect(imp.doc.componentLocal("base")!.box).toEqual({ min: [0, 0, 0], max: [2, 1, 1] });
    expect(imp.doc.componentLocal("tower_top")!.box).toEqual({ min: [0, 3, 0], max: [2, 4, 1] });
    expect(imp.doc.journal.entries.length).toBe(0);
  });

  it("exports through exportDocument and imports back", async () => {
    const doc = sample();
    const r = await exportDocument(doc, { target: "path", path: join(dir, "out.litematic") }, { defaultDir: dir });
    expect(r.format).toBe("litematic");
    expect(r.hint).toMatch(/Litematica/);
    const imp = await importFile(r.files[0]!.path, { name: "back", registry });
    expect(blocksOf(imp.doc)).toEqual(blocksOf(doc));
    expect(imp.doc.components.size).toBe(0);
    expect(imp.warnings.join()).not.toMatch(/regions merged/);
  });
});
