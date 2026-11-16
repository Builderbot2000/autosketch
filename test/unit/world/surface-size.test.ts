import { describe, expect, it } from "vitest";
import { encodeMessage } from "../../../src/world/protocol/codec.js";
import type { SurfaceResult } from "../../../src/world/protocol/messages.js";

/**
 * The surface of the largest scan, 25×25 chunks (13, B4: `scanChunksMax` 12), stays small on the
 * wire. Synthetic terrain: rolling heights around y 64–140 over 24 surface states, with a ceiling
 * layer, so every varint and palette index is realistic. The bound is recorded in 13 (*Measured*).
 */
describe("surface snapshot size (13, B4)", () => {
  it("a 25×25-chunk surface with ceilings encodes under 1 MB, without under 512 KB (measured: 481 KB and 928 KB)", () => {
    const side = 25 * 16, n = side * side;
    const palette = Array.from({ length: 24 }, (_, i) => `minecraft:block_${i}`);
    const layer = (base: number) => {
      const heights = new Uint32Array(n), states = new Uint32Array(n);
      for (let i = 0; i < n; i++) {
        const x = i % side, z = Math.floor(i / side);
        heights[i] = base + Math.round(38 * (1 + Math.sin(x / 23) * Math.cos(z / 31))) + ((x * 7 + z * 13) % 5);
        states[i] = (x * 31 + z * 17) % palette.length;
      }
      return { heights, states };
    };
    const m = (ceilings: boolean): SurfaceResult => ({
      type: "snapshot.result",
      id: 1,
      dimension: "minecraft:overworld",
      kind: "surface",
      columns: { min: [-200, -200], max: [199, 199] },
      minY: -64,
      ...(ceilings ? { ceiling: 40 } : {}),
      missing: [],
      palette,
      surface: layer(128),
      ...(ceilings ? { ceilings: layer(105) } : {}),
    });
    const plain = encodeMessage(m(false)).length, both = encodeMessage(m(true)).length;
    expect(plain).toBeLessThan(512_000);
    expect(both).toBeLessThan(1_000_000);
  });
});
