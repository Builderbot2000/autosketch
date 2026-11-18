import { afterAll, describe, expect, it } from "vitest";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Document } from "../../../src/document/document.js";
import { T } from "../../../src/formats/nbt.js";
import { snapshotOf } from "../../../src/formats/snapshot.js";
import { Library } from "../../../src/library/index.js";
import { LIBRARY_PREFAB_FORMAT, loadPrefab, PREFAB_FORMATS, savePrefab, scanPrefabs } from "../../../src/library/prefabs.js";
import type { LibraryRoot } from "../../../src/library/roots.js";
import { Settings } from "../../../src/core/settings.js";
import { stampPrefab } from "../../../src/ops/stamp.js";
import { solidPng, tempDir } from "../../helpers/fixtures.js";
import { libraryContext } from "./fixture.js";

/** `17` piece 7: prefab_save writes schem, litematic, nbt or bp, and every one reads back through stamp. */

const dirs: string[] = [];
const tmp = async () => {
  const d = await tempDir("autosketch-pfmt-");
  dirs.push(d);
  return d;
};
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const userRoot = (path: string): LibraryRoot => ({ path, label: "user", kind: "library", readOnly: false });

const chestNbt = T.compound({ id: T.str("minecraft:chest"), Lock: T.str("k") });

/** 3×2×2: an andesite row, an east stair on top, an air gap at (0,1,0), a chest with NBT at (2,0,1). */
function sampleDoc(): Document {
  const doc = Document.create({ name: "src", dataVersion: 3955, seed: 7 });
  doc.edit("set", "sample", (tx) => {
    tx.set(0, 0, 0, "minecraft:andesite");
    tx.set(1, 0, 0, "minecraft:andesite");
    tx.set(2, 0, 0, "minecraft:andesite");
    tx.set(1, 1, 0, "minecraft:oak_stairs[facing=east,half=bottom]");
    tx.set(2, 1, 0, "minecraft:oak_planks");
    tx.set(2, 0, 1, "minecraft:chest[facing=south]", chestNbt);
  });
  return doc;
}

const EXPECTED: [number, number, number, string][] = [
  [0, 0, 0, "minecraft:andesite"],
  [1, 0, 0, "minecraft:andesite"],
  [2, 0, 0, "minecraft:andesite"],
  [0, 1, 0, "minecraft:air"],
  [1, 1, 0, "minecraft:oak_stairs[facing=east,half=bottom]"],
  [2, 1, 0, "minecraft:oak_planks"],
  [0, 0, 1, "minecraft:air"],
  [1, 0, 1, "minecraft:air"],
  [2, 0, 1, "minecraft:chest[facing=south]"],
  [2, 1, 1, "minecraft:air"],
];

describe("prefab_save formats", () => {
  for (const format of PREFAB_FORMATS)
    it(`saves prefab.${format} and stamp reads it back block for block`, async () => {
      const c = await libraryContext();
      const d = await tmp();
      let rendered = 0;
      const thumb = Buffer.from(solidPng([10, 200, 10], 96));
      const r = await savePrefab([userRoot(d)], snapshotOf(sampleDoc()), { name: "piece", format, anchors: { base: [0, 0, 0] }, thumbnail: async () => (rendered++, thumb) }, c.palette);
      expect(r.prefab.file).toBe(join(d, "prefabs", "piece", `prefab.${format}`));
      expect((await readdir(join(d, "prefabs", "piece"))).sort()).toEqual(["prefab.json", `prefab.${format}`].sort());
      if (format === "bp") expect(r.warnings).toEqual(['left out 1 block entities (chest contents, sign text…): their .bp layout isn\'t verified yet. Save with format "schem" to keep them.']);
      else expect(r.warnings).toEqual([]);

      const [found] = await scanPrefabs([userRoot(d)]);
      expect(found!.id).toBe("piece");
      expect(found!.file).toBe(r.prefab.file);
      const loaded = await loadPrefab(found!, c.registry);
      expect(loaded.snapshot.size).toEqual([3, 2, 2]);

      const doc = Document.create({ name: "dst", dataVersion: 3955, seed: 1, palettes: c.book });
      const s = stampPrefab(doc, { registry: c.registry, index: c.palette }, found!, loaded, { at: [10, 5, 10], includeAir: true });
      expect(s.origin).toEqual([10, 5, 10]);
      for (const [x, y, z, state] of EXPECTED) expect([x, y, z, doc.getState(10 + x, 5 + y, 10 + z)]).toEqual([x, y, z, state]);
      expect(doc.getBlockEntity(12, 5, 11)).toEqual(format === "bp" ? undefined : chestNbt);

      // The library screen's thumbnail: a .bp embeds the rendered one; the others are rendered on demand.
      const lib = new Library({ roots: [userRoot(d)], registry: c.registry, thumbnail: async (snap) => (rendered++, expect(snap.size).toEqual([3, 2, 2]), thumb) });
      expect(await lib.thumbnail(found!)).toEqual(thumb);
      expect(rendered).toBe(1);
    });

  it("overwriting in another format leaves one schematic file in the folder", async () => {
    const d = await tmp();
    await savePrefab([userRoot(d)], snapshotOf(sampleDoc()), { name: "piece" });
    await expect(savePrefab([userRoot(d)], snapshotOf(sampleDoc()), { name: "piece", format: "litematic" })).rejects.toThrow(/already exists/);
    const r = await savePrefab([userRoot(d)], snapshotOf(sampleDoc()), { name: "piece", format: "litematic", overwrite: true });
    expect(r.replaced).toBe(true);
    expect((await readdir(join(d, "prefabs", "piece"))).sort()).toEqual(["prefab.json", "prefab.litematic"]);
    const [found] = await scanPrefabs([userRoot(d)]);
    expect(found!.file).toBe(join(d, "prefabs", "piece", "prefab.litematic"));
    expect(JSON.parse(await readFile(join(d, "prefabs", "piece", "prefab.json"), "utf8"))).toMatchObject({ footprint: [3, 2], height: 2 });
  });

  it("library.prefabFormat accepts the four formats and defaults to schem", () => {
    expect(LIBRARY_PREFAB_FORMAT.default).toBe("schem");
    expect(Settings.from([], {}).get(LIBRARY_PREFAB_FORMAT)).toBe("schem");
    expect(Settings.from(["--set", "library.prefabFormat=bp"], {}).get(LIBRARY_PREFAB_FORMAT)).toBe("bp");
    expect(Settings.from([], { AUTOSKETCH_LIBRARY_PREFAB_FORMAT: "litematic" }).get(LIBRARY_PREFAB_FORMAT)).toBe("litematic");
    expect(() => Settings.from(["--set", "library.prefabFormat=png"], {}).get(LIBRARY_PREFAB_FORMAT)).toThrow(/schem, litematic, nbt or bp/);
  });
});
