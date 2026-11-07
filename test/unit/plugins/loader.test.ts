import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describeParams, findAction, formatActionList, listActions } from "../../../src/plugins/actions.js";
import { BUILTIN_PLUGINS } from "../../../src/plugins/builtin.js";
import { checkPlugin, loadPluginDir, mergePlugins } from "../../../src/plugins/loader.js";
import { validateNbt, type AutosketchPlugin } from "../../../src/plugins/types.js";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-plugins-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("third-party plugin loading", () => {
  it("returns nothing for a missing folder", async () => {
    expect(await loadPluginDir(join(tempDir(), "nope"))).toEqual({ plugins: [], warnings: [] });
  });

  it("loads object, array and factory exports in file order, skipping bad ones with warnings", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.js"), `export default { id: "alpha", namespaces: ["alphamod"], classify: () => ({ buildable: false }) };`);
    writeFileSync(join(dir, "b.mjs"), `export default [{ id: "beta", namespaces: ["betamod"] }, { id: "Bad Id", namespaces: ["x"] }];`);
    writeFileSync(
      join(dir, "c.js"),
      `export default ({ z }) => ({ id: "gamma", namespaces: ["gammamod"], actions: { paint: { description: "Repaints.", params: z.object({ sel: z.string(), color: z.enum(["red", "blue"]).optional() }), run: () => ({ op: "gamma.paint", seq: 0, changed: 0, warnings: [] }) } } });`,
    );
    writeFileSync(join(dir, "d.js"), `throw new Error("boom");`);
    writeFileSync(join(dir, "e.js"), `export default { id: "alpha", namespaces: ["dup"] };`);
    writeFileSync(join(dir, "notes.txt"), `ignored`);
    const { plugins, warnings } = await loadPluginDir(dir);
    expect(plugins.map((p) => p.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(plugins.every((p) => /^[0-9a-f]{12}$/.test(p.cacheKey!))).toBe(true);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/b\.mjs: id must be/);
    expect(warnings[1]).toMatch(/d\.js: failed to load \(boom\)/);
    expect(warnings[2]).toMatch(/e\.js: id "alpha" already loaded/);
    expect(formatActionList(plugins)).toBe("1 plugin op:\ngamma.paint(sel: string, color?: red|blue) — Repaints.");
  });

  it("lets a third-party plugin replace a built-in one by id", () => {
    const mine: AutosketchPlugin = { id: "chipped", namespaces: ["chipped"] };
    const { plugins, warnings } = mergePlugins(BUILTIN_PLUGINS, [mine]);
    expect(plugins.filter((p) => p.id === "chipped")).toEqual([mine]);
    expect(plugins).toHaveLength(BUILTIN_PLUGINS.length);
    expect(warnings).toEqual(['plugin "chipped" from the plugins folder replaces the built-in one']);
  });

  it("checks plugin shape", () => {
    expect(checkPlugin(null)).toMatch(/not a plugin/);
    expect(checkPlugin({ id: "x", namespaces: [] })).toMatch(/namespaces/);
    expect(checkPlugin({ id: "x", namespaces: ["x"], render: 3 })).toMatch(/render must be a function/);
    expect(checkPlugin({ id: "x", namespaces: ["x"], actions: { go: { description: "d", run() {}, params: {} } } })).toMatch(/zod schema/);
    expect(checkPlugin({ id: "x", namespaces: ["x"], actions: { go: { description: "d", run() {}, params: z.object({}) } } })).toBeUndefined();
  });
});

describe("plugin actions and checks", () => {
  const run = () => ({ op: "x", seq: 0, changed: 0, warnings: [] });
  const framed: AutosketchPlugin = {
    id: "framed",
    namespaces: ["framedblocks"],
    actions: {
      camo: { description: "Re-skins framed blocks. ~50 tokens.", params: z.object({ sel: z.unknown(), camo: z.string() }), run },
      shape: { description: "Places framed shapes.", params: z.object({ sel: z.unknown(), shape: z.string(), camo: z.string().optional() }), run },
    },
    validateNbt: (_s, nbt) => (nbt ? [] : ["no camo"]),
  };
  const other: AutosketchPlugin = { id: "other", namespaces: ["othermod"], validateNbt: () => { throw new Error("bad"); } };

  it("lists ops by plugin id or namespace", () => {
    expect(listActions([framed, other]).map((a) => a.op)).toEqual(["framed.camo", "framed.shape"]);
    expect(listActions([framed, other], "framedblocks")).toHaveLength(2);
    expect(listActions([framed, other], "othermod")).toEqual([]);
    expect(findAction([framed], "framed.shape")?.action).toBe(framed.actions!.shape);
    expect(formatActionList([framed, other], "othermod")).toBe('No plugin ops for "othermod" (active plugins: framed, other).');
  });

  it("describes params compactly", () => {
    expect(describeParams(z.object({ sel: z.unknown(), shape: z.string(), n: z.number().int().optional() }))).toBe("sel, shape: string, n?: integer");
  });

  it("collects NBT warnings and survives a failing check", () => {
    expect(validateNbt([framed, other], "framedblocks:framed_cube", undefined)).toEqual(["framed: no camo", "other: validateNbt failed (bad)"]);
  });
});
