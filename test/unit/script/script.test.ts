import { describe, expect, it } from "vitest";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill } from "../../../src/ops/edit.js";
import { runScript, ScriptError } from "../../../src/script/run.js";
import { scriptApiDts } from "../../../src/script/dts.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

const registry = vanillaRegistry();
const env = { registry };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const newDoc = () => Document.create({ name: "s", dataVersion: 3955, seed: 7 });
const at = (doc: Document, x: number, y: number, z: number) => doc.getState(x, y, z).replace(/minecraft:/g, "");

describe("script sandbox (05 Scripting)", () => {
  it("runs the crenellation example from 05 and undoes it in one step", async () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [4, 3, 4]), "stone_bricks", { mode: "walls", as: "keep" });
    const pos = doc.journal.position;
    const run = await runScript(doc, env, {
      source: `
        const top = sel.layer(component("keep").region, "max");
        array(sel.box([0,0,0],[0,1,0]), { along: sel.perimeter(top), every: 2 })
          .fill("stone_bricks");
        return "done";`,
    });
    expect(run.value).toBe('"done"');
    expect(doc.journal.position).toBe(pos + 1);
    // The top ring (y=3) has 16 blocks; every 2nd one gets a merlon at y=4.
    let merlons = 0;
    for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) if (at(doc, x, 4, z) === "stone_bricks") merlons++;
    expect(merlons).toBe(8);
    expect(at(doc, 0, 4, 0)).toBe("stone_bricks");
    expect(at(doc, 1, 4, 0)).toBe("air");
    expect(at(doc, 2, 4, 0)).toBe("stone_bricks");
    expect(run.result.changed).toBe(8);
    doc.undo();
    for (let x = 0; x <= 4; x++) for (let z = 0; z <= 4; z++) expect(at(doc, x, 4, z)).toBe("air");
  });

  it("a script that throws halfway leaves the document unchanged", async () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [0, 0, 0]), "dirt");
    const pos = doc.journal.position;
    const err = await runScript(doc, env, {
      source: `fill(sel.box([0,0,0],[3,0,0]), "stone", { as: "row" });
        select(sel.box([0,0,0],[1,1,1]), "kept");
        log("about to fail");
        throw new Error("halfway");`,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScriptError);
    expect((err as ScriptError).message).toBe("script error at line 4: halfway; nothing was changed");
    expect((err as ScriptError).log).toBe("about to fail\n");
    expect(at(doc, 0, 0, 0)).toBe("dirt");
    expect(doc.blockCount()).toBe(1);
    expect(doc.components.size).toBe(0);
    expect(doc.selections.size).toBe(0);
    expect(doc.journal.position).toBe(pos);
  });

  it("op errors reach the script, which may catch them", async () => {
    const doc = newDoc();
    const run = await runScript(doc, env, {
      source: `let msg;
        try { fill(sel.box([0,0,0],[0,0,0]), "not_a_block"); } catch (e) { msg = e.message; }
        fill(sel.box([0,0,0],[0,0,0]), "stone");
        return msg;`,
    });
    expect(run.value).toMatch(/unknown block/);
    expect(at(doc, 0, 0, 0)).toBe("stone");
  });

  it("stops scripts over the time or memory limit and reports it", async () => {
    const doc = newDoc();
    const t = await runScript(doc, env, { source: `fill(sel.box([0,0,0],[0,0,0]), "stone"); while (true) {}`, timeoutMs: 200 }).catch((e: unknown) => e);
    expect((t as ScriptError).kind).toBe("timeout");
    expect((t as ScriptError).message).toBe("script stopped: over the 0.2 s time limit; nothing was changed");
    expect(doc.blockCount()).toBe(0);
    const m = await runScript(doc, env, { source: `const a = []; while (true) a.push(new Array(100000).fill(1));`, memoryBytes: 8 * 1024 * 1024 }).catch((e: unknown) => e);
    expect((m as ScriptError).kind).toBe("memory");
    expect((m as ScriptError).message).toMatch(/over the 8 MB memory limit/);
  });

  it("has no filesystem, network or Node access", async () => {
    const doc = newDoc();
    const r = await runScript(doc, env, { source: `return [typeof require, typeof process, typeof fetch, typeof globalThis.__host, typeof XMLHttpRequest]` });
    expect(JSON.parse(r.value!)).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined"]);
  });

  it("caps log output, seeds rand(), passes args, and reads with query()", async () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [1, 0, 0]), "oak_planks", { as: "floor" });
    const src = `for (let i = 0; i < 500; i++) log("line " + i);
      return { r: [rand(), Math.random()], n: args.n, q: query([0,0,0]), s: query(sel.component("floor")).solid, c: component("floor").box, a: anchor("floor.top") };`;
    const a = await runScript(doc, env, { source: src, args: { n: 3 } });
    const b = await runScript(doc, env, { source: src, args: { n: 3 } });
    expect(a.log.length).toBeLessThan(2200);
    expect(a.log).toMatch(/log capped at 2048 chars/);
    const v = JSON.parse(a.value!);
    expect(v.r).toEqual(JSON.parse(b.value!).r);
    expect(v).toMatchObject({ n: 3, q: "minecraft:oak_planks", s: 2, c: { min: [0, 0, 0], max: [1, 0, 0] }, a: [0, 1, 0] });
    expect(a.result.changed).toBe(0);
  });

  it("sel.* compiles to the JSON trees the tools use, and generators run in scripts", async () => {
    const doc = newDoc();
    const r = await runScript(doc, env, {
      source: `const s = sel.subtract(sel.box([0,0,0],[4,0,4]), sel.cylinder([2,0,2], 1, 1));
        roof(sel.box([10,0,0],[12,0,2]), "oak_planks", { style: "hip", as: "hut_roof" });
        tower("stone_bricks", { at: [20, 0, 0], radius: 2, height: 3, roof: false });
        return s;`,
    });
    expect(JSON.parse(r.value!)).toEqual({ subtract: [{ min: [0, 0, 0], max: [4, 0, 4] }, { cylinder: { center: [2, 0, 2], radius: 1, height: 1 } }] });
    expect(r.added.sort()).toEqual(["hut_roof", "tower"]);
    expect(r.edits).toBe(2);
    expect(at(doc, 11, 2, 1)).toBe("oak_planks");
    doc.undo();
    expect(doc.blockCount()).toBe(0);
  });

  it("sel.kind and sel.tagged select components by metadata", async () => {
    const doc = newDoc();
    fill(doc, env, B([0, 0, 0], [1, 0, 0]), "oak_planks", { as: "a", kind: "hut" });
    fill(doc, env, B([5, 0, 0], [5, 0, 0]), "oak_planks", { as: "b", kind: "hut" });
    const r = await runScript(doc, env, { source: `return [sel.kind("hut").count(), sel.tagged("x").count(), sel.kind("hut").tree];` });
    expect(JSON.parse(r.value!)).toEqual([3, 0, { kind: "hut" }]);
  });

  it("generates a .d.ts from the op registry", () => {
    const d = scriptApiDts([{ name: "framed.camo", params: "sel: SelLike", returns: "EditSummary", doc: "Camo.", run: () => null }]);
    expect(d).toMatch(/declare function fill\(sel: SelLike, material: Material/);
    expect(d).toMatch(/declare function roof\(over: SelLike/);
    expect(d).toMatch(/declare const sel: \{/);
    expect(d).toMatch(/declare function rand\(\): number;/);
    expect(d).toMatch(/declare namespace framed \{\n.*\n {2}function camo\(sel: SelLike\): EditSummary;/);
  });
});
