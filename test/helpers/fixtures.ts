import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { zipSync, type Zippable } from "fflate";

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
