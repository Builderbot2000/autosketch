import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Registry } from "../../src/assets/registry.js";
import { formatState } from "../../src/core/blockstate.js";
import { fakeRegistry } from "./registry.js";

/** Rough partial-shape test (the vanilla data has no shapes); full blocks give fences a sturdy face. */
const PARTIAL = /(stairs|slab|fence|fence_gate|wall|pane|bars|door|trapdoor|button|torch|sign|rail|carpet|pressure_plate|lantern|chain|ladder|redstone_wire|bed|chest|leaves|air)$/;

/** Registry of every vanilla 1.21.1 block with exact properties and defaults (from data/vanilla). */
export function vanillaRegistry(extraTags: Record<string, string[]> = {}): Registry {
  const j = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "data", "vanilla", "1.21.1.json"), "utf8")) as {
    blocks: Record<string, { props?: Record<string, string[]>; def?: Record<string, string>; transparent?: boolean; noCollision?: boolean }>;
  };
  return fakeRegistry(
    Object.entries(j.blocks).map(([id, b]) => ({
      id,
      properties: b.props ?? {},
      defaults: b.def ?? {},
      exactProperties: true,
      tags: extraTags[id] ?? [],
      ...(PARTIAL.test(id) ? { shape: "partial" as const } : {}),
    })),
  );
}

/** Every state of a block, as canonical strings. */
export function allStates(registry: Registry, id: string): string[] {
  const b = registry.get(id)!;
  let out: Record<string, string>[] = [{}];
  for (const [k, vs] of Object.entries(b.properties)) out = out.flatMap((p) => vs.map((v) => ({ ...p, [k]: v })));
  return out.map((p) => formatState(b.id, p));
}
