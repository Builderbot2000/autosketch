import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Document } from "../../../src/document/document.js";
import { runPluginActionSync } from "../../../src/ops/plugin-actions.js";
import { BUILTIN_PLUGINS } from "../../../src/plugins/builtin.js";
import { activePlugins, type AutosketchPlugin, type PluginActionContext } from "../../../src/plugins/types.js";
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

  it("runPluginActionSync: one entry, refuses async actions and late writes; scripts use it", async () => {
    let leaked: PluginActionContext | undefined;
    const test: AutosketchPlugin = {
      id: "t",
      namespaces: ["t"],
      actions: {
        put: { description: "put", params: z.object({ x: z.number() }), run: (ctx, a) => ctx.edit("put", (tx) => tx.set((a as { x: number }).x, 0, 0, tx.intern("minecraft:stone"))) },
        later: { description: "later", params: z.object({}), run: async (ctx) => ctx.edit("later", () => undefined) },
        leak: { description: "leak", params: z.object({}), run: (ctx) => ((leaked = ctx), ctx.edit("leak", () => undefined)) },
      },
    };
    const env2 = { registry, plugins: [test] };
    const doc = newDoc();
    const pos = doc.journal.position;
    const r = runPluginActionSync(doc, env2, "t.put", { x: 2 });
    expect(r.changed).toBe(1);
    expect(doc.journal.position).toBe(pos + 1);
    expect(doc.getState(2, 0, 0)).toBe("minecraft:stone");
    expect(() => runPluginActionSync(doc, env2, "t.put", {})).toThrow(/bad arguments for t.put: x/);
    expect(() => runPluginActionSync(doc, env2, "t.later", {})).toThrow(/t.later is asynchronous/);
    runPluginActionSync(doc, env2, "t.leak", {});
    expect(() => leaked!.edit("late", () => undefined)).toThrow(/t.leak wrote after its call returned/);
    // in a script: the async one throws into the script, and the run rolls back
    const err = await runScript(doc, env2, { ops: pluginScriptOps([test]), source: `t.put({ x: 4 }); t.later({});` }).catch((e: unknown) => e);
    expect((err as ScriptError).message).toMatch(/t.later is asynchronous/);
    expect(doc.getState(4, 0, 0)).toBe("minecraft:air");
  });

  it("appear in the generated .d.ts with typed args", () => {
    expect(scriptApiDts(pluginScriptOps(plugins))).toMatch(/declare namespace framed \{[\s\S]*function shape\(args: \{ sel: SelLike;[^}]*shape: string/);
  });
});
