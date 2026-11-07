import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Compound } from "prismarine-nbt";
import { canonicalState, isAir, parseState, shortState } from "../../../src/core/blockstate.js";
import { formatBox, fromPublic, toPublic } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { decodeNative, encodeNative, loadNative, saveNative } from "../../../src/document/native.js";
import { VoxelStore } from "../../../src/document/voxels.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";

const registry = fakeRegistry([
  { id: "minecraft:stone" },
  { id: "minecraft:oak_planks" },
  partial("minecraft:oak_stairs", {
    properties: { facing: ["north", "south", "west", "east"], half: ["top", "bottom"], shape: ["straight", "inner_left"], waterlogged: ["true", "false"] },
    defaults: { facing: "north", half: "bottom", shape: "straight", waterlogged: "false" },
    exactProperties: true,
  }),
  { id: "minecraft:chest", properties: { facing: ["north", "south", "west", "east"] }, defaults: { facing: "north" } },
]);

const newDoc = () => Document.create({ name: "t", dataVersion: 3955, seed: 1 });
const S = (s: string) => canonicalState(s, registry).state;
const chestNbt: Compound = { type: "compound", value: { id: { type: "string", value: "minecraft:chest" }, Lock: { type: "string", value: "k" } } };

/** Every non-air block as "x,y,z=state", sorted: a document's observable content. */
function snapshot(doc: Document): string[] {
  const out: string[] = [];
  doc.voxels.forEach((x, y, z, id) => out.push(`${doc.toLocal(x, y, z).join(",")}=${doc.states.get(id)}`));
  return out.sort();
}

describe("block states", () => {
  it("parses, canonicalises with defaults and validates against the registry", () => {
    expect(parseState("oak_stairs[half=top, facing=east]")).toEqual({ id: "minecraft:oak_stairs", props: { half: "top", facing: "east" } });
    expect(S("oak_stairs[half=top]")).toBe("minecraft:oak_stairs[facing=north,half=top,shape=straight,waterlogged=false]");
    expect(S("minecraft:stone")).toBe("minecraft:stone");
    expect(() => S("oak_stairs[facing=up]")).toThrow("facing=up is invalid for minecraft:oak_stairs; valid: north|south|west|east");
    expect(() => S("stone[axis=y]")).toThrow(/has no property "axis"/);
    expect(canonicalState("mod:thing[b=1,a=2]", registry)).toEqual({ state: "mod:thing[a=2,b=1]", unknown: true });
    expect(() => parseState("oak stairs")).toThrow(/bad block/);
    expect(isAir(S("cave_air"))).toBe(true);
    expect(shortState(S("oak_stairs[half=top]"), registry)).toBe("oak_stairs[half=top]");
  });

  it("converts inclusive public boxes with corners in any order", () => {
    const b = fromPublic({ min: [5, 0, 3], max: [0, 2, 0] });
    expect(b).toEqual({ min: [0, 0, 0], max: [6, 3, 4] });
    expect(toPublic(b)).toEqual({ min: [0, 0, 0], max: [5, 2, 3] });
    expect(formatBox(fromPublic({ min: [1, 1, 1], max: [1, 1, 1] }))).toBe("(1,1,1)–(1,1,1)");
    expect(() => fromPublic({ min: [0, 0.5, 0], max: [1, 1, 1] })).toThrow(/integer/);
  });
});

describe("voxel store", () => {
  it("drops emptied sections and handles negative coordinates", () => {
    const v = new VoxelStore();
    v.set(-1, -1, -1, 3);
    v.set(17, 0, 0, 4);
    expect(v.get(-1, -1, -1)).toBe(3);
    expect(v.sectionCount).toBe(2);
    expect(v.contentBox()).toEqual({ min: [-1, -1, -1], max: [18, 1, 1] });
    v.set(-1, -1, -1, 0);
    expect(v.sectionCount).toBe(1);
    expect(v.count()).toBe(1);
  });
});

describe("document edits", () => {
  it("journals an op so undo is the identity and redo replays it", () => {
    const doc = newDoc();
    doc.edit("a", "a", (tx) => tx.set(0, 0, 0, S("stone")));
    const before = snapshot(doc);
    const r = doc.edit("b", "b", (tx) => {
      for (let x = 0; x < 3; x++) tx.set(x, 1, 0, S("oak_planks"));
      tx.set(0, 0, 0, S("oak_planks"));
      tx.set(0, 0, 0, S("stone")); // back to where it was: not a change
    });
    expect(r.changed).toBe(3);
    const after = snapshot(doc);
    doc.undo();
    expect(snapshot(doc)).toEqual(before);
    doc.redo();
    expect(snapshot(doc)).toEqual(after);
  });

  it("rolls back a failing op completely", () => {
    const doc = newDoc();
    doc.edit("a", "a", (tx) => tx.set(1, 1, 1, S("stone")));
    const before = snapshot(doc);
    expect(() =>
      doc.edit("bad", "bad", (tx) => {
        tx.set(1, 1, 1, S("oak_planks"));
        tx.set(2, 2, 2, S("oak_planks"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(snapshot(doc)).toEqual(before);
    expect(doc.journal.cursor).toBe(1);
  });

  it("keeps coordinates stable when building below zero, growing the bounds", () => {
    const doc = Document.create({ name: "t", dataVersion: 3955, size: [4, 4, 4] });
    doc.edit("a", "a", (tx) => tx.set(1, 0, 1, S("stone")));
    const r = doc.edit("b", "b", (tx) => tx.set(-3, 0, 0, S("oak_planks")));
    expect(r.shift).toBeUndefined();
    expect(doc.getState(1, 0, 1)).toBe("minecraft:stone"); // unchanged
    expect(doc.getState(-3, 0, 0)).toBe("minecraft:oak_planks");
    expect(doc.localBounds()).toEqual({ min: [-3, 0, 0], max: [4, 4, 4] });
    doc.undo();
    expect(doc.localBounds()).toEqual({ min: [0, 0, 0], max: [4, 4, 4] });
  });

  it("drops block entities when a block is replaced, and restores them on undo", () => {
    const doc = newDoc();
    doc.edit("chest", "chest", (tx) => tx.set(0, 0, 0, S("chest"), chestNbt));
    expect(doc.getBlockEntity(0, 0, 0)).toBe(chestNbt);
    doc.edit("same", "same", (tx) => tx.set(0, 0, 0, S("chest")));
    expect(doc.getBlockEntity(0, 0, 0)).toBe(chestNbt); // unchanged block keeps its NBT
    doc.edit("swap", "swap", (tx) => tx.set(0, 0, 0, S("stone")));
    expect(doc.getBlockEntity(0, 0, 0)).toBeUndefined();
    doc.undo();
    expect(doc.getBlockEntity(0, 0, 0)).toBe(chestNbt);
  });

  it("restores checkpoints in both directions and refuses discarded ones", () => {
    const doc = newDoc();
    doc.checkpoint("empty");
    doc.edit("a", "a", (tx) => tx.set(0, 0, 0, S("stone")));
    doc.checkpoint("one");
    doc.edit("b", "b", (tx) => tx.set(1, 0, 0, S("stone")));
    doc.checkpoint("two");
    expect(doc.restore("empty")).toMatchObject({ steps: 2, direction: "undo" });
    expect(doc.blockCount()).toBe(0);
    expect(doc.restore("two")).toMatchObject({ steps: 2, direction: "redo" });
    expect(doc.blockCount()).toBe(2);
    doc.restore("one");
    doc.edit("c", "c", (tx) => tx.set(5, 0, 0, S("oak_planks"))); // discards op b
    expect(() => doc.restore("two")).toThrow(/can no longer be restored/);
    expect(() => doc.restore("nope")).toThrow(/no checkpoint "nope"/);
  });

  it("journals component changes with the op that made them", () => {
    const doc = newDoc();
    doc.edit("a", "a", (tx) => {
      tx.set(0, 0, 0, S("stone"));
      tx.setComponent({ id: "keep", kind: "tower", box: { min: [0, 0, 0], max: [1, 1, 1] }, anchors: { door: [0, 0, 0] } });
    });
    expect(doc.componentLocal("keep")).toMatchObject({ kind: "tower", box: { min: [0, 0, 0], max: [1, 1, 1] } });
    doc.edit("more", "more", (tx) => tx.set(-2, 0, 0, S("stone")));
    expect(doc.componentLocal("keep")!.box.min).toEqual([0, 0, 0]);
    expect(doc.componentLocal("keep")!.anchors.door).toEqual([0, 0, 0]);
    doc.undo();
    doc.undo();
    expect(doc.components.size).toBe(0);
    expect(() => doc.edit("x", "x", (tx) => tx.setComponent({ id: "bad id", box: { min: [0, 0, 0], max: [1, 1, 1] } }))).toThrow(/component id/);
  });
});

describe("native format", () => {
  it("round-trips voxels, block entities, components, palettes and meta", async () => {
    const palettes = new PaletteBook();
    palettes.set({ name: "p", roles: { wall: [{ family: "minecraft:stone", block: "minecraft:stone", weight: 1 }] }, source: { sheet: "overview" } });
    const doc = Document.create({ name: "rt", dataVersion: 3955, seed: 42, front: "east", palettes });
    const states = [S("stone"), S("oak_planks"), S("oak_stairs[facing=east]"), S("oak_stairs[half=top]"), "mod:unknown_block[x=1]"];
    doc.edit("pattern", "pattern", (tx) => {
      for (let x = -5; x < 30; x++) for (let y = 0; y < 3; y++) for (let z = 0; z < 20; z += 3) tx.set(x, y, z, states[(x + y + z + 50) % states.length]!);
      tx.set(2, 5, 2, S("chest"), chestNbt);
      tx.setComponent({ id: "body", box: { min: [0, 0, 0], max: [30, 3, 20] } });
    });
    const back = decodeNative(encodeNative(doc));
    expect(snapshot(back)).toEqual(snapshot(doc));
    expect(back.meta).toEqual(doc.meta);
    expect(back.localBounds()).toEqual(doc.localBounds());
    expect(back.getBlockEntity(2, 5, 2)).toEqual(chestNbt);
    expect(back.localBounds()!.min).toEqual([-5, 0, 0]);
    expect(back.componentLocal("body")).toEqual(doc.componentLocal("body"));
    expect(back.palettes.get("p")).toEqual(palettes.get("p"));

    const dir = await mkdtemp(join(tmpdir(), "autosketch-"));
    try {
      const path = join(dir, "rt", "doc.autosketch");
      const bytes = await saveNative(doc, path);
      expect(bytes).toBeGreaterThan(50);
      expect(snapshot(await loadNative(path))).toEqual(snapshot(doc));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(() => decodeNative(Buffer.from("nope"))).toThrow(/not an Autosketch document/);
  });
});
