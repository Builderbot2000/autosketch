import { describe, expect, it } from "vitest";
import { canonicalState, parseState } from "../../../src/core/blockstate.js";
import { defaultPivot, mirrorPos, rotatePos, transformBox, transformState, type MirrorAxis } from "../../../src/core/rotate.js";
import { allStates, vanillaRegistry } from "../../helpers/vanilla.js";

const registry = vanillaRegistry();
const S = (s: string) => canonicalState(s, registry).state;
const rot = (s: string, turns: number) => transformState(S(s), { turns }, { registry });
const mir = (s: string, mirror: MirrorAxis) => transformState(S(s), { mirror }, { registry });
const props = (s: string) => parseState(s).props;

const FAMILIES: [string, RegExp][] = [
  ["stairs", /_stairs$/],
  ["logs", /(_log|_wood|_stem|_hyphae|basalt|_pillar)$/],
  ["doors", /_door$/],
  ["rails", /rail$/],
  ["walls", /_wall$/],
  ["fences", /_fence$/],
  ["panes", /(_pane|_bars)$/],
  ["signs", /_sign$/],
  ["trapdoors", /_trapdoor$/],
  ["chests", /chest$/],
  ["redstone", /^minecraft:(redstone_wire|repeater|comparator|observer)$/],
  ["misc", /^minecraft:(bell|lever|jigsaw|crafter|hopper|lantern|pointed_dripstone|vine|glow_lichen|brown_mushroom_block)$/],
];
const ids = [...registry.all()].map((b) => b.id);

describe("block-state transforms (01, Orientation), exhaustive over vanilla families", () => {
  for (const [name, re] of FAMILIES) {
    const blocks = ids.filter((id) => re.test(id) && Object.keys(registry.get(id)!.properties).length);
    it(`${name}: ${blocks.length} blocks — valid results, 4 turns and double mirrors are identities`, () => {
      expect(blocks.length).toBeGreaterThan(0);
      for (const id of blocks) {
        const allowed = registry.get(id)!.properties;
        for (const s of allStates(registry, id)) {
          let r = s;
          for (let i = 0; i < 4; i++) {
            const next = transformState(r, { turns: 1 }, { registry });
            for (const [k, v] of Object.entries(props(next))) expect(allowed[k], `${next}`).toContain(v);
            if (i === 0) expect(transformState(next, { turns: 1 }, { registry })).toBe(transformState(s, { turns: 2 }, { registry }));
            r = next;
          }
          expect(r).toBe(s);
          for (const axis of ["x", "z", "y"] as const) {
            const m = transformState(s, { mirror: axis }, { registry });
            for (const [k, v] of Object.entries(props(m))) expect(allowed[k], `${m}`).toContain(v);
            if (axis !== "y" || !/ascending|orientation/.test(s)) expect(transformState(m, { mirror: axis }, { registry }), `${s} mirror ${axis}`).toBe(s);
          }
          // Mirror x then a half turn equals mirror z (both are reflections; x∘180° = z).
          if (!/rotation=/.test(s)) expect(transformState(s, { mirror: "x", turns: 2 }, { registry })).toBe(transformState(s, { mirror: "z" }, { registry }));
        }
      }
    });
  }

  it("rotates facing clockwise from above, axis on odd turns, sign rotation by 4 steps", () => {
    expect(props(rot("oak_stairs[facing=north]", 1)).facing).toBe("east");
    expect(props(rot("oak_stairs[facing=north]", 3)).facing).toBe("west");
    expect(props(rot("oak_stairs[facing=north]", -1)).facing).toBe("west");
    expect(props(rot("piston[facing=up]", 1)).facing).toBe("up");
    expect(props(rot("oak_log[axis=x]", 1)).axis).toBe("z");
    expect(props(rot("oak_log[axis=y]", 1)).axis).toBe("y");
    expect(props(rot("oak_log[axis=x]", 2)).axis).toBe("x");
    expect(props(mir("oak_log[axis=x]", "x")).axis).toBe("x");
    // 0 = south → 4 = west (clockwise from above), mirror x: west ↔ east (4 ↔ 12).
    expect(props(rot("oak_sign[rotation=0]", 1)).rotation).toBe("4");
    expect(props(rot("oak_sign[rotation=14]", 1)).rotation).toBe("2");
    expect(props(mir("oak_sign[rotation=4]", "x")).rotation).toBe("12");
    expect(props(mir("oak_sign[rotation=1]", "z")).rotation).toBe("7");
  });

  it("mirrors flip facing along the axis and swap handedness (stairs shape, door hinge, chest type)", () => {
    expect(props(mir("oak_stairs[facing=east,shape=inner_left]", "x"))).toMatchObject({ facing: "west", shape: "inner_right" });
    expect(props(mir("oak_stairs[facing=north,shape=outer_left]", "x"))).toMatchObject({ facing: "north", shape: "outer_right" });
    expect(props(rot("oak_stairs[facing=north,shape=outer_left]", 1))).toMatchObject({ facing: "east", shape: "outer_left" });
    expect(props(mir("oak_door[facing=south,hinge=left]", "z"))).toMatchObject({ facing: "north", hinge: "right" });
    expect(props(mir("oak_door[facing=east,hinge=left,half=upper]", "z"))).toMatchObject({ facing: "east", hinge: "right", half: "upper" });
    expect(props(mir("chest[facing=north,type=left]", "x"))).toMatchObject({ type: "right" });
    expect(props(rot("chest[facing=north,type=left]", 1))).toMatchObject({ facing: "east", type: "left" });
  });

  it("moves side flags, remaps rail shapes and orientations", () => {
    expect(props(rot("oak_fence[north=true,east=false,south=false,west=false]", 1))).toMatchObject({ north: "false", east: "true" });
    expect(props(rot("cobblestone_wall[north=tall,east=low,south=none,west=none,up=true]", 1))).toMatchObject({ north: "none", east: "tall", south: "low", up: "true" });
    expect(props(mir("redstone_wire[north=up,east=side,south=none,west=none]", "z"))).toMatchObject({ north: "none", south: "up", east: "side" });
    expect(props(rot("rail[shape=north_south]", 1)).shape).toBe("east_west");
    expect(props(rot("rail[shape=ascending_north]", 1)).shape).toBe("ascending_east");
    expect(props(rot("rail[shape=south_east]", 1)).shape).toBe("south_west");
    expect(props(rot("rail[shape=north_east]", 1)).shape).toBe("south_east");
    expect(props(mir("rail[shape=north_east]", "x")).shape).toBe("north_west");
    expect(props(rot("jigsaw[orientation=down_east]", 1)).orientation).toBe("down_south");
    expect(props(rot("jigsaw[orientation=east_up]", 1)).orientation).toBe("south_up");
  });

  it("y mirror flips half, slab type, face, attachment, up/down flags", () => {
    expect(props(mir("oak_stairs[half=bottom]", "y")).half).toBe("top");
    expect(props(mir("oak_trapdoor[half=top]", "y")).half).toBe("bottom");
    expect(props(mir("oak_door[half=lower]", "y")).half).toBe("upper");
    expect(props(mir("oak_slab[type=bottom]", "y")).type).toBe("top");
    expect(props(mir("oak_slab[type=double]", "y")).type).toBe("double");
    expect(props(mir("lever[face=floor]", "y")).face).toBe("ceiling");
    expect(props(mir("bell[attachment=floor]", "y")).attachment).toBe("ceiling");
    expect(props(mir("piston[facing=up]", "y")).facing).toBe("down");
    expect(props(mir("brown_mushroom_block[up=true,down=false]", "y"))).toMatchObject({ up: "false", down: "true" });
    // A value the block doesn't allow is left as it was (jigsaw has no east_down).
    expect(props(mir("jigsaw[orientation=east_up]", "y")).orientation).toBe("east_up");
    // Horizontal transforms never touch half.
    expect(props(rot("oak_stairs[half=top]", 1)).half).toBe("top");
  });

  it("keeps unknown blocks' unknown properties and lets overrides win", () => {
    expect(transformState("modx:thing[facing=north,colour=red]", { turns: 1 })).toBe("modx:thing[colour=red,facing=east]");
    expect(transformState("modx:plain", { turns: 1 })).toBe("modx:plain");
    const override = (s: string) => (s.startsWith("modx:") ? "modx:special" : undefined);
    expect(transformState("modx:thing[facing=north]", { turns: 1 }, { overrides: [override] })).toBe("modx:special");
    expect(transformState(S("oak_log[axis=x]"), { turns: 1 }, { registry, overrides: [override] })).toBe(S("oak_log[axis=z]"));
  });

  it("transforms positions and boxes about a pivot", () => {
    expect(rotatePos([1, 5, 0], 1, [0, 0, 0])).toEqual([0, 5, 1]); // east of pivot → south
    expect(rotatePos([0, 0, -1], 1, [0, 0, 0])).toEqual([1, 0, 0]); // north → east
    expect(rotatePos([3, 0, 2], 4, [1, 0, 1])).toEqual([3, 0, 2]);
    expect(mirrorPos([0, 0, 0], "x", 1.5)).toEqual([3, 0, 0]);
    const b = { min: [0, 0, 0], max: [4, 2, 2] } as const;
    expect(defaultPivot({ min: [...b.min], max: [...b.max] })).toEqual([1, 0, 0]);
    expect(transformBox({ min: [...b.min], max: [...b.max] }, (p) => rotatePos(p, 1, [1, 0, 0]))).toEqual({ min: [0, 0, -1], max: [2, 2, 3] });
  });
});
