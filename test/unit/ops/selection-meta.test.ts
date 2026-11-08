import { describe, expect, it } from "vitest";
import type { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill, setBlocks } from "../../../src/ops/edit.js";
import { resolveSelection, type SelExpr } from "../../../src/ops/selection.js";
import { deltaE } from "../../../src/palette/color.js";
import { libraryContext } from "../library/fixture.js";

/** `similar` by tag/role/colour/prop and the component-metadata selections (05, Picking). */

const ctx = await libraryContext();
const { registry, palette: index } = ctx;
const env = { registry, index };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const pts = (m: Mask) => m.positions().map((p) => p.join(",")).sort();

/** A row along x at y=0: andesite, granite, oak_planks, oak_log, oak_leaves, andesite_stairs, oak_stairs. */
function row(): Document {
  const doc = Document.create({ name: "t", dataVersion: 3955, seed: 1 });
  const blocks = ["andesite", "granite", "oak_planks", "oak_log[axis=x]", "oak_leaves", "andesite_stairs[facing=east]", "oak_stairs[facing=east]", "chest[facing=east]"];
  setBlocks(doc, env, blocks.map((block, x) => ({ pos: [x, 0, 0] as Vec3, block })), { raw: true });
  return doc;
}
const sel = (doc: Document, e: SelExpr) => resolveSelection(e, { doc, registry, index });
const xs = (doc: Document, e: SelExpr) => sel(doc, e).mask.positions().map((p) => p[0]).sort((a, b) => a - b);

describe("similar by tag, role, colour, prop (05 Picking)", () => {
  it("by tag: the seed's most specific tag by default, or a named tag", () => {
    const doc = row();
    const r = sel(doc, { similar: { seed: [0, 0, 0], by: "tag" } });
    expect(r.mask.positions().map((p) => p[0]).sort()).toEqual([0, 1]); // #c:stones: andesite, granite
    expect(r.notes).toEqual(["similar: by tag #c:stones (the seed's most specific of 1 tag; pass tag to choose another)"]);
    expect(xs(doc, { similar: { seed: [0, 0, 0], by: "tag", tag: "#minecraft:planks" } })).toEqual([2]);
    expect(sel(doc, { similar: { seed: [0, 0, 0], by: "tag", tag: "#minecraft:planks" } }).notes).toEqual(["similar: the seed minecraft:andesite is not in #minecraft:planks"]);
    const none = sel(doc, { similar: { seed: [7, 0, 0], by: "tag" } });
    expect(none.mask.count()).toBe(0);
    expect(none.notes[0]).toMatch(/no block tags/);
  });

  it("by role: every block of the families in the roles holding the seed, shapes included", () => {
    const doc = row();
    const fam = (b: string) => index.familyOfBlock(b)!.id;
    doc.palettes.set({
      name: "castle",
      source: { sheet: "overview" },
      roles: {
        wall: [{ family: fam("minecraft:andesite"), block: "minecraft:andesite", weight: 0.7 }, { family: fam("minecraft:granite"), block: "minecraft:granite", weight: 0.3 }],
        trim: [{ family: fam("minecraft:oak_planks"), block: "minecraft:oak_planks", weight: 1 }],
      },
    });
    const r = sel(doc, { similar: { seed: [0, 0, 0], by: "role" } });
    expect(r.mask.positions().map((p) => p[0]).sort()).toEqual([0, 1, 5]); // andesite, granite, andesite_stairs
    expect(r.notes).toEqual(["similar: by role castle.wall"]);
    expect(xs(doc, { similar: { seed: [0, 0, 0], by: "role", role: "trim" } })).toEqual([2, 6]);
    // the only palette is the default; a second one makes palette required
    doc.palettes.set({ name: "other", source: { sheet: "overview" }, roles: {} });
    expect(() => sel(doc, { similar: { seed: [0, 0, 0], by: "role" } })).toThrow(/needs palette \(have: castle, other\)/);
    expect(xs(doc, { similar: { seed: [6, 0, 0], by: "role", palette: "castle" } })).toEqual([2, 6]);
    const none = sel(doc, { similar: { seed: [4, 0, 0], by: "role", palette: "castle" } });
    expect(none.mask.count()).toBe(0);
    expect(none.notes[0]).toMatch(/in no role of palette "castle"/);
    expect(() => sel(doc, { similar: { seed: [0, 0, 0], by: "role", palette: "castle", role: "roof" } })).toThrow(/no role "roof"/);
  });

  it("by colour: families whose mean CIELAB colour is within tolerance of the seed's", () => {
    const doc = row();
    const lab = (b: string) => index.stats(index.familyOfBlock(b)!.id)!.lab;
    const dPlanks = deltaE(lab("minecraft:granite"), lab("minecraft:oak_planks"));
    const dAndesite = deltaE(lab("minecraft:granite"), lab("minecraft:andesite"));
    expect(dPlanks).toBeLessThan(dAndesite);
    // tolerance 0: the seed's own family only (granite has no shapes)
    expect(xs(doc, { similar: { seed: [1, 0, 0], by: "colour", tolerance: 0 } })).toEqual([1]);
    // just past planks: planks, its stairs and the (closer) log join; andesite and leaves stay out
    const tol = Math.ceil(dPlanks);
    expect(deltaE(lab("minecraft:granite"), lab("minecraft:oak_log"))).toBeLessThan(tol);
    expect(Math.min(dAndesite, deltaE(lab("minecraft:granite"), lab("minecraft:oak_leaves")))).toBeGreaterThan(tol);
    expect(xs(doc, { similar: { seed: [1, 0, 0], by: "colour", tolerance: tol } })).toEqual([1, 2, 3, 6]);
    expect(() => sel(doc, { similar: { seed: [1, 0, 0], by: "colour", tolerance: -1 } })).toThrow(/tolerance must be ≥ 0/);
    // connected takes the same matches
    expect(pts(sel(doc, { connected: { seed: [2, 0, 0], match: "colour", tolerance: 0 } }).mask)).toEqual(["2,0,0"]);
  });

  it("by prop: every block with the seed's value of a state property", () => {
    const doc = row();
    expect(xs(doc, { similar: { seed: [5, 0, 0], by: "prop:facing" } })).toEqual([5, 6, 7]);
    const r = sel(doc, { similar: { seed: [0, 0, 0], by: "prop:facing" } });
    expect(r.mask.count()).toBe(0);
    expect(r.notes[0]).toMatch(/has no property "facing"/);
  });
});

describe("kind and tagged (05 Picking: component metadata)", () => {
  it("unions the boxes of matching components; a miss lists what exists", () => {
    const doc = Document.create({ name: "t", dataVersion: 3955, seed: 1 });
    fill(doc, env, B([0, 0, 0], [1, 1, 1]), "andesite", { as: "t1", kind: "tower" });
    fill(doc, env, B([5, 0, 0], [5, 2, 0]), "andesite", { as: "t2", kind: "tower" });
    fill(doc, env, B([9, 0, 0], [9, 0, 0]), "granite", { as: "p1", kind: "prefab:hut" });
    doc.edit("tag", "tag", (tx) => {
      const c = doc.componentLocal("t2")!;
      tx.setComponent({ id: "t2", kind: "tower", box: c.box, anchors: {}, tags: ["ruined"] });
    });
    expect(sel(doc, { kind: "tower" }).mask.count()).toBe(8 + 3);
    expect(pts(sel(doc, { kind: "prefab:*" }).mask)).toEqual(["9,0,0"]);
    expect(pts(sel(doc, { tagged: "ruined" }).mask)).toEqual(["5,0,0", "5,1,0", "5,2,0"]);
    const miss = sel(doc, { kind: "keep" });
    expect(miss.mask.count()).toBe(0);
    expect(miss.notes).toEqual(['kind: no component of kind "keep" (have: prefab:hut, tower); nothing selected']);
    expect(sel(doc, { tagged: "new" }).notes).toEqual(['tagged: no component tagged "new" (have: ruined); nothing selected']);
    expect(() => sel(doc, { kind: 3 })).toThrow(/kind takes a component kind/);
  });
});
