/**
 * Runs against a real instance (Craftoria is the reference). Skipped unless AUTOSKETCH_INSTANCE is set,
 * since game and mod assets can't be redistributed as fixtures.
 *
 *   AUTOSKETCH_INSTANCE=/mnt/c/Users/<you>/curseforge/minecraft/Instances/Craftoria npm run test:local
 */
import { describe, expect, it } from "vitest";
import { locateInstance } from "../../src/assets/locate.js";
import { openStack } from "../../src/assets/pack.js";
import { loadRegistry } from "../../src/assets/registry.js";

const root = process.env.AUTOSKETCH_INSTANCE;

describe.skipIf(!root)("real instance", () => {
  it("locates and opens the full pack stack", async () => {
    const info = await locateInstance(root!);
    const { stack, warnings, stats } = await openStack(info);
    console.log(`${info.name} ${info.mcVersion} ${info.loader?.name ?? "vanilla"}:`, stats);
    if (warnings.length) console.log("warnings:\n  " + warnings.join("\n  "));

    expect(stats.layers).toBeGreaterThan(0);
    expect(stats.ms).toBeLessThan(60_000);
    expect(stack.has("assets/minecraft/blockstates/stone.json")).toBe(true);
    expect(stack.has("assets/minecraft/textures/block/stone.png")).toBe(true);
    const blockstates = stack.list("assets/", ".json").filter((p) => /^assets\/[^/]+\/blockstates\//.test(p));
    expect(blockstates.length).toBeGreaterThan(1000);

    const t = Date.now();
    const { registry, cached } = await loadRegistry(stack, { mcVersion: info.mcVersion });
    const all = [...registry.all()];
    const count = (shape: string) => all.filter((b) => b.shape === shape).length;
    console.log(`registry: ${registry.size} blocks (${cached ? "cached" : "built"} in ${Date.now() - t} ms);`,
      `full ${count("full")}, partial ${count("partial")}, none ${count("none")}`);
    if (registry.data.warnings.length) console.log("registry warnings:\n  " + registry.data.warnings.join("\n  "));

    expect(registry.get("minecraft:oak_stairs")?.defaults).toMatchObject({ facing: "north", half: "bottom" });
    expect(registry.get("minecraft:stone")?.shape).toBe("full");
    expect(registry.withTag("minecraft:logs").length).toBeGreaterThan(10);
  });
});
