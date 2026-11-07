/**
 * Runs against a real instance (Craftoria is the reference). Skipped unless AUTOSKETCH_INSTANCE is set,
 * since game and mod assets can't be redistributed as fixtures.
 *
 *   AUTOSKETCH_INSTANCE=/mnt/c/Users/<you>/curseforge/minecraft/Instances/Craftoria npm run test:local
 */
import { describe, expect, it } from "vitest";
import { locateInstance } from "../../src/assets/locate.js";
import { openStack } from "../../src/assets/pack.js";

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
  });
});
