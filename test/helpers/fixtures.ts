import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zipSync, type Zippable } from "fflate";
import { Image } from "../../src/palette/image.js";

export type FileTree = Record<string, string | Uint8Array | object>;

function toBytes(v: string | Uint8Array | object): Uint8Array {
  if (v instanceof Uint8Array) return v;
  return new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
}

/** Builds a zip in memory. `store: true` disables compression (as jar-in-jar entries often are). */
export function makeZip(files: FileTree, opts: { store?: boolean } = {}): Uint8Array {
  const z: Zippable = {};
  for (const [name, v] of Object.entries(files)) z[name] = [toBytes(v), { level: opts.store ? 0 : 6 }];
  return zipSync(z);
}

export async function tempDir(prefix = "autosketch-test-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function writeTree(root: string, files: Record<string, string | Uint8Array | object>): Promise<void> {
  for (const [rel, v] of Object.entries(files)) {
    const p = join(root, rel);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, toBytes(v));
  }
}

/** A tiny solid-colour PNG (optionally a 2-colour checker for "noisy" textures). */
export function solidPng(rgb: [number, number, number], size = 4, checker?: [number, number, number]): Uint8Array {
  const img = new Image(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = checker && (x + y) % 2 ? checker : rgb;
      img.blend(x, y, [c[0], c[1], c[2], 255]);
    }
  return img.encodePng();
}
