import { Registry, type BlockInfo } from "../../src/assets/registry.js";

/** Builds a registry directly from terse block specs (no pack stack needed). */
export function fakeRegistry(specs: (Partial<BlockInfo> & { id: string })[]): Registry {
  const blocks: BlockInfo[] = specs.map((s) => {
    const tex = s.id.replace(":", ":block/");
    return {
      namespace: s.id.slice(0, s.id.indexOf(":")),
      properties: {},
      defaults: {},
      shape: "full",
      renderable: "exact",
      faceTextures: { up: tex, down: tex, north: tex, south: tex, east: tex, west: tex },
      textures: [tex],
      tinted: false,
      tags: [],
      source: "test",
      ...s,
    };
  });
  return new Registry({ cacheVersion: 0, fingerprint: "test", mcVersion: "1.21.1", builtMs: 0, blocks, mods: {}, warnings: [] });
}

export const partial = (id: string, extra: Partial<BlockInfo> = {}) => ({ id, shape: "partial" as const, ...extra });
