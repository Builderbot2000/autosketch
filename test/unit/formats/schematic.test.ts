import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Compound, NBT } from "prismarine-nbt";
import { Document } from "../../../src/document/document.js";
import { detectFormat, importFile } from "../../../src/formats/index.js";
import { legacyState, mergeUpperHalf } from "../../../src/formats/legacy.js";
import { T, writeGzipNbt } from "../../../src/formats/nbt.js";
import { decodeSchematic } from "../../../src/formats/schematic.js";
import { documentFromSnapshot } from "../../../src/formats/snapshot.js";

const dir = mkdtempSync(join(tmpdir(), "autosketch-legacy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** A synthetic MCEdit schematic: blocks given as [x, y, z, id, data]. */
function schematic(size: [number, number, number], blocks: [number, number, number, number, number][], extra: Compound["value"] = {}): Buffer {
  const [w, h, l] = size;
  const ids = new Array<number>(w * h * l).fill(0), data = new Array<number>(w * h * l).fill(0);
  let add: number[] | undefined;
  for (const [x, y, z, id, d] of blocks) {
    const i = (y * l + z) * w + x;
    ids[i] = (id & 0xff) > 127 ? (id & 0xff) - 256 : id & 0xff;
    data[i] = d;
    if (id > 255) {
      add ??= new Array<number>(Math.ceil((w * h * l) / 2)).fill(0);
      add[i >> 1]! |= i & 1 ? id >> 8 : (id >> 8) << 4;
    }
  }
  const root: NBT = {
    type: "compound",
    name: "Schematic",
    value: {
      Width: T.short(w),
      Height: T.short(h),
      Length: T.short(l),
      Materials: T.str("Alpha"),
      Blocks: T.bytes(ids),
      Data: T.bytes(data),
      ...(add ? { AddBlocks: T.bytes(add) } : {}),
      Entities: T.compoundList([]),
      TileEntities: T.compoundList([]),
      ...extra,
    },
  };
  return writeGzipNbt(root);
}

function blocksOf(doc: Document): string[] {
  const out: string[] = [];
  doc.voxels.forEach((x, y, z, id) => out.push(`${x},${y},${z}=${doc.states.get(id)}`));
  return out.sort();
}

describe("legacy id table", () => {
  it("maps variants, orientations and slabs", () => {
    expect(legacyState(1, 5)).toEqual({ state: "minecraft:andesite", quality: "exact" });
    expect(legacyState(35, 14).state).toBe("minecraft:red_wool");
    expect(legacyState(17, 1 | 4).state).toBe("minecraft:spruce_log[axis=x]");
    expect(legacyState(17, 2 | 12).state).toBe("minecraft:birch_wood[axis=y]");
    expect(legacyState(53, 2 | 4).state).toBe("minecraft:oak_stairs[facing=south,half=top]");
    expect(legacyState(44, 8 | 3).state).toBe("minecraft:cobblestone_slab[type=top]");
    expect(legacyState(43, 0).state).toBe("minecraft:smooth_stone_slab[type=double]");
    expect(legacyState(50, 3).state).toBe("minecraft:wall_torch[facing=south]");
    expect(legacyState(50, 5).state).toBe("minecraft:torch");
    expect(legacyState(54, 4).state).toBe("minecraft:chest[facing=west]");
    expect(legacyState(249, 1).state).toBe("minecraft:red_glazed_terracotta[facing=west]");
    expect(legacyState(208, 0).state).toBe("minecraft:dirt_path");
  });

  it("falls back to the default variant for an unmapped data value, and a placeholder for an unknown id", () => {
    expect(legacyState(1, 9)).toEqual({ state: "minecraft:stone", quality: "partial" });
    expect(legacyState(253, 3)).toEqual({ state: "legacy:id_253[data=3]", quality: "unknown" });
  });

  it("merges upper door halves with the lower half", () => {
    expect(mergeUpperHalf("minecraft:oak_door[half=upper,hinge=right,powered=false]", "minecraft:oak_door[facing=north,half=lower,open=true]")).toBe(
      "minecraft:oak_door[facing=north,half=upper,hinge=right,open=true,powered=false]",
    );
    expect(mergeUpperHalf("minecraft:tall_grass[half=upper]", "minecraft:rose_bush[half=lower]")).toBe("minecraft:rose_bush[half=upper]");
  });
});

describe("MCEdit .schematic", () => {
  it("imports a synthetic schematic: variants, doors, double plants, unknown ids and AddBlocks", async () => {
    const buf = schematic(
      [3, 2, 2],
      [
        [0, 0, 0, 1, 0], // stone
        [1, 0, 0, 35, 11], // blue wool
        [2, 0, 0, 64, 3], // oak door lower, facing north
        [2, 1, 0, 64, 8 | 1], // upper, hinge right
        [0, 0, 1, 175, 4], // rose bush lower
        [0, 1, 1, 175, 8], // upper
        [1, 0, 1, 253, 7], // unknown id
        [2, 0, 1, 300, 0], // id above 255, via AddBlocks
      ],
      { TileEntities: T.compoundList([T.compound({ id: T.str("Chest"), x: T.int(1), y: T.int(0), z: T.int(0) })]) },
    );
    expect(detectFormat(buf, "x.schematic")).toBe("schematic");
    const file = join(dir, "old.schematic");
    await writeFile(file, buf);
    const imp = await importFile(file, { name: "old", dataVersion: 3955 });
    expect(imp.format).toBe("schematic");
    expect(blocksOf(imp.doc)).toEqual(
      [
        "0,0,0=minecraft:stone",
        "1,0,0=minecraft:blue_wool",
        "2,0,0=minecraft:oak_door[facing=north,half=lower,open=false]",
        "2,1,0=minecraft:oak_door[facing=north,half=upper,hinge=right,open=false,powered=false]",
        "0,0,1=minecraft:rose_bush[half=lower]",
        "0,1,1=minecraft:rose_bush[half=upper]",
        "1,0,1=legacy:id_253[data=7]",
        "2,0,1=legacy:id_300[data=0]",
      ].sort(),
    );
    expect(imp.warnings.join("\n")).toMatch(/2 blocks with legacy ids the table doesn't know \(253, 300\)/);
    expect(imp.warnings.join("\n")).toMatch(/1 block entities kept in their pre-1.13 layout/);
    expect(imp.warnings.join("\n")).not.toMatch(/DataVersion/);
    expect(imp.doc.getBlockEntity(1, 0, 0)!.value.id).toEqual(T.str("Chest"));
  });

  it("uses a Schematica name mapping for modded ids", () => {
    const buf = schematic([1, 1, 1], [[0, 0, 0, 600, 2]], { SchematicaMapping: T.compound({ "somemod:gizmo": T.short(600) }) });
    const dec = decodeSchematic(buf);
    const doc = documentFromSnapshot(dec.snapshot, { name: "m", dataVersion: 3955, source: "t" });
    expect(blocksOf(doc)).toEqual(["0,0,0=somemod:gizmo"]);
    expect(dec.warnings.join()).toMatch(/data values not mapped for legacy ids 600/);
  });
});
