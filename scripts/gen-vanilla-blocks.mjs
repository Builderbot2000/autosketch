#!/usr/bin/env node
/**
 * Generates data/vanilla/<version>.json: every vanilla block with its full property set and
 * default state. Source: PrismarineJS/minecraft-data (MIT). We fetch only the one blocks.json we
 * need instead of depending on the 500 MB package.
 *
 *   node scripts/gen-vanilla-blocks.mjs 1.21.1
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const version = process.argv[2];
if (!version) throw new Error("usage: gen-vanilla-blocks.mjs <mc-version>");
const RAW = "https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data";

const paths = await (await fetch(`${RAW}/dataPaths.json`)).json();
const rel = paths.pc?.[version]?.blocks;
if (!rel) throw new Error(`minecraft-data has no blocks for ${version}`);
const blocks = await (await fetch(`${RAW}/${rel}/blocks.json`)).json();

const out = {};
for (const b of blocks) {
  const props = {};
  for (const s of b.states ?? []) {
    // Minecraft's BooleanProperty value order is [true, false].
    props[s.name] = s.type === "bool" ? ["true", "false"] : (s.values ?? []).map(String);
  }
  // State ids enumerate properties with the last one varying fastest.
  let idx = b.defaultState - b.minStateId;
  const def = {};
  const names = Object.keys(props);
  for (let i = names.length - 1; i >= 0; i--) {
    const vals = props[names[i]];
    def[names[i]] = vals[idx % vals.length];
    idx = Math.floor(idx / vals.length);
  }
  out[`minecraft:${b.name}`] = {
    name: b.displayName,
    ...(names.length ? { props, def } : {}),
    ...(b.emitLight ? { light: b.emitLight } : {}),
    ...(b.transparent ? { transparent: true } : {}),
    ...(b.boundingBox === "empty" ? { noCollision: true } : {}),
  };
}

const file = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "vanilla", `${version}.json`);
await mkdir(dirname(file), { recursive: true });
await writeFile(
  file,
  JSON.stringify({ version, source: `PrismarineJS/minecraft-data ${rel}/blocks.json (MIT License)`, blocks: out }) + "\n",
);
console.log(`wrote ${Object.keys(out).length} blocks to ${file}`);
