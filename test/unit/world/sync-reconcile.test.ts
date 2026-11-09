import { describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { parseSnbt } from "../../../src/world/protocol/snbt.js";
import { applyWorldState } from "../../../src/world/sync.js";

const O: Vec3 = [100, 64, -200];
const W = (p: Vec3): Vec3 => [p[0] + O[0], p[1] + O[1], p[2] + O[2]];
const CHEST = "minecraft:chest[facing=north,type=single,waterlogged=false]";
const A = parseSnbt('{id:"minecraft:chest",Items:[]}');
const A2 = parseSnbt('{id:"minecraft:chest",Items:[],components:{}}');
const Bn = parseSnbt('{id:"minecraft:chest",Items:[{Slot:0b,id:"minecraft:diamond",count:1}]}');

const linked = () => Document.create({ name: "linked", dataVersion: 3955, seed: 1, size: [8, 8, 8] });

/** A chest placed with A (#1), then its contents edited to B (#2). */
function chest() {
  const doc = linked();
  doc.edit("set", "chest", (tx) => tx.set(1, 0, 1, CHEST, A));
  doc.edit("set", "fill chest", (tx) => tx.set(1, 0, 1, CHEST, Bn));
  return doc;
}

describe("applyWorldState with reconcile: an ack's normalized NBT (13, the redo-tail answer)", () => {
  it("undo a block-entity edit, apply the ack's normalized list, then redo succeeds", () => {
    const doc = chest();
    doc.undo(); // the patch sends A; the game saves it as A2
    const head = doc.journal.headSeq;
    const r = applyWorldState(doc, { nbt: [{ pos: W([1, 0, 1]), nbt: A2, sent: A }] }, { origin: O, reconcile: true });
    expect(r).toMatchObject({ changed: 0, reconciled: 1, seq: head });
    expect(doc.getBlockEntity(1, 0, 1)).toEqual(A2);
    expect(doc.journal.headSeq).toBe(head);
    expect(doc.journal.canRedo).toBe(true);
    expect(doc.redo()?.entry.seq).toBe(2);
    expect(doc.getBlockEntity(1, 0, 1)).toEqual(Bn);
    // The history now records what the world holds: undo writes the normalized form…
    doc.undo();
    expect(doc.getBlockEntity(1, 0, 1)).toEqual(A2);
    // …and so does #1's after side, which was the same compound.
    doc.undo();
    expect(doc.getBlockEntity(1, 0, 1)).toBeUndefined();
    doc.redo();
    expect(doc.getBlockEntity(1, 0, 1)).toEqual(A2);
  });

  it("after a commit: no entry, no barrier, and undo/redo pass as before", () => {
    const doc = linked();
    doc.edit("set", "chest", (tx) => tx.set(1, 0, 1, CHEST, A));
    applyWorldState(doc, { nbt: [{ pos: W([1, 0, 1]), nbt: A2 }] }, { origin: O, reconcile: true });
    expect(doc.journal.entries.map((e) => e.op)).toEqual(["set"]);
    expect(doc.undo()?.entry.seq).toBe(1);
    expect(doc.redo()?.entry.seq).toBe(1);
    expect(doc.getBlockEntity(1, 0, 1)).toEqual(A2);
  });

  it("skips a position the cache has moved on from, and still journals the ack's skipped blocks", () => {
    const doc = chest();
    doc.undo();
    doc.redo(); // the cache no longer holds what the undo's patch sent
    const r = applyWorldState(doc, { nbt: [{ pos: W([1, 0, 1]), nbt: A2, sent: A }] }, { origin: O, reconcile: true });
    expect(r.reconciled).toBe(0);
    expect(doc.getBlockEntity(1, 0, 1)).toEqual(Bn);
    // Skipped blocks in the same ack are world changes: one world_sync entry, as always.
    doc.undo();
    const s = applyWorldState(doc, { blocks: [{ pos: W([4, 0, 4]), state: "minecraft:glass" }], nbt: [{ pos: W([1, 0, 1]), nbt: A2, sent: A }] }, { origin: O, reconcile: true });
    expect(s).toMatchObject({ changed: 1, reconciled: 1 });
    expect(doc.journal.entries.at(-1)!.op).toBe("world_sync");
    expect(doc.journal.entries.at(-1)!.before.length).toBe(1);
    expect(doc.journal.canRedo).toBe(false);
  });

  it("removes the block entity everywhere the journal shared it when the game kept none", () => {
    const doc = linked();
    doc.edit("set", "chest", (tx) => tx.set(1, 0, 1, CHEST, A));
    applyWorldState(doc, { nbt: [{ pos: W([1, 0, 1]) }] }, { origin: O, reconcile: true });
    expect(doc.getBlockEntity(1, 0, 1)).toBeUndefined();
    doc.undo();
    doc.redo();
    expect(doc.getBlockEntity(1, 0, 1)).toBeUndefined();
  });

  it("without reconcile, the same list is a world_sync entry that drops the redo tail", () => {
    const doc = chest();
    doc.undo();
    applyWorldState(doc, { nbt: [{ pos: W([1, 0, 1]), nbt: A2 }] }, { origin: O });
    expect(doc.journal.canRedo).toBe(false);
  });
});
