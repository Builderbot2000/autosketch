import { afterAll, describe, expect, it } from "vitest";
import { rm } from "node:fs/promises";
import { Document } from "../../../src/document/document.js";
import { snapshotOf } from "../../../src/formats/snapshot.js";
import { loadPrefab, savePrefab, type Prefab } from "../../../src/library/prefabs.js";
import { setBlocks } from "../../../src/ops/edit.js";
import { scriptApiDts } from "../../../src/script/dts.js";
import { stampLiterals, type PrefabSource } from "../../../src/script/prefabs.js";
import { runScript, ScriptError } from "../../../src/script/run.js";
import { tempDir } from "../../helpers/fixtures.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

/** stamp inside scripts (05 Scripting; 07 stamp): prefabs load before the run, stamping is sync. */

const registry = vanillaRegistry();
const env = { registry };
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function library(): Promise<{ source: PrefabSource; resolved: string[] }> {
  const d = await tempDir("autosketch-script-stamp-");
  dirs.push(d);
  const src = Document.create({ name: "src", dataVersion: 3955 });
  setBlocks(src, env, [
    { pos: [0, 0, 0], block: "minecraft:stone_bricks" },
    { pos: [1, 0, 0], block: "minecraft:stone_bricks" },
    { pos: [1, 1, 0], block: "minecraft:oak_stairs[facing=east,half=bottom]" },
  ]);
  const root = { path: d, label: "user", kind: "library" as const, readOnly: false };
  const { prefab } = await savePrefab([root], snapshotOf(src), { name: "step", anchors: { base: [0, 0, 0] } });
  const all: Record<string, Prefab> = { step: prefab };
  const resolved: string[] = [];
  return {
    resolved,
    source: {
      resolve: async (ref) => {
        resolved.push(ref);
        const p = all[ref];
        if (!p) throw new Error(`no prefab "${ref}"`);
        return p;
      },
      load: (p) => loadPrefab(p, registry),
    },
  };
}

describe("stamp in scripts", () => {
  it("finds string-literal names", () => {
    expect(stampLiterals(`stamp("hut", {}); stamp( 'a b' ,{}); x.stamp(\`t\`); unstamp("no"); stamp(name)`)).toEqual(["hut", "a b", "t"]);
  });

  it("stamps loaded prefabs inside the run's single journal entry, turned like the tool", async () => {
    const { source, resolved } = await library();
    const doc = Document.create({ name: "d", dataVersion: 3955, seed: 1 });
    const pos = doc.journal.position;
    const run = await runScript(doc, env, {
      prefabs: source,
      source: `const a = stamp("step", { at: [0, 0, 0] });
        const b = stamp("step", { at: [10, 0, 0], rotate: 90, as: "turned" });
        for (let i = 0; i < 3; i++) stamp("step", { at: [0, 0, 5 + 2 * i] });
        return [a.component, b.component, a.changed];`,
    });
    expect(JSON.parse(run.value!)).toEqual(["step", "turned", 3]);
    expect(resolved).toEqual(["step"]); // loaded once, before the run
    expect(doc.journal.position).toBe(pos + 1);
    expect(run.edits).toBe(5);
    expect(doc.getState(1, 1, 0)).toBe("minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]");
    expect(doc.getState(10, 1, 1)).toMatch(/^minecraft:oak_stairs\[facing=south/);
    expect(doc.getState(1, 0, 9)).toBe("minecraft:stone_bricks");
    expect(run.added.sort()).toEqual(["step", "step_2", "step_3", "step_4", "turned"]);
    doc.undo();
    expect(doc.blockCount()).toBe(0);
    expect(doc.components.size).toBe(0);
  });

  it("names computed at run time need preload; a failing stamp rolls the whole run back", async () => {
    const { source } = await library();
    const doc = Document.create({ name: "d", dataVersion: 3955, seed: 1 });
    const computed = `const n = ["st", "ep"].join(""); return stamp(n, { at: [0, 0, 0] }).changed;`;
    const err = await runScript(doc, env, { prefabs: source, source: computed }).catch((e: unknown) => e);
    expect((err as ScriptError).message).toMatch(/prefab "step" wasn't loaded before the run/);
    const ok = await runScript(doc, env, { prefabs: source, preload: ["step"], source: computed });
    expect(ok.value).toBe("3");
    doc.undo();
    // a literal that doesn't resolve fails only when stamped, and rolls back earlier writes
    const bad = await runScript(doc, env, { prefabs: source, source: `stamp("step", { at: [0, 0, 0] }); // stamp("ghost")\nreturn 1;` });
    expect(bad.value).toBe("1");
    doc.undo();
    const fail = await runScript(doc, env, { prefabs: source, source: `stamp("step", { at: [0, 0, 0] }); stamp("ghost", { at: [5, 0, 0] });` }).catch((e: unknown) => e);
    expect((fail as ScriptError).message).toMatch(/no prefab "ghost"/);
    expect(doc.blockCount()).toBe(0);
    // without a prefab source, stamp explains itself
    const none = await runScript(doc, env, { source: `stamp("step", { at: [0, 0, 0] });` }).catch((e: unknown) => e);
    expect((none as ScriptError).message).toMatch(/wasn't loaded before the run/);
  });

  it("is declared in the API reference", () => {
    expect(scriptApiDts()).toMatch(/declare function stamp\(prefab: string, opts: StampOpts\): EditSummary;/);
    expect(scriptApiDts()).toMatch(/type StampOpts = \{ at: At;/);
  });
});
