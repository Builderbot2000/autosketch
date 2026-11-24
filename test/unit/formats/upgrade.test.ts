import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Compound } from "prismarine-nbt";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { importFile } from "../../../src/formats/index.js";
import { renameState } from "../../../src/formats/renames.js";
import type { Snapshot } from "../../../src/formats/snapshot.js";
import { encodeSponge } from "../../../src/formats/sponge.js";
import { encodeStructure } from "../../../src/formats/structure.js";
import type { SchematicUpgrader, UpgradePayload } from "../../../src/formats/upgrade.js";
import { loadPrefab, type Prefab } from "../../../src/library/prefabs.js";
import { Bridge } from "../../../src/world/bridge.js";
import { bridgeUpgrader } from "../../../src/world/upgrade.js";
import { FakeHost } from "../../support/fake-host.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";

/**
 * Schematics from other versions (14, *Schematics from other versions: the established practice*;
 * 08, *Import*): forward-only upgrades on import and prefab load, through the linked game's data
 * fixer or, unlinked, the rename table with a partial-upgrade warning. Synthetic files only.
 */

const dir = mkdtempSync(join(tmpdir(), "autosketch-upgrade-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const registry = fakeRegistry([{ id: "minecraft:stone" }, partial("minecraft:short_grass"), partial("minecraft:dirt_path"), partial("minecraft:oak_sign", { properties: { rotation: ["0", "4"] }, defaults: { rotation: "0" } })]);
const str = (value: string) => ({ type: "string" as const, value });
const OLD_SIGN: Compound = { type: "compound", value: { id: str("minecraft:sign"), Text1: str('{"text":"North"}') } };
const NEW_SIGN: Compound = { type: "compound", value: { id: str("minecraft:sign"), front_text: { type: "compound", value: { messages: { type: "list", value: { type: "string", value: ['{"text":"North"}'] } } } } } };

function snapshot(dataVersion: number, palette: string[], extra: Partial<Snapshot> = {}): Snapshot {
  return { name: "old", front: "south", dataVersion, size: [palette.length - 1, 1, 1], offset: [0, 0, 0], palette, blocks: Uint16Array.from(palette.slice(1).map((_, i) => i + 1)), blockEntities: [], entities: [], ...extra };
}

async function file(name: string, buf: Buffer): Promise<string> {
  const f = join(dir, name);
  await writeFile(f, buf);
  return f;
}

const blocksOf = (doc: Awaited<ReturnType<typeof importFile>>["doc"]) => {
  const out: string[] = [];
  doc.voxels.forEach((x, y, z, id) => out.push(`${x},${y},${z}=${doc.states.get(id)}`));
  return out.sort();
};

/** A stand-in for the game's fixer: the rename table over states, the old sign layout to the new one; records what it was asked. */
function fakeGame(to = 3955): SchematicUpgrader & { asked: { from: number; data: UpgradePayload }[] } {
  const asked: { from: number; data: UpgradePayload }[] = [];
  return {
    dataVersion: to,
    asked,
    upgrade: async (from, data) => {
      asked.push({ from, data });
      if (data.kind === "structure") return { ...data, to };
      return {
        kind: "elements",
        to,
        states: data.states.map((s) => renameState(s, from, to)),
        blockEntities: data.blockEntities.map((b) => (b.value.Text1 ? NEW_SIGN : b)),
        entities: data.entities,
      };
    },
  };
}

describe("import, linked: the game's data fixer", () => {
  it("upgrades a 1.20.1 .schem's states and block entities, per element, and stamps the game's version", async () => {
    const snap = snapshot(3465, ["minecraft:air", "minecraft:grass", "minecraft:oak_sign[rotation=4]", "othermod:gizmo[lit=true]"], { blockEntities: [{ pos: [1, 0, 0], nbt: OLD_SIGN }] });
    const game = fakeGame();
    const imp = await importFile(await file("a.schem", encodeSponge(snap)), { name: "a", registry, dataVersion: 3700, upgrader: game });
    expect(game.asked).toHaveLength(1);
    expect(game.asked[0]).toMatchObject({ from: 3465, data: { kind: "elements", states: ["minecraft:grass", "minecraft:oak_sign[rotation=4]", "othermod:gizmo[lit=true]"] } });
    expect(blocksOf(imp.doc)).toEqual(["0,0,0=minecraft:short_grass", "1,0,0=minecraft:oak_sign[rotation=4]", "2,0,0=othermod:gizmo[lit=true]"]);
    expect(imp.doc.blockEntities.get("1,0,0")).toEqual(NEW_SIGN);
    expect(imp.doc.meta.dataVersion).toBe(3955);
    expect(imp.warnings).toContain("upgraded from DataVersion 3465 to 3955 through the game's data fixer");
    expect(imp.warnings).toContain("unknown block othermod:gizmo (kept)");
    expect(imp.warnings.join("\n")).not.toMatch(/partial/);
  });

  it("upgrades a whole .nbt structure in one piece, reading a missing DataVersion as 500", async () => {
    const snap = snapshot(0, ["minecraft:air", "minecraft:stone"]);
    const game = fakeGame();
    const imp = await importFile(await file("s.nbt", encodeStructure(snap)), { name: "s", registry, upgrader: game });
    expect(game.asked[0]?.from).toBe(500);
    expect(game.asked[0]?.data.kind).toBe("structure");
    expect(imp.warnings).toContain("the file names no DataVersion; read as 500, as the format's own tools do");
    expect(imp.doc.meta.dataVersion).toBe(3955);
    expect(blocksOf(imp.doc)).toEqual(["0,0,0=minecraft:stone"]);
  });

  it("reports elements the fixer couldn't upgrade, and falls back to the rename table when the game fails", async () => {
    const snap = snapshot(3465, ["minecraft:air", "minecraft:grass"]);
    const f = await file("f.schem", encodeSponge(snap));
    const partly: SchematicUpgrader = { dataVersion: 3955, upgrade: async (_from, d) => ({ ...(d as Extract<UpgradePayload, { kind: "elements" }>), to: 3955, failed: 1 }) };
    expect((await importFile(f, { name: "f", registry, upgrader: partly })).warnings).toContain("upgraded from DataVersion 3465 to 3955 through the game's data fixer; 1 element it couldn't upgrade was kept as written");
    const broken: SchematicUpgrader = { dataVersion: 3955, upgrade: async () => Promise.reject(new Error("The game disconnected")) };
    const imp = await importFile(f, { name: "f", registry, upgrader: broken });
    expect(blocksOf(imp.doc)).toEqual(["0,0,0=minecraft:short_grass"]);
    expect(imp.warnings.join("\n")).toMatch(/the game couldn't upgrade the file \(The game disconnected\); used the rename table instead/);
    expect(imp.warnings.join("\n")).toMatch(/partial upgrade from DataVersion 3465 to 3955/);
  });

  it("never downgrades a file newer than the game: a warning names both versions, unknown blocks stay verbatim", async () => {
    const snap = snapshot(4189, ["minecraft:air", "minecraft:stone", "minecraft:pale_oak_planks"]);
    const game = fakeGame();
    const imp = await importFile(await file("n.schem", encodeSponge(snap)), { name: "n", registry, upgrader: game });
    expect(game.asked).toEqual([]);
    expect(imp.warnings).toContain("the file is from a newer game (DataVersion 4189) than this one (3955): it isn't downgraded, and blocks this game doesn't know are kept verbatim");
    expect(imp.warnings).toContain("unknown block minecraft:pale_oak_planks (kept)");
    expect(blocksOf(imp.doc)).toContain("1,0,0=minecraft:pale_oak_planks");
    expect(imp.doc.meta.dataVersion).toBe(4189);
  });

  it("through the bridge: a .schem with DataVersion 3465 holding minecraft:grass imports as short_grass", async () => {
    const host = await FakeHost.start();
    const bridge = new Bridge({ instanceDir: host.instanceDir, volatile: {}, reconnect: false });
    try {
      await bridge.connect();
      const upgrader = bridgeUpgrader(bridge);
      expect(upgrader?.dataVersion).toBe(3955);
      const imp = await importFile(await file("g.schem", encodeSponge(snapshot(3465, ["minecraft:air", "minecraft:grass"]))), { name: "g", registry, upgrader: upgrader! });
      expect(blocksOf(imp.doc)).toEqual(["0,0,0=minecraft:short_grass"]);
      expect(host.received.find((m) => m.type === "upgrade")).toMatchObject({ from: 3465, kind: "elements", states: ["minecraft:grass"] });
    } finally {
      bridge.close();
      await host.close();
    }
  });

  it("has no upgrader without a connection or the upgrade feature", async () => {
    const host = await FakeHost.start({ protocol: 3, features: ["modes", "volumes.set", "registry"] });
    const bridge = new Bridge({ instanceDir: host.instanceDir, volatile: {}, reconnect: false });
    try {
      expect(bridgeUpgrader(bridge)).toBeUndefined();
      await bridge.connect();
      expect(bridgeUpgrader(bridge)).toBeUndefined(); // a mod without the upgrade feature
    } finally {
      bridge.close();
      await host.close();
    }
  });
});

describe("import, unlinked: the rename table", () => {
  it("renames the ids it knows and says the upgrade was partial", async () => {
    const imp = await importFile(await file("u.schem", encodeSponge(snapshot(3465, ["minecraft:air", "minecraft:grass"]))), { name: "u", registry, dataVersion: 3955 });
    expect(blocksOf(imp.doc)).toEqual(["0,0,0=minecraft:short_grass"]);
    expect(imp.warnings).toContain(
      "partial upgrade from DataVersion 3465 to 3955: no game with the Autosketch mod is linked, so only renamed block ids were upgraded (minecraft:grass → minecraft:short_grass); property and block-entity changes weren't. Link the game for a full upgrade.",
    );
    expect(imp.doc.meta.dataVersion).toBe(3465);
  });

  it("reads a .schem without a DataVersion as 1631 (Sponge v1), so the 1.14 sign rename applies", async () => {
    const imp = await importFile(await file("v1.schem", encodeSponge(snapshot(0, ["minecraft:air", "minecraft:sign[rotation=4]"]))), { name: "v1", registry, dataVersion: 3955 });
    expect(blocksOf(imp.doc)).toEqual(["0,0,0=minecraft:oak_sign[rotation=4]"]);
    expect(imp.warnings).toContain("the file names no DataVersion; read as 1631, as the format's own tools do");
  });

  it("leaves a file at the game's version alone", async () => {
    const imp = await importFile(await file("same.schem", encodeSponge(snapshot(3955, ["minecraft:air", "minecraft:stone"]))), { name: "same", registry, dataVersion: 3955, upgrader: fakeGame() });
    expect(imp.warnings).toEqual([]);
  });
});

describe("prefab load", () => {
  let host: FakeHost | undefined;
  afterEach(async () => host?.close());

  it("upgrades each time it loads, through the game when linked, never rewriting the file", async () => {
    const f = await file("p.schem", encodeSponge(snapshot(2586, ["minecraft:air", "minecraft:grass_path"])));
    const p = { id: "p", file: f, meta: {} } as unknown as Prefab;
    const unlinked = await loadPrefab(p, registry, { dataVersion: 3955 });
    expect(unlinked.snapshot.palette).toContain("minecraft:dirt_path");
    expect(unlinked.warnings.join("\n")).toMatch(/partial upgrade/);
    const game = fakeGame();
    const linked = await loadPrefab(p, registry, { upgrader: game });
    expect(game.asked).toHaveLength(1);
    expect(linked.warnings.join("\n")).toMatch(/through the game's data fixer/);
    expect(await loadPrefab(p, registry, { upgrader: game })).toBe(linked); // cached per file and upgrade source
  });
});
