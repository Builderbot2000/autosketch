/**
 * Checks the Axiom .bp codec against real blueprints in an instance's config/axiom/blueprints/.
 * Skipped unless AUTOSKETCH_INSTANCE is set (blueprints are the user's files, not fixtures).
 * When a .schem of the same name sits next to a .bp ("[BLUEPRINT] X.bp" / "[SCHEMATIC] X.schem",
 * or "X.bp" / "X.schem"), the two must decode to the same blocks.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeBlueprint, encodeBlueprint, packLongs, splitBlueprint, unpackLongs } from "../../src/formats/axiom.js";
import { compounds, readNbt } from "../../src/formats/nbt.js";
import type { Snapshot } from "../../src/formats/snapshot.js";
import { decodeSponge } from "../../src/formats/sponge.js";

const root = process.env.AUTOSKETCH_INSTANCE;
const dir = root && join(root, "config", "axiom", "blueprints");
const files = dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".bp")) : [];

function sameBlocks(a: Snapshot, b: Snapshot): string {
  if (a.size.join() !== b.size.join()) return `size ${a.size.join("×")} vs ${b.size.join("×")}`;
  let diff = 0;
  for (let i = 0; i < a.blocks.length; i++) if (a.palette[a.blocks[i]!] !== b.palette[b.blocks[i]!]) diff++;
  return diff ? `${diff} blocks differ` : "same";
}

describe.skipIf(!files.length)("real Axiom blueprints", () => {
  for (const f of files) {
    it(`${f}: decodes, repacks bit-exactly and round-trips`, () => {
      const buf = readFileSync(join(dir!, f));
      const d = decodeBlueprint(buf);
      let nonAir = 0;
      for (const i of d.snapshot.blocks) if (i) nonAir++;
      if (!d.header.containsAir) expect(nonAir).toBe(d.header.blockCount);

      for (const r of compounds(readNbt(splitBlueprint(buf).data).value.BlockRegion)) {
        const bs = (r.value.BlockStates as { value: Record<string, { value: unknown }> }).value;
        const n = (bs.palette!.value as { value: unknown[] }).value.length;
        const bits = Math.max(4, Math.ceil(Math.log2(n)));
        const orig = (bs.data?.value ?? []) as [number, number][];
        if (orig.length) expect(packLongs(unpackLongs(orig, bits), bits)).toEqual(orig);
      }

      expect(sameBlocks(decodeBlueprint(encodeBlueprint(d.snapshot)).snapshot, d.snapshot)).toBe("same");

      const base = f.replace(/^\[BLUEPRINT\] /, "").replace(/\.bp$/, "");
      const twin = [`[SCHEMATIC] ${base}.schem`, `${base}.schem`].map((n) => join(dir!, n)).find(existsSync);
      if (twin) expect(sameBlocks(d.snapshot, decodeSponge(readFileSync(twin)).snapshot)).toBe("same");
    }, 120_000);
  }
});
