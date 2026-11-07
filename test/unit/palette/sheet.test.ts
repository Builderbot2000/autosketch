import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { deflateSync } from "node:zlib";
import { colorName, hexToRgb, labToRgb, rgbToLab } from "../../../src/palette/color.js";
import { Image, repackPng } from "../../../src/palette/image.js";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { describePalette, PaletteBook, pickPalette, resolveRole } from "../../../src/palette/pick.js";
import { columnLabel, layoutSheet, parseCell, parseRange, SheetRenderer } from "../../../src/palette/sheet.js";
import { textureStats } from "../../../src/palette/textures.js";
import { BUILTIN_PLUGINS } from "../../../src/plugins/builtin.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry, partial } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

describe("color", () => {
  it("round-trips sRGB ↔ Lab and names colours", () => {
    for (const hex of ["#ffffff", "#000000", "#b02e26", "#3c44aa", "#7f7f7f"]) {
      const rgb = hexToRgb(hex);
      expect(labToRgb(rgbToLab(rgb))).toEqual(rgb);
    }
    expect(colorName(rgbToLab([250, 250, 250]))).toBe("white");
    expect(colorName(rgbToLab([0x83, 0x54, 0x32]))).toBe("brown");
    expect(colorName(rgbToLab([0x3c, 0x44, 0xaa]))).toBe("blue");
  });
});

describe("image", () => {
  it("measures flat vs noisy textures", () => {
    const flat = Image.decodePng(Buffer.from(solidPng([120, 120, 120])));
    const noisy = Image.decodePng(Buffer.from(solidPng([200, 200, 200], 4, [40, 40, 40])));
    expect(textureStats(flat).noise).toBe(0);
    expect(textureStats(noisy).noise).toBeGreaterThan(30);
    expect(textureStats(flat).rgb).toEqual([120, 120, 120]);
  });

  it("repairs PNGs with trailing bytes after the zlib stream", () => {
    const good = Buffer.from(solidPng([10, 20, 30]));
    // Rebuild with junk appended to the IDAT payload.
    const png = PNG.sync.read(good);
    const raw = Buffer.alloc((png.width * 4 + 1) * png.height);
    for (let y = 0; y < png.height; y++) png.data.copy(raw, y * (png.width * 4 + 1) + 1, y * png.width * 4, (y + 1) * png.width * 4);
    const idat = Buffer.concat([deflateSync(raw), Buffer.from([1, 2, 3, 4])]);
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
    };
    const ihdr = good.subarray(16, 29);
    const broken = Buffer.concat([good.subarray(0, 8), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
    expect(() => PNG.sync.read(broken)).toThrow();
    expect(Image.decodePng(broken).get(1, 1)).toEqual([10, 20, 30, 255]);
    expect(repackPng(broken).length).toBeGreaterThan(0);
  });
});

describe("cell ids", () => {
  it("labels and parses columns like a chessboard", () => {
    expect([0, 25, 26, 31].map(columnLabel)).toEqual(["A", "Z", "AA", "AF"]);
    expect(parseCell("af12")).toEqual({ col: 31, row: 12 });
    expect(parseRange("B2:C3")).toEqual([{ col: 1, row: 2 }, { col: 2, row: 2 }, { col: 1, row: 3 }, { col: 2, row: 3 }]);
    expect(() => parseCell("12")).toThrow(/bad cell/);
  });
});

const DYES = ["white", "light_gray", "gray", "black", "brown", "red", "orange", "yellow", "lime", "green", "cyan", "light_blue", "blue", "purple", "magenta", "pink"];
const COLORS: Record<string, [number, number, number]> = {
  andesite: [130, 130, 130], red_sandstone: [180, 95, 40], oak_planks: [160, 130, 80], blue_ice: [120, 160, 230], marble: [235, 235, 230],
};

async function fixture() {
  const reg = fakeRegistry([
    { id: "minecraft:andesite", tags: ["c:stones"] },
    partial("minecraft:andesite_stairs"),
    partial("minecraft:andesite_slab"),
    { id: "minecraft:red_sandstone" },
    partial("minecraft:red_sandstone_stairs"),
    { id: "minecraft:oak_planks", tags: ["minecraft:planks"] },
    partial("minecraft:oak_stairs"),
    { id: "minecraft:blue_ice" },
    { id: "mod:marble" }, // no shapes → not on the overview
    ...DYES.map((d) => ({ id: `minecraft:${d}_wool` })),
  ]);
  const files: Record<string, Uint8Array> = {};
  for (const [n, c] of Object.entries(COLORS)) files[`assets/${n === "marble" ? "mod" : "minecraft"}/textures/block/${n}.png`] = solidPng(c);
  DYES.forEach((d, i) => (files[`assets/minecraft/textures/block/${d}_wool.png`] = solidPng([i * 15, 100, 200 - i * 10])));
  const stack = await memStack([["base", "base", files]]);
  const index = new PaletteIndex(await buildPaletteIndexData(stack, reg, { plugins: BUILTIN_PLUGINS }), reg);
  return { reg, stack, index };
}

describe("sheets", () => {
  it("lays out the overview by category with series collapsed, deterministically", async () => {
    const { index } = await fixture();
    const l = layoutSheet(index, { sheet: "overview" });
    const ids = l.cells.flat().filter(Boolean).map((c) => (c!.kind === "variant" ? c!.block : c!.id));
    expect(ids).toContain("minecraft:*_wool");
    expect(ids).not.toContain("mod:marble");
    expect(ids).not.toContain("minecraft:red_wool");
    expect(l.bands.map((b) => b.category)).toEqual(["stone", "wood", "colored"]);
    expect(layoutSheet(index, { sheet: "overview" })).toEqual(l);
    expect(layoutSheet(index, { sheet: "all" }).total).toBe(l.total + 2); // + marble, blue_ice
    expect(() => layoutSheet(index, { sheet: "overview", page: 2 })).toThrow(/1 page/);
    expect(layoutSheet(index, { sheet: "filter:has:stairs mod:minecraft" }).total).toBe(3);
  });

  it("renders a PNG with a caption, and lists cells on small sheets", async () => {
    const { index, stack } = await fixture();
    const r = new SheetRenderer(index, stack);
    const s = await r.render({ sheet: "overview" });
    const png = PNG.sync.read(s.png);
    expect([png.width, png.height]).toEqual([s.width, s.height]);
    expect(s.caption).toMatch(/rows: 1-1 stone/);
    expect(s.caption).not.toMatch(/minecraft: A1/); // overview never lists cells

    const series = await r.render({ sheet: "series:minecraft:*_wool" });
    expect(series.caption).toMatch(/A1 white_wool/);
    const zoom = await r.render({ sheet: "overview", zoom: "A1:B1" });
    expect(zoom.caption).toMatch(/A1 \w+/);
  });
});

describe("palette_pick", () => {
  it("assigns cell ranges to roles and resolves shapes", async () => {
    const { index } = await fixture();
    const l = layoutSheet(index, { sheet: "overview" });
    const find = (id: string) => {
      for (let r = 0; r < l.rows; r++)
        for (let c = 0; c < l.columns; c++) {
          const cell = l.cells[r]![c];
          if (cell && cell.kind !== "variant" && cell.id === id) return `${columnLabel(c)}${r + l.rowOffset}`;
        }
      throw new Error(`not on sheet: ${id}`);
    };
    const { palette, summary, warnings } = pickPalette(index, {
      sheet: "overview",
      name: "test",
      roles: { wall: [find("minecraft:andesite"), find("minecraft:red_sandstone")], roof: find("minecraft:oak_planks"), accent: find("minecraft:*_wool") },
    });
    expect(warnings).toEqual([]);
    expect(palette.roles.wall!.map((m) => [m.block, m.weight])).toEqual([["minecraft:andesite", 0.5], ["minecraft:red_sandstone", 0.5]]);
    expect(palette.roles.accent).toHaveLength(16);
    expect(summary).toMatch(/wall: minecraft:andesite 50% \(grey\)/);

    expect(resolveRole(index, palette, "wall", "stairs").entries.map((e) => e.block)).toEqual(["minecraft:andesite_stairs", "minecraft:red_sandstone_stairs"]);
    const slab = resolveRole(index, palette, "wall", "slab");
    expect(slab.entries.map((e) => e.block)).toEqual(["minecraft:andesite_slab"]);
    expect(slab.skipped).toEqual(["minecraft:red_sandstone"]);

    const book = new PaletteBook();
    book.set(palette);
    expect(book.resolveMaterial(index, "palette:test.roof", "stairs").expression).toBe("minecraft:oak_stairs");
    expect(book.resolveMaterial(index, "palette:test.wall").expression).toBe("minecraft:andesite 50%, minecraft:red_sandstone 50%");
    expect(() => book.resolveMaterial(index, "palette:test.roof", "wall")).toThrow(/no blocks available/);
    expect(() => book.resolveMaterial(index, "palette:nope.wall")).toThrow(/no palette "nope"/);
    expect(describePalette(index, palette)).toMatch(/palette:test/);
  });

  it("rejects bad names and reports empty cells", async () => {
    const { index } = await fixture();
    expect(() => pickPalette(index, { sheet: "overview", name: "bad name", roles: {} })).toThrow(/palette name/);
    const r = pickPalette(index, { sheet: "overview", name: "x", roles: { wall: "AF30" } });
    expect(r.warnings.join()).toMatch(/AF30 is empty|no materials/);
  });
});
