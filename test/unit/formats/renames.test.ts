import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importFile } from "../../../src/formats/index.js";
import { renameState } from "../../../src/formats/renames.js";
import { encodeSponge } from "../../../src/formats/sponge.js";
import type { Snapshot } from "../../../src/formats/snapshot.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";

const dir = mkdtempSync(join(tmpdir(), "autosketch-rename-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("block rename table", () => {
  it("renames only across the versions in between", () => {
    expect(renameState("minecraft:grass", 3465, 3955)).toBe("minecraft:short_grass");
    expect(renameState("minecraft:grass", 3700, 3955)).toBe("minecraft:grass"); // already after the rename
    expect(renameState("minecraft:grass", 3465, 3578)).toBe("minecraft:grass"); // target before the rename
    expect(renameState("minecraft:grass", 0, 3955)).toBe("minecraft:grass"); // unknown file version
    expect(renameState("minecraft:sign[rotation=4]", 1631, 3955)).toBe("minecraft:oak_sign[rotation=4]");
    expect(renameState("minecraft:cauldron[level=2]", 2586, 3955)).toBe("minecraft:water_cauldron[level=2]");
    expect(renameState("minecraft:cauldron[level=0]", 2586, 3955)).toBe("minecraft:cauldron");
  });

  it("upgrades an older file on import and merges entries that became equal", async () => {
    const registry = fakeRegistry([{ id: "minecraft:dirt_path" }, partial("minecraft:short_grass")]);
    const snap: Snapshot = {
      name: "old", front: "south", dataVersion: 2586, size: [3, 1, 1], offset: [0, 0, 0],
      palette: ["minecraft:air", "minecraft:grass_path", "minecraft:grass", "minecraft:dirt_path"],
      blocks: new Uint16Array([1, 2, 3]), blockEntities: [], entities: [],
    };
    const file = join(dir, "old.schem");
    await writeFile(file, encodeSponge(snap));
    const imp = await importFile(file, { name: "old", registry, dataVersion: 3955 });
    const blocks: string[] = [];
    imp.doc.voxels.forEach((x, y, z, id) => blocks.push(`${x},${y},${z}=${imp.doc.states.get(id)}`));
    expect(blocks.sort()).toEqual(["0,0,0=minecraft:dirt_path", "1,0,0=minecraft:short_grass", "2,0,0=minecraft:dirt_path"]);
    const w = imp.warnings.join("\n");
    expect(w).toMatch(/renamed minecraft:grass_path → minecraft:dirt_path, minecraft:grass → minecraft:short_grass/);
    expect(w).not.toMatch(/unknown block/);
  });
});
