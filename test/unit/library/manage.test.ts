import { describe, expect, it } from "vitest";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { readConfig } from "../../../src/core/config.js";
import { Settings } from "../../../src/core/settings.js";
import { listKnowledge } from "../../../src/library/knowledge.js";
import { copyToLibrary, deleteEntry, duplicateEntry, emptyTrash, listEntries, listTrash, renameEntry, resolveEntry, restoreEntry } from "../../../src/library/manage.js";
import { listLibraryPalettes } from "../../../src/library/palettes.js";
import { scanPrefabs } from "../../../src/library/prefabs.js";
import { listProcedures } from "../../../src/library/procedures.js";
import { libraryRoots, starterRoot } from "../../../src/library/roots.js";
import { EventBus } from "../../../src/observe/bus.js";
import { ObserveHttp } from "../../../src/observe/http.js";
import { LogTables } from "../../../src/observe/states.js";
import { smallContext } from "../../helpers/context.js";
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

function send(url: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<{ status: number; type: string; body: Buffer; json: () => any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const data = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((ok, fail) => {
    const req = request(url, { method: opts.method ?? "GET", headers: { ...(data ? { "content-type": "application/json" } : {}), ...opts.headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        ok({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body, json: () => JSON.parse(body.toString("utf8")) });
      });
    });
    req.on("error", fail);
    req.end(data);
  });
}

describe("Library tab endpoints (15, U3a)", () => {
  it("lists, acts through the guard, hides through config.toml, and serves thumbnails and previews", async () => {
    const dir = await userRoot();
    const home = await tempDir();
    const path = join(home, "config.toml");
    const roots = () => libraryRoots({ workspace: "/ws", env: { AUTOSKETCH_LIBRARY: dir }, settings: Settings.from([], {}, readConfig(path)) });
    const http = new ObserveHttp({ bus: new EventBus(), tables: new LogTables(() => {}), sessionId: "s", dirFor: () => home, docFor: () => undefined, port: 0, configPath: path, library: { roots, thumbnail: async () => Buffer.from("png!") } });
    const page = await http.start();
    const base = page.replace(/#.*$/, "") + "api/library";
    const write = { origin: page.replace(/\/#.*$/, ""), "x-autosketch-token": /#t=(.+)$/.exec(page)![1]! };

    const v = (await send(base)).json();
    expect(v.roots.map((r: { label: string; writable: boolean }) => [r.label, r.writable])).toEqual([["user", true], ["starter", false]]);
    expect(v.roots[0].counts).toEqual({ prefabs: 1, palettes: 1, procedures: 1, knowledge: 1 });
    const d = (await send(`${base}/user/knowledge/styles/gothic`)).json();
    expect(d).toMatchObject({ name: "styles/gothic", text: expect.stringContaining("Body") });
    expect(JSON.stringify(d)).not.toContain(dir); // entries never carry their path
    expect((await send(`${base}/user/knowledge/..%2F..%2Fetc`)).status).toBe(400);
    expect((await send(`${base}/user/prefabs/park_bench?thumb`)).body.toString()).toBe("png!");
    const prev = (await send(`${base}/user/prefabs/park_bench?preview`)).json();
    expect(Buffer.from(prev.voxels, "base64").subarray(0, 4).toString()).toBe("ASVX");
    expect(prev.models).toBeNull(); // no instance: the tab draws flat colours

    // Writes need the token; a GET never acts.
    expect((await send(`${base}/user/palettes/stone/delete`, { method: "POST", headers: { origin: write.origin } })).status).toBe(403);
    expect((await send(`${base}/user/palettes/stone/delete`, { headers: write })).status).toBe(404);
    const del = await send(`${base}/user/palettes/stone/delete`, { method: "POST", headers: write });
    expect(del.status).toBe(200);
    const trash = (await send(`${base}/user/trash`)).json().trash;
    expect(trash).toHaveLength(1);
    expect((await send(`${base}/user/trash/${trash[0].id}/restore`, { method: "POST", headers: write })).json().restored.name).toBe("stone");
    expect((await send(`${base}/user/palettes/stone/rename`, { method: "POST", headers: write, body: { to: "../evil" } })).status).toBe(400);

    // Hiding a starter entry saves library.hidden; a user's own entry can't be hidden.
    expect((await send(`${base}/starter/prefabs/lamp_post/hide`, { method: "POST", headers: write })).status).toBe(200);
    expect(readConfig(path).config.settings["library.hidden"]).toBe("prefabs/lamp_post");
    expect((await send(base)).json().entries.prefabs.find((e: { name: string }) => e.name === "lamp_post").hidden).toBe(true);
    expect((await send(`${base}/user/prefabs/park_bench/hide`, { method: "POST", headers: write })).status).toBe(409);
    await send(`${base}/starter/prefabs/lamp_post/unhide`, { method: "POST", headers: write });
    expect(readConfig(path).config.settings["library.hidden"]).toBeUndefined();
    await http.close();
  });
});

describe("Library editors (15, U3b)", () => {
  async function server(withIndex: boolean) {
    const dir = await userRoot();
    const home = await tempDir();
    const ctx = withIndex ? await smallContext() : undefined;
    const roots = () => libraryRoots({ workspace: "/ws", env: { AUTOSKETCH_LIBRARY: dir } });
    const http = new ObserveHttp({ bus: new EventBus(), tables: new LogTables(() => {}), sessionId: "s", dirFor: () => home, docFor: () => undefined, port: 0, configPath: join(home, "config.toml"), library: { roots, ...(ctx ? { paletteIndex: () => ctx.palette } : {}) } });
    const page = await http.start();
    const base = page.replace(/#.*$/, "") + "api/library";
    const write = { origin: page.replace(/\/#.*$/, ""), "x-autosketch-token": /#t=(.+)$/.exec(page)![1]! };
    return { dir, http, base, write };
  }

  it("saves text with the hash it started from; a file changed meanwhile answers 409 and keeps the agent's version", async () => {
    const t = await server(false);
    const url = `${t.base}/user/knowledge/styles/gothic`;
    const d = (await send(url)).json();
    expect(d).toMatchObject({ editable: true, hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    // The agent (or a hand edit) changes the pack after the page read it.
    const file = join(t.dir, "knowledge/styles/gothic.md");
    await writeFile(file, "agent's version\n");
    const stale = await send(url, { method: "PUT", headers: t.write, body: { hash: d.hash, text: "mine" } });
    expect(stale.status).toBe(409);
    expect(await readFile(file, "utf8")).toBe("agent's version\n");
    expect((await send(url, { method: "PUT", headers: { origin: t.write.origin }, body: { hash: d.hash, text: "mine" } })).status).toBe(403);
    const fresh = (await send(url)).json();
    const ok = await send(url, { method: "PUT", headers: t.write, body: { hash: fresh.hash, text: "mine\n" } });
    expect(ok.status).toBe(200);
    expect(await readFile(file, "utf8")).toBe("mine\n");
    expect((await send(url)).json().hash).toBe(ok.json().hash);
    // Read-only entries aren't editable.
    const starter = (await send(`${t.base}/starter/knowledge/heuristics/roofs`)).json();
    expect(starter.editable).toBe(false);
    expect((await send(`${t.base}/starter/knowledge/heuristics/roofs`, { method: "PUT", headers: t.write, body: { hash: starter.hash, text: "x" } })).status).toBe(409);
    await t.http.close();
  });

  it("edits prefab.json fields, keeping the others, and validates them", async () => {
    const t = await server(false);
    const url = `${t.base}/user/prefabs/park_bench`;
    const file = join(t.dir, "prefabs/park_bench/prefab.json");
    const before = JSON.parse(await readFile(file, "utf8"));
    let d = (await send(url)).json();
    expect((await send(url, { method: "PUT", headers: t.write, body: { hash: d.hash, metadata: { anchors: { seat: [1, "x", 0] } } } })).status).toBe(400);
    expect((await send(url, { method: "PUT", headers: t.write, body: { hash: d.hash, metadata: { front: "up" } } })).status).toBe(400);
    const r = await send(url, { method: "PUT", headers: t.write, body: { hash: d.hash, metadata: { name: "Bench", tags: ["Park", "seat", "park"], front: "east", notes: "for plazas", anchors: { seat: [1, 1, 0] }, roles: { wood: ["oak_planks"] } } } });
    expect(r.status).toBe(200);
    const after = JSON.parse(await readFile(file, "utf8"));
    expect(after).toMatchObject({ name: "Bench", tags: ["park", "seat"], front: "east", notes: "for plazas", anchors: { seat: [1, 1, 0] }, roles: { wood: ["minecraft:oak_planks"] } });
    expect(after.footprint).toEqual(before.footprint);
    d = (await send(url)).json();
    expect(d.meta).toMatchObject({ name: "Bench", front: "east" });
    await t.http.close();
  });

  it("edits palettes: tags and notes always, members through palette_edit's operations with an instance", async () => {
    const plain = await server(false);
    const url = (b: string) => `${b}/user/palettes/stone`;
    let d = (await send(url(plain.base))).json();
    expect((await send(url(plain.base), { method: "PUT", headers: plain.write, body: { hash: d.hash, edit: { drop: ["wall"] } } })).status).toBe(409);
    expect((await send(url(plain.base), { method: "PUT", headers: plain.write, body: { hash: d.hash, tags: ["Grey", "castle"], notes: "plain" } })).status).toBe(200);
    expect(JSON.parse(await readFile(join(plain.dir, "palettes/stone.json"), "utf8"))).toMatchObject({ tags: ["grey", "castle"], notes: "plain" });
    await plain.http.close();

    const t = await server(true);
    await writeFile(join(t.dir, "palettes/stone.json"), JSON.stringify({ name: "stone", tags: [], roles: { wall: [{ family: "minecraft:stone_bricks", block: "minecraft:stone_bricks", weight: 1, color: "#787878" }] } }));
    d = (await send(url(t.base))).json();
    const r = await send(url(t.base), { method: "PUT", headers: t.write, body: { hash: d.hash, addBlocks: { wall: ["cobblestone", "nope:block"] }, edit: { rename: { wall: "walls" } } } });
    expect(r.status).toBe(200);
    expect(r.json().warnings).toEqual(["wall: nope:block is not a building block in this instance; not added"]);
    const saved = JSON.parse(await readFile(join(t.dir, "palettes/stone.json"), "utf8"));
    expect(Object.keys(saved.roles)).toEqual(["walls"]);
    expect(saved.roles.walls.map((m: { block: string; weight: number }) => [m.block, m.weight])).toEqual([["minecraft:stone_bricks", 0.5], ["minecraft:cobblestone", 0.5]]);
    expect(saved.roles.walls[0].color).toBe("#787878");
    d = (await send(url(t.base))).json();
    const w = await send(url(t.base), { method: "PUT", headers: t.write, body: { hash: d.hash, edit: { weights: { walls: { stone_bricks: 3, cobblestone: 1 } } } } });
    expect(w.status).toBe(200);
    expect(JSON.parse(await readFile(join(t.dir, "palettes/stone.json"), "utf8")).roles.walls.map((m: { weight: number }) => m.weight)).toEqual([0.75, 0.25]);
    expect((await send(url(t.base), { method: "PUT", headers: t.write, body: { hash: d.hash, notes: "late" } })).status).toBe(409);
    await t.http.close();
  });
});
