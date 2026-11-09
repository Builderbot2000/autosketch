import { describe, expect, it } from "vitest";
import { refusalCode } from "../../../src/core/events.js";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill } from "../../../src/ops/edit.js";
import { diffSince } from "../../../src/perception/diff.js";
import { ScopeManager } from "../../../src/scope/scopes.js";
import { formatHistory } from "../../../src/server/format.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import type { WireBox } from "../../../src/world/protocol/messages.js";
import { parseSnbt } from "../../../src/world/protocol/snbt.js";
import { applyWorldState, isWorldSync, WORLD_SYNC } from "../../../src/world/sync.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

const env = { registry: vanillaRegistry() };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const at = (doc: Document, x: number, y: number, z: number) => doc.getState(x, y, z).replace("minecraft:", "");
/** World position of local (0,0,0) in these tests: the work volume's minimum corner. */
const O: Vec3 = [100, 64, -200];
const W = (p: Vec3): Vec3 => [p[0] + O[0], p[1] + O[1], p[2] + O[2]];
const WB = (min: Vec3, max: Vec3): WireBox => ({ min: W(min), max: W(max) });

function linked(size: Vec3 = [8, 8, 8]) {
  const doc = Document.create({ name: "base", dataVersion: 3955, seed: 1, size });
  return doc;
}

describe("applyWorldState: the sync primitive (13, W5)", () => {
  it("writes the world's blocks as one world_sync entry, in the document's frame", () => {
    const doc = linked();
    fill(doc, env, B([0, 0, 0], [7, 0, 7]), "stone");
    const r = applyWorldState(doc, { blocks: [{ pos: W([1, 0, 1]), state: "minecraft:dirt" }, { pos: W([2, 1, 2]), state: "minecraft:oak_planks" }] }, { origin: O });
    expect(r.op).toBe(WORLD_SYNC);
    expect(r.changed).toBe(2);
    expect(r.box).toEqual(B([1, 0, 1], [2, 1, 2]));
    expect(at(doc, 1, 0, 1)).toBe("dirt");
    expect(at(doc, 2, 1, 2)).toBe("oak_planks");
    expect(at(doc, 0, 0, 0)).toBe("stone");
    const e = doc.journal.entries.at(-1)!;
    expect(isWorldSync(e)).toBe(true);
    expect(e.summary).toBe("world sync: 2 blocks");
    expect(formatHistory(doc, 5)).toContain("#2 world sync: 2 blocks · 2 changed");
    // The {"changed": …} selection and diff see it like any entry.
    expect(diffSince(doc, "op:-1").mask.count()).toBe(2);
  });

  it("adds no entry when the world already matches the cache", () => {
    const doc = linked();
    fill(doc, env, B([0, 0, 0], [7, 0, 7]), "stone");
    const head = doc.journal.headSeq;
    const r = applyWorldState(doc, { blocks: [{ pos: W([1, 0, 1]), state: "minecraft:stone" }, { pos: W([1, 5, 1]), state: "minecraft:air" }] }, { origin: O });
    expect(r.changed).toBe(0);
    expect(r.seq).toBe(head);
    expect(doc.journal.headSeq).toBe(head);
  });

  it("writes raw: no connection properties are recomputed", () => {
    const doc = linked();
    applyWorldState(doc, { blocks: [{ pos: W([1, 0, 1]), state: "minecraft:oak_fence[east=false,north=false,south=false,waterlogged=false,west=false]" }, { pos: W([2, 0, 1]), state: "minecraft:stone" }] }, { origin: O });
    expect(doc.getState(1, 0, 1)).toContain("east=false");
  });

  it("bypasses locks and the work-volume rule, which bind agents only", () => {
    const doc = linked([32, 16, 32]);
    const scopes = new ScopeManager(() => doc);
    scopes.attach(doc);
    fill(doc, env, B([0, 0, 0], [31, 0, 31]), "stone");
    scopes.fork("base", { work: Mask.fromBox(B([8, 1, 8], [15, 8, 15])), brief: "tower", env });
    // An agent edit inside the lock is refused…
    try {
      fill(doc, env, B([10, 1, 10], [10, 1, 10]), "dirt");
      expect.unreachable();
    } catch (e) {
      expect(refusalCode(e)).toBe("lock_overlap");
    }
    // …but the player's edit there syncs.
    const r = applyWorldState(doc, { blocks: [{ pos: W([10, 1, 10]), state: "minecraft:gold_block" }] }, { origin: O });
    expect(r.changed).toBe(1);
    expect(at(doc, 10, 1, 10)).toBe("gold_block");
  });

  it("whole and section form: writes every snapshot position inside the volumes, air included", () => {
    const doc = linked();
    fill(doc, env, B([0, 0, 0], [3, 3, 3]), "stone");
    // A 4×4×4 region whose palette is [air, dirt]; dirt only on the bottom layer.
    const box = WB([-2, 0, -2], [1, 3, 1]);
    const states = new Uint32Array(64);
    for (let i = 0; i < 16; i++) states[i] = 1;
    const volumes = [WB([0, 0, 0], [7, 7, 7])]; // the region pokes outside: those positions are dropped
    const r = applyWorldState(doc, { snapshot: { palette: ["minecraft:air", "minecraft:dirt"], regions: [{ box, states, blockEntities: [] }] } }, { origin: O, volumes });
    expect(at(doc, 0, 0, 0)).toBe("dirt");
    expect(at(doc, 1, 0, 1)).toBe("dirt");
    expect(at(doc, 1, 1, 1)).toBe("air"); // the world's air replaced the cache's stone
    expect(at(doc, 2, 1, 2)).toBe("stone"); // outside the region: untouched
    expect(at(doc, -1, 0, -1)).toBe("air"); // outside the volumes: dropped
    expect(r.changed).toBe(4 + 12); // bottom layer stone→dirt (4), three layers of 4 stone→air (12)
    expect(doc.journal.entries.at(-1)!.summary).toBe("world sync: snapshot of 1 region");
  });

  it("clears context the player removed, outside the current volumes", () => {
    const doc = linked();
    fill(doc, env, B([-3, 0, -3], [-1, 0, -1]), "stone");
    const r = applyWorldState(doc, { clear: [WB([-3, 0, -3], [-1, 0, -1])] }, { origin: O, volumes: [WB([0, 0, 0], [7, 7, 7])] });
    expect(r.changed).toBe(9);
    expect(doc.blockCount()).toBe(0);
  });

  it("partial NBT form: the state stays, the block entity is replaced or removed", () => {
    const doc = linked();
    const sent = parseSnbt('{id:"minecraft:chest",Items:[]}');
    const normalized = parseSnbt('{id:"minecraft:chest",Items:[],components:{}}');
    doc.edit("set", "chest", (tx) => {
      tx.set(1, 0, 1, "minecraft:chest[facing=north,type=single,waterlogged=false]", sent);
      tx.set(2, 0, 1, "minecraft:chest[facing=north,type=single,waterlogged=false]", sent);
    });
    const r = applyWorldState(doc, { nbt: [{ pos: W([1, 0, 1]), nbt: normalized }, { pos: W([2, 0, 1]) }] }, { origin: O });
    expect(r.changed).toBe(2);
    expect(doc.getState(1, 0, 1)).toContain("minecraft:chest");
    expect(doc.getBlockEntity(1, 0, 1)).toEqual(normalized);
    expect(doc.getBlockEntity(2, 0, 1)).toBeUndefined();
    expect(doc.journal.entries.at(-1)!.summary).toBe("world sync: 2 block entities");
  });

  it("compares NBT by content, ignoring volatile keys when a list is given", () => {
    const doc = linked();
    const furnace = parseSnbt('{id:"minecraft:furnace",BurnTime:0s,Items:[]}');
    const state = "minecraft:furnace[facing=north,lit=false]";
    doc.edit("set", "furnace", (tx) => tx.set(1, 0, 1, state, furnace));
    const head = doc.journal.headSeq;
    // An equal copy: no change, even without a volatile list.
    expect(applyWorldState(doc, { blocks: [{ pos: W([1, 0, 1]), state, nbt: parseSnbt('{id:"minecraft:furnace",BurnTime:0s,Items:[]}') }] }, { origin: O }).changed).toBe(0);
    // A ticked furnace: no change with the volatile list…
    const ticked = parseSnbt('{id:"minecraft:furnace",BurnTime:120s,Items:[]}');
    expect(applyWorldState(doc, { blocks: [{ pos: W([1, 0, 1]), state, nbt: ticked }] }, { origin: O, volatile: DEFAULT_VOLATILE }).changed).toBe(0);
    expect(doc.journal.headSeq).toBe(head);
    // …but a contents edit is one.
    const edited = parseSnbt('{id:"minecraft:furnace",BurnTime:0s,Items:[{Slot:0b,id:"minecraft:coal",count:1}]}');
    expect(applyWorldState(doc, { blocks: [{ pos: W([1, 0, 1]), state, nbt: edited }] }, { origin: O, volatile: DEFAULT_VOLATILE }).changed).toBe(1);
    expect(doc.getBlockEntity(1, 0, 1)).toEqual(edited);
  });

  it("keeps saved selections, anchors, palettes, checkpoints and components, and reports drift per component", () => {
    const doc = linked([16, 8, 16]);
    fill(doc, env, B([0, 0, 0], [15, 0, 15]), "stone");
    doc.edit("component", "towers", (tx) => {
      tx.setComponent({ id: "west", box: B([0, 0, 0], [3, 3, 3]), anchors: { door: [1, 0, 0] } });
      tx.setComponent({ id: "east", box: B([8, 0, 0], [11, 3, 3]) });
    });
    doc.selections.set("floor", { box: { min: [0, 0, 0], max: [15, 0, 15] } });
    doc.checkpoint("before");
    const palettes = doc.palettes;
    const r = applyWorldState(doc, { blocks: [{ pos: W([1, 0, 1]), state: "minecraft:dirt" }, { pos: W([2, 0, 2]), state: "minecraft:dirt" }, { pos: W([14, 0, 14]), state: "minecraft:dirt" }] }, { origin: O });
    expect(r.components).toEqual([{ id: "west", changed: 2 }]);
    expect(doc.selections.get("floor")).toEqual({ box: { min: [0, 0, 0], max: [15, 0, 15] } });
    expect(doc.journal.checkpoints.has("before")).toBe(true);
    expect(doc.palettes).toBe(palettes);
    expect(doc.componentLocal("west")).toMatchObject({ box: B([0, 0, 0], [3, 3, 3]), anchors: { door: [1, 0, 0] } });
    expect(doc.componentLocal("east")?.box).toEqual(B([8, 0, 0], [11, 3, 3]));
    expect(doc.journal.entries.at(-1)!.componentsAfter).toBeUndefined();
  });

  it("a sync is an edit: it discards the redo tail (13, resolved)", () => {
    const doc = linked();
    fill(doc, env, B([0, 0, 0], [0, 0, 0]), "stone");
    doc.undo();
    expect(doc.journal.canRedo).toBe(true);
    applyWorldState(doc, { blocks: [{ pos: W([5, 0, 5]), state: "minecraft:dirt" }] }, { origin: O });
    expect(doc.journal.canRedo).toBe(false);
    // An unchanged world adds no entry, so the redo tail survives it.
    fill(doc, env, B([0, 0, 0], [0, 0, 0]), "stone");
    doc.undo();
    applyWorldState(doc, { blocks: [{ pos: W([5, 0, 5]), state: "minecraft:dirt" }] }, { origin: O });
    expect(doc.journal.canRedo).toBe(true);
  });

  it("never joins a running group (a script): a sync is its own entry", () => {
    const doc = linked();
    expect(() => doc.group("script", "s", () => applyWorldState(doc, { blocks: [{ pos: W([1, 0, 1]), state: "minecraft:dirt" }] }, { origin: O }))).toThrow(/inside another edit/);
  });
});
