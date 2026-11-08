import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneCache } from "../../../src/assets/cache.js";
import { loadRegistry } from "../../../src/assets/registry.js";
import { memStack } from "../../helpers/stack.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "autosketch-prune-"));
  dirs.push(d);
  return d;
}
const NOW = Date.UTC(2026, 10, 8);
/** Writes `name` in `dir` with an mtime `ageMin` minutes before NOW. */
function file(dir: string, name: string, ageMin: number): void {
  const p = join(dir, name);
  writeFileSync(p, "x");
  const t = (NOW - ageMin * 60_000) / 1000;
  utimesSync(p, t, t);
}
const REG = /^(registry-[0-9a-f]+)\.json\.gz$/;
const ls = (d: string) => readdirSync(d).sort();

describe("pruneCache (02, Cache)", () => {
  it("keeps the current key and the most recent others, by mtime", async () => {
    const d = temp();
    file(d, "registry-aaaa.json.gz", 50); // current, though oldest
    file(d, "registry-bbbb.json.gz", 10);
    file(d, "registry-cccc.json.gz", 20);
    file(d, "registry-dddd.json.gz", 30);
    file(d, "registry-eeee.json.gz", 40);
    const removed = await pruneCache(d, { match: REG, current: "registry-aaaa", now: NOW });
    expect(removed).toEqual(["registry-dddd.json.gz", "registry-eeee.json.gz"]);
    expect(ls(d)).toEqual(["registry-aaaa.json.gz", "registry-bbbb.json.gz", "registry-cccc.json.gz"]);
    expect(await pruneCache(d, { match: REG, current: "registry-aaaa", keep: 0, now: NOW })).toEqual(["registry-bbbb.json.gz", "registry-cccc.json.gz"]);
  });

  it("never touches files that don't match, directories, symlinks or anything outside the dir", async () => {
    const root = temp();
    const d = join(root, "cache");
    mkdirSync(d);
    file(root, "registry-0001.json.gz", 999); // outside the cache dir
    file(d, "jar-index.json.gz", 999);
    file(d, "palette-0001-ff.json.gz", 999);
    file(d, "notes.txt", 999);
    mkdirSync(join(d, "registry-0002.json.gz"));
    symlinkSync(join(root, "registry-0001.json.gz"), join(d, "registry-0003.json.gz"));
    file(d, "registry-0004.json.gz", 999);
    const removed = await pruneCache(d, { match: REG, current: "registry-ffff", keep: 0, now: NOW });
    expect(removed).toEqual(["registry-0004.json.gz"]);
    expect(ls(d)).toEqual(["jar-index.json.gz", "notes.txt", "palette-0001-ff.json.gz", "registry-0002.json.gz", "registry-0003.json.gz"]);
    expect(ls(root)).toEqual(["cache", "registry-0001.json.gz"]);
  });

  it("removes stale temp writes of matching files, not fresh ones", async () => {
    const d = temp();
    file(d, "registry-aaaa.json.gz", 1);
    file(d, "registry-aaaa.json.gz.123.0badf00d.tmp", 120);
    file(d, "registry-aaaa.json.gz.456.deadbeef.tmp", 5); // a save in progress
    file(d, "other.json.gz.789.12345678.tmp", 120);
    expect(await pruneCache(d, { match: REG, current: "registry-aaaa", now: NOW })).toEqual(["registry-aaaa.json.gz.123.0badf00d.tmp"]);
    expect(ls(d)).toEqual(["other.json.gz.789.12345678.tmp", "registry-aaaa.json.gz", "registry-aaaa.json.gz.456.deadbeef.tmp"]);
  });

  it("keeps or drops a group's files together", async () => {
    const d = temp();
    const SHEET = /^([0-9a-f]{4})-[0-9a-f]+\.png$/;
    file(d, "aaaa-01.png", 1);
    file(d, "aaaa-02.png", 1);
    file(d, "bbbb-01.png", 90);
    file(d, "bbbb-02.png", 5); // the group's newest file counts
    file(d, "cccc-01.png", 30);
    expect(await pruneCache(d, { match: SHEET, current: "aaaa", keep: 1, now: NOW })).toEqual(["cccc-01.png"]);
  });

  it("does nothing for a missing directory", async () => {
    expect(await pruneCache(join(temp(), "absent"), { match: REG, current: "x" })).toEqual([]);
  });

  it("loadRegistry prunes registries of old stacks and keeps its own", async () => {
    const d = temp();
    for (const [i, fp] of ["0000000000000001", "0000000000000002", "0000000000000003"].entries()) file(d, `registry-${fp}.json.gz`, 10 + i);
    file(d, "jar-index.json.gz", 999);
    const stack = await memStack([["d", "mod", { "data/m/tags/block/a.json": { values: ["m:x"] } }]]);
    await loadRegistry(stack, { mcVersion: "1.21.1", cacheDir: d });
    const own = `registry-${stack.fingerprint().slice(0, 16)}.json.gz`;
    expect(ls(d)).toEqual(["jar-index.json.gz", "registry-0000000000000001.json.gz", "registry-0000000000000002.json.gz", own].sort());
    expect((await loadRegistry(stack, { mcVersion: "1.21.1", cacheDir: d })).cached).toBe(true);
  });
});
