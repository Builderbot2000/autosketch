import { describe, expect, it } from "vitest";
import { Document } from "../../../src/document/document.js";
import { BUILTIN_PLUGINS } from "../../../src/plugins/builtin.js";
import { activePlugins } from "../../../src/plugins/types.js";
import { scriptApiDts } from "../../../src/script/dts.js";
import { pluginScriptOps } from "../../../src/script/plugins.js";
import { runScript, ScriptError } from "../../../src/script/run.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";

const registry = fakeRegistry([{ id: "minecraft:stone" }, { id: "minecraft:andesite" }, partial("framedblocks:framed_slope"), partial("framedblocks:framed_slab"), { id: "framedblocks:framed_cube" }]);
const plugins = activePlugins(BUILTIN_PLUGINS, registry);
const env = { registry, plugins };
const newDoc = () => Document.create({ name: "p", dataVersion: 3955, seed: 3 });

describe("plugin actions in scripts (05 Mod actions)", () => {
  it("runs framed.shape inside the script's single journal entry", async () => {
    const doc = newDoc();
    const pos = doc.journal.position;
    const r = await runScript(doc, env, {
      ops: pluginScriptOps(plugins),
      source: `const a = framed.shape({ sel: sel.box([0,0,0],[2,0,0]), shape: "slope", camo: "stone", state: "facing=east,type=top" });
        fill(sel.box([0,1,0],[0,1,0]), "andesite");
        return a.changed;`,
    });
    expect(r.value).toBe("3");
    expect(doc.journal.position).toBe(pos + 1);
    expect(doc.getState(1, 0, 0)).toBe("framedblocks:framed_slope[facing=east,type=top]");
    expect(doc.getBlockEntity(1, 0, 0)).toBeDefined();
    doc.undo();
    expect(doc.blockCount()).toBe(0);
    expect(doc.getBlockEntity(1, 0, 0)).toBeUndefined();
  });

  it("bad plugin arguments throw into the script, and an uncaught one rolls back", async () => {
    const doc = newDoc();
    const err = await runScript(doc, env, { ops: pluginScriptOps(plugins), source: `fill(sel.box([5,0,0],[5,0,0]), "stone"); framed.shape({ sel: "all" });` }).catch((e: unknown) => e);
    expect((err as ScriptError).message).toMatch(/bad arguments for framed.shape: shape/);
    expect(doc.blockCount()).toBe(0);
  });

  it("appear in the generated .d.ts with typed args", () => {
    expect(scriptApiDts(pluginScriptOps(plugins))).toMatch(/declare namespace framed \{[\s\S]*function shape\(args: \{ sel: SelLike;[^}]*shape: string/);
  });
});
