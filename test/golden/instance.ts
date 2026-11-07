/**
 * Loads the synthetic instance (scripts/gen-golden-instance.ts) through the real pipeline:
 * locate → pack stack → registry → palette index → block baker. Caches are off, so every load
 * builds from scratch.
 */
import { rm } from "node:fs/promises";
import { locateInstance, type InstanceInfo } from "../../src/assets/locate.js";
import { openStack, type PackStack } from "../../src/assets/pack.js";
import { loadRegistry, type Registry } from "../../src/assets/registry.js";
import { loadPaletteIndex, type PaletteIndex } from "../../src/palette/index.js";
import { TextureLoader, Tinter } from "../../src/palette/textures.js";
import { BlockBaker } from "../../src/perception/render/bake.js";
import { BUILTIN_PLUGINS } from "../../src/plugins/builtin.js";
import { activePlugins } from "../../src/plugins/types.js";
import { writeSyntheticInstance } from "../../scripts/gen-golden-instance.js";
import { tempDir } from "../helpers/fixtures.js";

export interface Synthetic {
  root: string;
  info: InstanceInfo;
  stack: PackStack;
  stackWarnings: string[];
  registry: Registry;
  palette: PaletteIndex;
  baker: BlockBaker;
  dispose: () => Promise<void>;
}

export async function loadSynthetic(): Promise<Synthetic> {
  const root = await writeSyntheticInstance(await tempDir("autosketch-golden-"));
  const info = await locateInstance(root);
  const { stack, warnings } = await openStack(info, { indexCache: false });
  const { registry } = await loadRegistry(stack, { mcVersion: info.mcVersion, cacheDir: false });
  const { index } = await loadPaletteIndex(stack, registry, { plugins: activePlugins(BUILTIN_PLUGINS, registry), cacheDir: false });
  const loader = new TextureLoader(stack);
  const tinter = new Tinter(loader);
  await tinter.init();
  const baker = new BlockBaker(stack, loader, tinter, registry);
  return { root, info, stack, stackWarnings: warnings, registry, palette: index, baker, dispose: () => rm(root, { recursive: true, force: true }) };
}
