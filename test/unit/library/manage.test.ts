import { describe, expect, it } from "vitest";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Settings } from "../../../src/core/settings.js";
import { listKnowledge } from "../../../src/library/knowledge.js";
import { copyToLibrary, deleteEntry, duplicateEntry, emptyTrash, listEntries, listTrash, renameEntry, resolveEntry, restoreEntry } from "../../../src/library/manage.js";
import { listLibraryPalettes } from "../../../src/library/palettes.js";
import { scanPrefabs } from "../../../src/library/prefabs.js";
import { listProcedures } from "../../../src/library/procedures.js";
import { libraryRoots, starterRoot } from "../../../src/library/roots.js";
import { tempDir } from "../../helpers/fixtures.js";

/** The Library tab's library side (docs/design/15-management-ui.md, U3a): settings, listing, actions, trash. */

async function userRoot(): Promise<string> {
  const dir = await tempDir("autosketch-lib-");
  // A copy of the starter's bench (so it overrides it), a palette, a procedure and a knowledge pack.
  await cp(join(starterRoot().path, "prefabs", "park_bench"), join(dir, "prefabs", "park_bench"), { recursive: true });
  await mkdir(join(dir, "palettes"), { recursive: true });
  await writeFile(join(dir, "palettes", "stone.json"), JSON.stringify({ name: "stone", tags: ["grey"], roles: { wall: [{ block: "minecraft:stone", weight: 1 }] } }));
  await mkdir(join(dir, "procedures"), { recursive: true });
  await writeFile(join(dir, "procedures", "bay.js"), "/** Window bay. @param face the face */\n");
  await mkdir(join(dir, "knowledge", "styles"), { recursive: true });
  await writeFile(join(dir, "knowledge", "styles", "gothic.md"), "---\nkind: style\ntags: [medieval]\nsummary: Tall.\n---\nBody\n");
  return dir;
}

const settingsWith = (lines: Record<string, string>, argv: string[] = [], env: Record<string, string> = {}) => {
  const text = `[settings]\n${Object.entries(lines).map(([k, v]) => `"${k}" = ${JSON.stringify(v)}`).join("\n")}\n`;
  return { settings: Settings.from(argv, env, { path: "config.toml", exists: true, hash: "x", warnings: [], config: { settings: lines, extra: {} } }), text };
};

describe("library settings (15, *Library settings*)", () => {
  it("takes library.roots, falls back to AUTOSKETCH_LIBRARY, and turns the starter and Axiom roots off", () => {
    const { settings } = settingsWith({ "library.roots": "/a, ~/b", "library.starter": "false" });
    const r = libraryRoots({ workspace: "/ws", instanceRoot: "/inst", settings, env: { AUTOSKETCH_LIBRARY: "/ignored" } });
    expect(r.map((x) => x.label)).toEqual(["user", "user2", "axiom"]);
    expect(r[0]!.path).toBe("/a");
    expect(r[1]!.path).not.toContain("~");
    const alias = libraryRoots({ workspace: "/ws", settings: settingsWith({ "library.axiom": "false" }).settings, instanceRoot: "/inst", env: { AUTOSKETCH_LIBRARY: "/old" } });
    expect(alias.map((x) => [x.label, x.path])).toEqual([["user", "/old"], ["starter", starterRoot().path]]);
  });

  it("hides read-only entries from every listing, never a user's own", async () => {
    const dir = await userRoot();
    const { settings } = settingsWith({ "library.roots": dir, "library.hidden": "prefabs/lamp_post, prefabs/park_bench, knowledge/heuristics/roofs" });
    const roots = libraryRoots({ workspace: "/ws", settings });
    const ids = (await scanPrefabs(roots)).map((p) => `${p.root.label}:${p.id}`);
    expect(ids).not.toContain("starter:lamp_post");
    expect(ids).toContain("user:park_bench"); // the user's own bench isn't hidden
    expect((await listKnowledge(roots)).map((k) => k.name)).not.toContain("heuristics/roofs");
    const all = await listEntries(roots);
    expect(all.prefabs.find((e) => e.root === "starter" && e.name === "lamp_post")).toMatchObject({ hidden: true });
  });
});

describe("library management (15, *Library tab*)", () => {
  it("lists every root's entries with origin and shadowing", async () => {
    const dir = await userRoot();
    const roots = libraryRoots({ workspace: "/ws", env: { AUTOSKETCH_LIBRARY: dir } });
    const all = await listEntries(roots);
    const bench = all.prefabs.filter((e) => e.name === "park_bench");
    expect(bench.map((e) => [e.root, e.writable, e.overrides, e.shadowedBy])).toEqual([
      ["user", true, ["starter"], undefined],
      ["starter", false, undefined, "user"],
    ]);
    expect(all.palettes.find((e) => e.name === "stone")).toMatchObject({ root: "user", tags: ["grey"] });
    expect(all.procedures.find((e) => e.name === "bay")).toMatchObject({ summary: "Window bay." });
    expect(all.knowledge.find((e) => e.name === "styles/gothic")).toMatchObject({ root: "user", tags: ["medieval"] });
  });

  it("resolves addresses only to listed entries; paths are refused", async () => {
    const dir = await userRoot();
    const roots = libraryRoots({ workspace: "/ws", env: { AUTOSKETCH_LIBRARY: dir } });
    for (const name of ["../../etc", "../palettes/stone", "styles/../../x", ".trash/x", "a\\b", ""])
      await expect(resolveEntry(roots, "user", "knowledge", name)).rejects.toMatchObject({ status: 400 });
    await expect(resolveEntry(roots, "user", "knowledge", "etc/passwd")).rejects.toMatchObject({ status: 404 });
    await expect(resolveEntry(roots, "nope", "prefabs", "x")).rejects.toMatchObject({ status: 404 });
    await expect(resolveEntry(roots, "user", "secrets", "x")).rejects.toMatchObject({ status: 404 });
    expect((await resolveEntry(roots, "user", "knowledge", "styles/gothic")).file).toBe(join(dir, "knowledge", "styles", "gothic.md"));
  });

  it("deletes into the trash and restores byte for byte; the trash never shows in the tools' listings", async () => {
    const dir = await userRoot();
    const roots = libraryRoots({ workspace: "/ws", env: { AUTOSKETCH_LIBRARY: dir }, starter: false });
    const files = { schem: join(dir, "prefabs/park_bench/prefab.schem"), json: join(dir, "prefabs/park_bench/prefab.json"), pal: join(dir, "palettes/stone.json"), md: join(dir, "knowledge/styles/gothic.md"), js: join(dir, "procedures/bay.js") };
    const before = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k, f]) => [k, await readFile(f)] as const)));
    const items = [];
    for (const [kind, name] of [["prefabs", "park_bench"], ["palettes", "stone"], ["knowledge", "styles/gothic"], ["procedures", "bay"]] as const) items.push(await deleteEntry(await resolveEntry(roots, "user", kind, name)));
    expect(await scanPrefabs(roots)).toEqual([]);
    expect(await listLibraryPalettes(roots)).toEqual([]);
    expect(await listKnowledge(roots)).toEqual([]);
    expect(await listProcedures(roots)).toEqual([]);
    expect((await listEntries(roots)).prefabs).toEqual([]);
    expect((await listTrash(roots[0]!)).map((t) => t.name).sort()).toEqual(["bay", "park_bench", "stone", "styles/gothic"]);
    for (const t of items) await restoreEntry(roots[0]!, t.id);
    for (const [k, f] of Object.entries(files)) expect(await readFile(f)).toEqual(before[k]);
    expect(await listTrash(roots[0]!)).toEqual([]);
    // A name taken again since the delete isn't overwritten by a restore.
    const t = await deleteEntry(await resolveEntry(roots, "user", "palettes", "stone"));
    await writeFile(files.pal, "{}");
    await expect(restoreEntry(roots[0]!, t.id)).rejects.toMatchObject({ status: 409 });
    expect(await emptyTrash(roots[0]!)).toBe(1);
    await expect(restoreEntry(roots[0]!, "../../x")).rejects.toMatchObject({ status: 400 });
  });

  it("renames, duplicates and copies, keeping names in step and refusing taken or bad names", async () => {
    const dir = await userRoot();
    const roots = libraryRoots({ workspace: "/ws", env: { AUTOSKETCH_LIBRARY: dir } });
    const stone = await resolveEntry(roots, "user", "palettes", "stone");
    await expect(renameEntry(stone, "../x")).rejects.toMatchObject({ status: 400 });
    await expect(renameEntry(stone, "a/b")).rejects.toMatchObject({ status: 400 });
    await renameEntry(stone, "granite");
    expect(JSON.parse(await readFile(join(dir, "palettes/granite.json"), "utf8")).name).toBe("granite");
    const granite = await resolveEntry(roots, "user", "palettes", "granite");
    await duplicateEntry(granite, "granite2");
    await expect(duplicateEntry(granite, "granite2")).rejects.toMatchObject({ status: 409 });
    expect((await listLibraryPalettes(roots)).map((p) => p.name).sort()).toEqual(["granite", "granite2", "timber_cottage"]);
    // Read-only entries: no rename; copying writes into the first writable root, once.
    const lamp = await resolveEntry(roots, "starter", "prefabs", "lamp_post");
    await expect(renameEntry(lamp, "x")).rejects.toMatchObject({ status: 409 });
    expect(await copyToLibrary(lamp, roots)).toEqual({ root: "user", name: "lamp_post" });
    await expect(copyToLibrary(lamp, roots)).rejects.toMatchObject({ status: 409 });
    expect((await listEntries(roots)).prefabs.find((e) => e.root === "user" && e.name === "lamp_post")).toMatchObject({ overrides: ["starter"] });
  });
});
