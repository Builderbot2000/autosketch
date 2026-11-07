import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { biomeClimate, colormapPixel } from "../../../src/assets/biomes.js";
import { BufferByteSource } from "../../../src/assets/bytes.js";
import { PackStack, ZipPackSource } from "../../../src/assets/pack.js";
import { ZipArchive } from "../../../src/assets/zip.js";
import { TextureLoader, Tinter } from "../../../src/palette/textures.js";
import { makeZip } from "../../helpers/fixtures.js";

/** A synthetic 256×256 colormap whose pixel at (x, y) is rgb(x, y, base). */
function gradient(base: number): Buffer {
  const png = new PNG({ width: 256, height: 256 });
  for (let y = 0; y < 256; y++)
    for (let x = 0; x < 256; x++) {
      const i = (y * 256 + x) * 4;
      png.data[i] = x;
      png.data[i + 1] = y;
      png.data[i + 2] = base;
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
}

async function tinter(biome?: string): Promise<Tinter> {
  const zip = makeZip({ "assets/minecraft/textures/colormap/grass.png": gradient(1), "assets/minecraft/textures/colormap/foliage.png": gradient(2) });
  const stack = new PackStack([new ZipPackSource("base", "base", await ZipArchive.open(new BufferByteSource(Buffer.from(zip)), "base"))]);
  const t = new Tinter(new TextureLoader(stack), biome);
  await t.init();
  return t;
}

describe("tint biome", () => {
  it("computes the game's colormap coordinates", () => {
    expect(colormapPixel(biomeClimate("plains"), 256, 256)).toEqual([51, 173]); // t 0.8, d 0.32
    expect(colormapPixel(biomeClimate("minecraft:desert"), 256, 256)).toEqual([0, 255]); // clamped t 1, d 0
    expect(colormapPixel(biomeClimate("snowy_taiga"), 256, 256)).toEqual([255, 255]); // t clamped to 0
    expect(() => biomeClimate("narnia")).toThrow(/unknown tint biome "narnia"/);
  });

  it("samples the instance's colormaps at the configured biome, with fixed and blended colours", async () => {
    expect((await tinter()).tintFor("minecraft:short_grass")).toEqual([51, 173, 1]);
    expect((await tinter("jungle")).tintFor("minecraft:oak_leaves")).toEqual([13, 37, 2]); // t 0.95, d 0.855
    expect((await tinter("swamp")).tintFor("minecraft:short_grass")).toEqual([0x6a, 0x70, 0x39]);
    expect((await tinter("dark_forest")).tintFor("minecraft:short_grass")).toEqual([(77 + 0x28) >> 1, (112 + 0x34) >> 1, (1 + 0x0a) >> 1]); // t 0.7, d 0.56
  });
});
