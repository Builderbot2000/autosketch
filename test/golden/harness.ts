/**
 * Golden-file helpers for the golden tier (docs/design/10-testing.md, tier 2).
 *
 * Goldens live in test/golden/__golden__/ and are committed. To accept an intentional change:
 *
 *   npm run golden:update        # rewrites every golden from the current code, then review the diff
 *
 * A missing golden fails the test (so CI can't pass by accident). When an image differs, the
 * actual render and a diff mask are written to test/golden/__output__/ (git-ignored).
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { expect } from "vitest";

export const UPDATE = process.env.UPDATE_GOLDEN === "1";
const HERE = dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = join(HERE, "__golden__");
export const OUTPUT_DIR = join(HERE, "__output__");
const REPO = join(HERE, "..", "..");

async function writeFileDeep(path: string, data: Buffer | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

/** Reads a committed golden, or writes it in update mode. Throws a helpful error when it's missing. */
export async function golden(path: string, actual: Buffer | string): Promise<Buffer | undefined> {
  if (UPDATE) {
    await writeFileDeep(path, actual);
    return undefined;
  }
  if (!existsSync(path)) throw new Error(`golden ${relative(REPO, path)} is missing; run \`npm run golden:update\` and commit it`);
  return readFile(path);
}

/**
 * Stable, reviewable JSON: anything that fits on one line (≤ 100 chars) stays inline, larger
 * objects and arrays expand one child per line. Trailing newline.
 */
export function stableJson(v: unknown): string {
  const fmt = (x: unknown, pad: string): string => {
    const flat = JSON.stringify(x);
    if (flat === undefined || flat.length <= 100 || x === null || typeof x !== "object") return flat ?? "null";
    const inner = pad + "  ";
    if (Array.isArray(x)) return `[\n${x.map((e) => inner + fmt(e, inner)).join(",\n")}\n${pad}]`;
    const entries = Object.entries(x).filter(([, e]) => e !== undefined);
    return `{\n${entries.map(([k, e]) => `${inner}${JSON.stringify(k)}: ${fmt(e, inner)}`).join(",\n")}\n${pad}}`;
  };
  return fmt(v, "") + "\n";
}

/** Compares `value` with __golden__/<name>.json, with a structural diff on failure. */
export async function expectJsonGolden(name: string, value: unknown): Promise<void> {
  const text = stableJson(value);
  const buf = await golden(join(GOLDEN_DIR, `${name}.json`), text);
  if (!buf) return;
  expect(JSON.parse(text), `${name}.json differs from its golden (npm run golden:update if intended)`).toEqual(JSON.parse(buf.toString("utf8")));
}

// ---------------------------------------------------------------------------------------------
// Perceptual image comparison
// ---------------------------------------------------------------------------------------------

export interface ImageTolerance {
  /** A pixel counts as different when any channel differs by more than this (0–255). */
  channel: number;
  /** The comparison fails when more than this fraction of pixels differ. */
  fraction: number;
}

/**
 * Loose enough to absorb last-bit float or PNG-encoder drift, tight enough that one changed
 * block in a fixture (hundreds of pixels at golden sizes) fails.
 */
export const DEFAULT_TOLERANCE: ImageTolerance = { channel: 24, fraction: 0.0005 };

export interface ImageDiff {
  sameSize: boolean;
  differing: number;
  total: number;
  maxDelta: number;
  /** Red where pixels differ, faded actual elsewhere. */
  mask?: PNG;
}

export function diffImages(actual: Buffer, expected: Buffer, tol: ImageTolerance = DEFAULT_TOLERANCE): ImageDiff {
  const a = PNG.sync.read(actual);
  const e = PNG.sync.read(expected);
  if (a.width !== e.width || a.height !== e.height) return { sameSize: false, differing: a.width * a.height, total: a.width * a.height, maxDelta: 255 };
  const mask = new PNG({ width: a.width, height: a.height });
  let differing = 0;
  let maxDelta = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(a.data[i + c]! - e.data[i + c]!));
    maxDelta = Math.max(maxDelta, d);
    const bad = d > tol.channel;
    if (bad) differing++;
    const grey = Math.round((a.data[i]! + a.data[i + 1]! + a.data[i + 2]!) / 3 / 3 + 170);
    mask.data[i] = bad ? 255 : grey;
    mask.data[i + 1] = bad ? 0 : grey;
    mask.data[i + 2] = bad ? 0 : grey;
    mask.data[i + 3] = 255;
  }
  return { sameSize: true, differing, total: a.width * a.height, maxDelta, mask };
}

export function imagesMatch(d: ImageDiff, tol: ImageTolerance = DEFAULT_TOLERANCE): boolean {
  return d.sameSize && d.differing <= d.total * tol.fraction;
}

/** Compares a PNG with __golden__/<name>.png within a perceptual tolerance. */
export async function expectPngGolden(name: string, png: Buffer, tol: ImageTolerance = DEFAULT_TOLERANCE): Promise<void> {
  const buf = await golden(join(GOLDEN_DIR, `${name}.png`), png);
  if (!buf) return;
  const d = diffImages(png, buf, tol);
  if (imagesMatch(d, tol)) return;
  const out = join(OUTPUT_DIR, name);
  await writeFileDeep(`${out}.actual.png`, png);
  if (d.mask) await writeFileDeep(`${out}.diff.png`, PNG.sync.write(d.mask));
  const what = d.sameSize
    ? `${d.differing} of ${d.total} pixels differ (allowed ${Math.floor(d.total * tol.fraction)}; max channel delta ${d.maxDelta})`
    : "image size changed";
  throw new Error(`${name}.png: ${what}. See ${relative(REPO, out)}.{actual,diff}.png; run \`npm run golden:update\` if intended.`);
}
