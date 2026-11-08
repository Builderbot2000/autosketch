import { describe, expect, it } from "vitest";
import { refusalCode } from "../../../src/core/events.js";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill } from "../../../src/ops/edit.js";
import { ScopeManager } from "../../../src/scope/scopes.js";
import { applyWorldState } from "../../../src/world/sync.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

const env = { registry: vanillaRegistry() };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const at = (doc: Document, x: number, y: number, z: number) => doc.getState(x, y, z).replace("minecraft:", "");

function setup() {
  const doc = Document.create({ name: "linked", dataVersion: 3955, seed: 1, size: [32, 16, 32] });
  const scopes = new ScopeManager(() => doc);
  scopes.attach(doc);
  fill(doc, env, B([0, 0, 0], [31, 0, 31]), "stone");
  const f = scopes.fork("base", { work: Mask.fromBox(B([8, 1, 8], [15, 8, 15])), brief: "tower", env });
  // The job fills its work volume's floor with planks.
  fill(f.scope.doc, env, B([0, 0, 0], [7, 0, 7]), "oak_planks");
  return { doc, scopes, id: f.scope.id };
}

describe("scope merge with world syncs (13, W7)", () => {
  it("a player edit inside the locked work volume doesn't fail the merge; it is kept and listed", () => {
    const { doc, scopes, id } = setup();
    // The player, who ignores locks, places a block in the lock; it reaches the parent through a sync.
    applyWorldState(doc, { blocks: [{ pos: [10, 1, 10], state: "minecraft:gold_block" }, { pos: [12, 1, 12], state: "minecraft:glass" }] });
    const m = scopes.merge(id, "done", env);
    expect(m.synced).toEqual([[10, 1, 10], [12, 1, 12]]);
    // The world's blocks stay (nothing goes out for them); the rest of the job lands.
    expect(at(doc, 10, 1, 10)).toBe("gold_block");
    expect(at(doc, 12, 1, 12)).toBe("glass");
    expect(at(doc, 11, 1, 11)).toBe("oak_planks");
    expect(m.edit.changed).toBe(64 - 2);
    const e = doc.journal.entries.at(-1)!;
    const written = new Set<string>();
    for (let i = 0; i < e.positions.length; i += 3) written.add(`${e.positions[i]},${e.positions[i + 1]},${e.positions[i + 2]}`);
    expect(written.has("10,1,10")).toBe(false);
  });

  it("a sync outside the lock, or none, leaves the merge report as before", () => {
    const { doc, scopes, id } = setup();
    applyWorldState(doc, { blocks: [{ pos: [20, 1, 20], state: "minecraft:gold_block" }] });
    const m = scopes.merge(id, "done", env);
    expect(m.synced).toBeUndefined();
    expect(m.edit.changed).toBe(64);
  });

  it("still fails loudly when something other than a sync changed the parent inside the lock", () => {
    const { doc, scopes, id } = setup();
    applyWorldState(doc, { blocks: [{ pos: [10, 1, 10], state: "minecraft:gold_block" }] });
    // Bypass the lock (as only a bug could) with a guardless write.
    const guard = doc.guard;
    doc.guard = undefined;
    fill(doc, env, B([9, 1, 9], [9, 1, 9]), "dirt");
    doc.guard = guard;
    try {
      scopes.merge(id, "done", env);
      expect.unreachable();
    } catch (e) {
      expect(refusalCode(e)).toBe("merge_check");
    }
  });

  it("a position synced twice compares against its state before the first sync", () => {
    const { doc, scopes, id } = setup();
    applyWorldState(doc, { blocks: [{ pos: [10, 1, 10], state: "minecraft:gold_block" }] });
    applyWorldState(doc, { blocks: [{ pos: [10, 1, 10], state: "minecraft:diamond_block" }] });
    const m = scopes.merge(id, "done", env);
    expect(m.synced).toEqual([[10, 1, 10]]);
    expect(at(doc, 10, 1, 10)).toBe("diamond_block");
  });
});
