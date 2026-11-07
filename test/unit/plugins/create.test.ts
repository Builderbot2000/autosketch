import { describe, expect, it } from "vitest";
import { buildFamilies } from "../../../src/palette/families.js";
import { create, createdeco } from "../../../src/plugins/create.js";
import type { AutosketchPlugin } from "../../../src/plugins/types.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";

/** Synthetic registry named like Create 6 / Create Deco 2 (no assets involved). */
const reg = fakeRegistry([
  { id: "create:andesite_casing", tags: ["minecraft:mineable/axe"] },
  { id: "create:brass_block" },
  partial("create:brass_bars"),
  partial("create:brass_door"),
  partial("create:metal_girder"),
  { id: "create:linear_chassis" },
  { id: "create:gearshift" },
  { id: "createdeco:zinc_sheet_metal" },
  { id: "createdeco:zinc_hull" },
  partial("createdeco:zinc_door"),
  partial("createdeco:zinc_trapdoor"),
  partial("createdeco:zinc_bars"),
  partial("createdeco:zinc_mesh_fence"),
  partial("createdeco:zinc_catwalk"),
  { id: "createdeco:zinc_window" },
  { id: "createdeco:dusk_bricks" },
  { id: "createdeco:corner_dusk_bricks" },
  { id: "createdeco:mossy_dusk_bricks" },
  { id: "createdeco:long_dusk_bricks" },
  { id: "minecraft:bricks" },
  { id: "createdeco:corner_red_bricks" },
  { id: "createdeco:blue_shipping_container", faceTextures: { north: "createdeco:block/front", south: "createdeco:block/side", east: "createdeco:block/side", west: "createdeco:block/side" } },
]);
const fam = (fs: ReturnType<typeof buildFamilies>["families"], id: string) => fs.find((f) => f.id === id);

describe("create and createdeco plugins", () => {
  const plugins = [create, createdeco];
  const { families } = buildFamilies(reg, plugins);

  it("classifies casings as buildable metal and full-cube machines as non-buildable", () => {
    expect(fam(families, "create:andesite_casing")).toMatchObject({ category: "metal", buildable: true });
    expect(fam(families, "create:linear_chassis")).toMatchObject({ buildable: false, excludedBy: "plugin:create" });
    expect(fam(families, "create:gearshift")).toMatchObject({ buildable: false, excludedBy: "plugin:create" });
  });

  it("makes girders a buildable family although they are partial blocks", () => {
    expect(fam(families, "create:metal_girder")).toMatchObject({ category: "metal", buildable: true });
  });

  it("attaches metal bars as panes of their metal block", () => {
    expect(fam(families, "create:brass_block")!.shapes).toEqual({ pane: "create:brass_bars", door: "create:brass_door" });
  });

  it("groups a Create Deco metal set under its sheet metal", () => {
    const zinc = fam(families, "createdeco:zinc_sheet_metal")!;
    expect(zinc.shapes).toEqual({ door: "createdeco:zinc_door", trapdoor: "createdeco:zinc_trapdoor", pane: "createdeco:zinc_bars", fence: "createdeco:zinc_mesh_fence" });
    expect(zinc.variants.map((v) => v.base)).toEqual(["createdeco:zinc_hull"]);
    expect(zinc.category).toBe("metal");
    expect(fam(families, "createdeco:zinc_hull")).toBeUndefined();
    expect(fam(families, "createdeco:zinc_window")).toBeDefined(); // windows stay glass families
  });

  it("groups brick corners and weathering under the colour, keeping long/short/tiled apart", () => {
    expect(fam(families, "createdeco:dusk_bricks")!.variants.map((v) => v.base)).toEqual(["createdeco:corner_dusk_bricks", "createdeco:mossy_dusk_bricks"]);
    expect(fam(families, "createdeco:long_dusk_bricks")).toBeDefined();
    expect(fam(families, "minecraft:bricks")!.variants.map((v) => v.base)).toEqual(["createdeco:corner_red_bricks"]);
  });

  it("keeps shipping containers as building blocks despite their front face", () => {
    expect(fam(families, "createdeco:blue_shipping_container")!.buildable).toBe(true);
  });

  it("changes nothing without the plugins (generic rules only)", () => {
    const plain = buildFamilies(reg, []).families;
    expect(fam(plain, "create:metal_girder")).toBeUndefined();
    expect(fam(plain, "create:andesite_casing")!.category).toBe("wood");
    expect(fam(plain, "createdeco:zinc_hull")).toBeDefined();
  });
});

describe("family hints (generic)", () => {
  it("ignores unknown ids, bad shape kinds and blocks already heading a family", () => {
    const hinter: AutosketchPlugin = {
      id: "h",
      namespaces: ["m"],
      families: () => [
        { base: "m:missing", shapes: { stairs: "m:a" } },
        { base: "m:a", shapes: { roof: "m:b_part", stairs: "m:c", slab: "m:nope" }, buildable: false },
      ],
    };
    const r = fakeRegistry([{ id: "m:a" }, partial("m:b_part"), { id: "m:c" }]);
    const { families } = buildFamilies(r, [hinter]);
    expect(fam(families, "m:a")).toMatchObject({ shapes: {}, buildable: false, excludedBy: "plugin:h" });
    expect(fam(families, "m:c")).toBeDefined();
  });
});
