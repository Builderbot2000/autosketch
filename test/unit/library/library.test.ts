import { afterAll, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Compound } from "prismarine-nbt";
import { Document } from "../../../src/document/document.js";
import { encodeBlueprint } from "../../../src/formats/axiom.js";
import { snapshotOf } from "../../../src/formats/snapshot.js";
import { Library } from "../../../src/library/index.js";
import { formatKnowledgeList, listKnowledge, readKnowledge } from "../../../src/library/knowledge.js";
import { instantiatePalette, listLibraryPalettes, saveLibraryPalette } from "../../../src/library/palettes.js";
import { loadPrefab, savePrefab, scanPrefabs } from "../../../src/library/prefabs.js";
import { listProcedures, parseHeader } from "../../../src/library/procedures.js";
import { libraryRoots, starterRoot, type LibraryRoot } from "../../../src/library/roots.js";
import { layoutPrefabSheet, prefabAtCell } from "../../../src/library/sheet.js";
import { resolveAt, stampPrefab } from "../../../src/ops/stamp.js";
import { parseFrontmatter } from "../../../src/library/files.js";
import { setBlocks } from "../../../src/ops/edit.js";
import { pickPalette } from "../../../src/palette/pick.js";
import { solidPng, tempDir, writeTree } from "../../helpers/fixtures.js";
import { libraryContext } from "./fixture.js";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await tempDir("autosketch-lib-");
  dirs.push(d);
  return d;
}
const userRoot = (path: string): LibraryRoot => ({ path, label: "user", kind: "library", readOnly: false });

/** A small build: a 3×1×1 andesite row, an oak stair facing east on top, a chest with NBT. */
function sampleDoc(): Document {
  const doc = Document.create({ name: "src", dataVersion: 3955, seed: 7 });
  setBlocks(doc, {}, [
    { pos: [0, 0, 0], block: "minecraft:andesite" },
    { pos: [1, 0, 0], block: "minecraft:andesite" },
    { pos: [2, 0, 0], block: "minecraft:andesite" },
    { pos: [1, 1, 0], block: "minecraft:oak_stairs[facing=east,half=bottom]" },
  ]);
  return doc;
}

describe("roots", () => {
  it("puts user roots first, then the starter library, then the instance's Axiom blueprints", () => {
    const r = libraryRoots({ workspace: "/ws", instanceRoot: "/inst", env: {} });
    expect(r.map((x) => [x.label, x.readOnly])).toEqual([["user", false], ["starter", true], ["axiom", true]]);
    expect(r[0]!.path).toBe(join("/ws", "library"));
    expect(r[2]!.path).toBe(join("/inst", "config", "axiom", "blueprints"));
    const env = libraryRoots({ workspace: "/ws", env: { AUTOSKETCH_LIBRARY: ["/a", "/b"].join(process.platform === "win32" ? ";" : ":") }, starter: false });
    expect(env.map((x) => x.path)).toEqual(["/a", "/b"]);
  });
});

describe("knowledge packs", () => {
  it("parses light frontmatter", () => {
    const { data, body } = parseFrontmatter("---\nkind: style\nname: Gothic\ntags: [medieval, church]\nsummary: \"Tall, pointed.\"\n---\n## Body\n");
    expect(data).toEqual({ kind: "style", name: "Gothic", tags: ["medieval", "church"], summary: "Tall, pointed." });
    expect(body).toBe("## Body\n");
  });

  it("lists names and summaries, filters by kind and tags, reads by name; earlier roots shadow later ones", async () => {
    const a = await tmp(), b = await tmp();
    await writeTree(a, { "knowledge/styles/gothic.md": "---\nkind: style\nname: Gothic\ntags: [medieval]\nsummary: Mine.\n---\nmine" });
    await writeTree(b, {
      "knowledge/styles/gothic.md": "---\nkind: style\nsummary: Theirs.\n---\ntheirs",
      "knowledge/heuristics/roofs.md": "---\nkind: heuristic\ntags: [roof]\nsummary: Pitch.\n---\nroof text",
      "knowledge/notes.md": "# Loose note\nbody",
    });
    const roots = [userRoot(a), { ...userRoot(b), label: "starter", readOnly: true }];
    const all = await listKnowledge(roots);
    expect(all.map((e) => [e.name, e.kind, e.summary])).toEqual([
      ["styles/gothic", "style", "Mine."],
      ["heuristics/roofs", "heuristic", "Pitch."],
      ["notes", "note", "Loose note"],
    ]);
    expect((await listKnowledge(roots, { kind: "heuristic" })).map((e) => e.name)).toEqual(["heuristics/roofs"]);
    expect((await listKnowledge(roots, { tags: ["medieval"] })).map((e) => e.name)).toEqual(["styles/gothic"]);
    expect((await readKnowledge(roots, "roofs")).text).toContain("roof text");
    expect((await readKnowledge(roots, "Gothic")).text).toContain("mine");
    await expect(readKnowledge(roots, "tudor")).rejects.toThrow(/no knowledge pack "tudor"/);
    expect(formatKnowledgeList(all)).toMatch(/^styles\/gothic \[style\] \(medieval\): Mine\./);
  });

  it("the starter library ships the four general heuristics", async () => {
    const names = (await listKnowledge([starterRoot()], { kind: "heuristic" })).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["heuristics/proportions", "heuristics/roofs", "heuristics/windows", "heuristics/depth"]));
  });
});

describe("procedures", () => {
  it("reads the header comment: summary and @param lines", async () => {
    expect(parseHeader("/**\n * Window bay: a row of windows.\n * @param face  component face\n * @param [spacing] blocks between (default 3)\n */\nfill()")).toEqual({
      summary: "Window bay: a row of windows.",
      params: [{ name: "face", description: "component face" }, { name: "spacing", description: "blocks between (default 3)" }],
    });
    expect(parseHeader("// Crenellate a wall top\n// @param sel the wall\ncode()")).toEqual({ summary: "Crenellate a wall top", params: [{ name: "sel", description: "the wall" }] });
    const d = await tmp();
    await writeTree(d, { "procedures/window_bay.js": "/** Bays. @param face f */\n", "procedures/walls/crenel.js": "// Crenels\n" });
    expect((await listProcedures([userRoot(d)])).map((p) => p.name)).toEqual(["walls/crenel", "window_bay"]);
    expect((await listProcedures([userRoot(d)], "crenel")).map((p) => p.name)).toEqual(["walls/crenel"]);
  });
});

describe("palettes", () => {
  it("saves a palette with colours and loads it elsewhere, reporting missing families with a nearest-colour suggestion", async () => {
    const c = await libraryContext();
    const d = await tmp();
    const roots = [userRoot(d)];
    const picked = pickPalette(c.palette, { name: "castle", sheet: "family:minecraft:andesite", roles: { wall: "A1" } }).palette;
    // Add a member this instance lacks, as if saved in another modpack, with its colour.
    const r = await saveLibraryPalette(roots, c.palette, picked, { tags: ["Medieval"] });
    const saved = JSON.parse(await readFile(r.file, "utf8"));
    expect(saved).toMatchObject({ name: "castle", tags: ["medieval"], roles: { wall: [{ family: "minecraft:andesite", block: "minecraft:andesite", weight: 1, color: "#828282" }] } });
    await expect(saveLibraryPalette(roots, c.palette, picked)).rejects.toThrow(/already exists/);

    saved.roles.wall.push({ family: "othermod:basalt_tiles", block: "othermod:basalt_tiles", weight: 1, color: "#976551" });
    saved.roles.trim = [{ family: "othermod:gold_trim", block: "othermod:gold_trim", weight: 1 }];
    const load = instantiatePalette(c.palette, saved);
    expect(load.palette.roles).toEqual({ wall: [{ family: "minecraft:andesite", block: "minecraft:andesite", weight: 1 }] });
    expect(load.missing).toEqual([
      { role: "wall", family: "othermod:basalt_tiles", block: "othermod:basalt_tiles", suggestion: { family: "minecraft:granite", deltaE: expect.any(Number) } },
      { role: "trim", family: "othermod:gold_trim", block: "othermod:gold_trim" },
    ]);
    expect(load.warnings).toEqual(["trim: none of its materials are in this instance; role left out"]);
    // Only on request is the suggestion applied.
    const sub = instantiatePalette(c.palette, saved, { substitute: true });
    expect(sub.palette.roles.wall!.map((m) => [m.block, m.weight])).toEqual([["minecraft:andesite", 0.5], ["minecraft:granite", 0.5]]);

    expect((await listLibraryPalettes(roots, { tags: ["medieval"] })).map((p) => p.name)).toEqual(["castle"]);
    expect(await listLibraryPalettes(roots, { tags: ["nether"] })).toEqual([]);
  });
});

describe("prefabs", () => {
  it("saves a selection as a prefab, scans it back with metadata, and loads its blocks", async () => {
    const c = await libraryContext();
    const d = await tmp();
    const doc = sampleDoc();
    const { prefab } = await savePrefab([userRoot(d)], snapshotOf(doc), { name: "stair_step", tags: ["Test"], anchors: { base: [1, 0, 0] } }, c.palette);
    expect(prefab.meta).toMatchObject({ name: "stair_step", tags: ["test"], footprint: [3, 1], height: 2, requires: ["minecraft"], anchors: { base: [1, 0, 0] } });
    expect(prefab.meta.roles).toEqual({ andesite: ["minecraft:andesite"], oak_planks: ["minecraft:oak_planks", "minecraft:oak_stairs"] });
    const [found] = await scanPrefabs([userRoot(d)]);
    expect(found!.id).toBe("stair_step");
    expect(found!.meta).toEqual(prefab.meta);
    const l = await loadPrefab(found!, c.registry);
    expect(l.snapshot.size).toEqual([3, 2, 1]);
    expect(l.snapshot.palette).toContain("minecraft:oak_stairs[facing=east,half=bottom]");
  });

  it("the starter library's prefabs load, with sizes matching their metadata", async () => {
    const all = await scanPrefabs([starterRoot()]);
    expect(all.map((p) => p.id)).toEqual(["lamp_post", "park_bench", "small_oak_tree", "village_well"]);
    for (const p of all) {
      const s = (await loadPrefab(p)).snapshot.size;
      expect([s[0], s[2], s[1]]).toEqual([...p.meta.footprint!, p.meta.height]);
      for (const a of Object.values(p.meta.anchors)) expect(a.every((v, i) => v >= 0 && v < s[i]!)).toBe(true);
    }
    expect((await listLibraryPalettes([starterRoot()])).map((p) => p.name)).toEqual(["timber_cottage"]);
  });

  it("reads Axiom blueprints as read-only prefabs with their name, tags and embedded thumbnail", async () => {
    const d = await tmp();
    const snap = { ...snapshotOf(sampleDoc()), name: "Gate House" };
    const thumb = solidPng([10, 200, 10], 8);
    await writeTree(d, { "towns/gate.bp": encodeBlueprint(snap, { thumbnail: Buffer.from(thumb), tags: ["gate"] }) });
    const lib = new Library({ roots: [{ path: d, label: "axiom", kind: "axiom", readOnly: true }] });
    const [p] = await lib.prefabs();
    expect(p!.id).toBe("axiom/towns/gate");
    expect(p!.meta.name).toBe("Gate House");
    expect((await lib.thumbnail(p!))!.equals(Buffer.from(thumb))).toBe(true);
    expect(await lib.size(p!)).toEqual([3, 1, 2]);
  });

  it("searches by words, tags and footprint, at most what matches", async () => {
    const d = await tmp();
    const doc = sampleDoc();
    await savePrefab([userRoot(d)], snapshotOf(doc), { name: "oak_bench", tags: ["furniture"], notes: "seat for plazas" });
    await savePrefab([userRoot(d)], snapshotOf(doc), { name: "stone_wall", tags: ["wall"] });
    const lib = new Library({ roots: [userRoot(d)] });
    expect((await lib.search({ query: "bench" })).map((p) => p.id)).toEqual(["oak_bench"]);
    expect((await lib.search({ query: "plazas" })).map((p) => p.id)).toEqual(["oak_bench"]);
    expect((await lib.search({ tags: ["wall"] })).map((p) => p.id)).toEqual(["stone_wall"]);
    expect((await lib.search({ maxFootprint: [1, 3] })).map((p) => p.id)).toEqual(["oak_bench", "stone_wall"]);
    expect(await lib.search({ maxFootprint: [2, 2] })).toEqual([]);
  });

  it("lays out sheets with chessboard cells and resolves cell refs", () => {
    const fake = Array.from({ length: 30 }, (_, i) => ({ id: `p${String(i).padStart(2, "0")}` })) as never[];
    const l1 = layoutPrefabSheet(fake, "all", 1);
    expect([l1.columns, l1.rows, l1.pages, l1.cells.length]).toEqual([6, 4, 2, 24]);
    expect(prefabAtCell(l1, "B2")).toBe("p07");
    const l2 = layoutPrefabSheet(fake, "all", 2);
    expect([l2.columns, l2.rows]).toEqual([6, 1]);
    expect(() => prefabAtCell(l2, "A2")).toThrow(/empty/);
    expect(prefabAtCell(l2, "oak")).toBeUndefined();
  });

  it("renders a sheet with thumbnails and remembers its cells for stamp", async () => {
    const d = await tmp();
    for (const n of ["a_one", "b_two", "c_three"]) await savePrefab([userRoot(d)], snapshotOf(sampleDoc()), { name: n });
    let rendered = 0;
    const lib = new Library({ roots: [userRoot(d)], thumbnail: async () => (rendered++, Buffer.from(solidPng([200, 0, 0], 40))) });
    await expect(lib.resolve("B1")).rejects.toThrow(/no prefab_sheet has been shown/);
    const s = await lib.sheet({});
    expect(s!.caption).toMatch(/A1 a_one 3×1×2 · B1 b_two 3×1×2 · C1 c_three 3×1×2/);
    const png = PNG.sync.read(s!.png);
    expect([png.width > 3 * 96, png.height > 96]).toEqual([true, true]);
    expect(rendered).toBe(3);
    // Thumbnails were written beside the prefabs, so a second sheet doesn't render again.
    await readFile(join(d, "prefabs", "a_one", "thumb.png"));
    await lib.sheet({});
    expect(rendered).toBe(3);
    expect((await lib.resolve("B1")).id).toBe("b_two");
  });
});

describe("stamp", () => {
  async function setup() {
    const c = await libraryContext();
    const d = await tmp();
    const { prefab } = await savePrefab([userRoot(d)], snapshotOf(sampleDoc()), { name: "step", tags: ["t"], anchors: { base: [1, 0, 0], top: [1, 1, 0] }, roles: { wood: ["oak_planks"], stone: ["andesite"] } }, c.palette);
    const loaded = await loadPrefab(prefab, c.registry);
    const doc = Document.create({ name: "dst", dataVersion: 3955, seed: 1, palettes: c.book });
    return { c, prefab, loaded, doc };
  }

  it("places the prefab anchor at a position, registers a component, and undoes in one step", async () => {
    const { c, prefab, loaded, doc } = await setup();
    const r = stampPrefab(doc, { registry: c.registry, index: c.palette }, prefab, loaded, { at: [10, 5, 10] });
    expect(r.origin).toEqual([9, 5, 10]);
    expect(r.changed).toBe(4);
    expect(doc.getState(9, 5, 10)).toBe("minecraft:andesite");
    expect(doc.getState(11, 5, 10)).toBe("minecraft:andesite");
    expect(doc.getState(10, 6, 10)).toBe("minecraft:oak_stairs[facing=east,half=bottom]");
    expect(doc.getState(9, 6, 10)).toBe("minecraft:air");
    expect(doc.componentLocal("step")).toMatchObject({ kind: "prefab:step", box: { min: [9, 5, 10], max: [12, 7, 11] }, anchors: { base: [10, 5, 10], top: [10, 6, 10] }, tags: ["t"] });
    // A second stamp gets a numbered component id.
    expect(stampPrefab(doc, {}, prefab, loaded, { at: [0, 0, 0] }).component).toBe("step_2");
    doc.undo();
    doc.undo();
    expect(doc.blockCount()).toBe(0);
    expect(doc.components.size).toBe(0);
  });

  it("stamps at a component anchor and remaps roles through families, keeping shapes and states", async () => {
    const { c, prefab, loaded, doc } = await setup();
    const env = { registry: c.registry, index: c.palette };
    doc.edit("plot", "plot", (tx) => {
      tx.set(0, 0, 0, "minecraft:granite");
      tx.setComponent({ id: "court", box: { min: [0, 0, 0], max: [5, 1, 5] }, anchors: { well: [4, 1, 4] } });
    });
    expect(resolveAt(doc, "court.top")).toEqual([2, 1, 2]);
    expect(resolveAt(doc, { anchor: "court.well", offset: [0, 0, -1] })).toEqual([4, 1, 3]);
    expect(() => resolveAt(doc, "court.door")).toThrow(/no anchor "door"/);

    c.book.set(pickPalette(c.palette, { name: "castle", sheet: "family:minecraft:andesite", roles: { trim: "A1" } }).palette);
    const r = stampPrefab(doc, env, prefab, loaded, { at: "court.top", remap: { wood: "palette:castle.trim", stone: "oak_planks" } });
    expect(r.at).toEqual([2, 1, 2]);
    expect(doc.getState(1, 1, 2)).toBe("minecraft:oak_planks");
    expect(doc.getState(3, 1, 2)).toBe("minecraft:oak_planks");
    expect(doc.getState(2, 2, 2)).toBe("minecraft:andesite_stairs[facing=east,half=bottom]");
    expect(r.warnings).toEqual([]);
  });

  it("keeps blocks whose target family lacks the shape, with a warning, and rejects unknown roles", async () => {
    const { c, prefab, loaded, doc } = await setup();
    const env = { registry: c.registry, index: c.palette };
    const r = stampPrefab(doc, env, prefab, loaded, { at: [0, 0, 0], anchor: "top", remap: { wood: "granite" } });
    expect(r.origin).toEqual([-1, -1, 0]);
    expect(doc.getState(0, 0, 0)).toBe("minecraft:oak_stairs[facing=east,half=bottom]");
    expect(r.warnings).toContain("wood: minecraft:granite has no stairs; kept minecraft:oak_stairs there");
    expect(() => stampPrefab(doc, env, prefab, loaded, { at: [0, 0, 0], remap: { roof: "granite" } })).toThrow(/has no role "roof"/);
    expect(() => stampPrefab(doc, env, prefab, loaded, { at: [0, 0, 0], rotate: 45 })).toThrow(/multiple of 90/);
  });

  it("rotates a stamp: blocks, states, anchors and the component box turn with it", async () => {
    const { c, prefab, loaded, doc } = await setup();
    const r = stampPrefab(doc, { registry: c.registry, index: c.palette }, prefab, loaded, { at: [10, 5, 10], rotate: 90 });
    // 3×2×1 along x becomes 1×2×3 along z; the base anchor (middle of the row) stays on `at`.
    expect(r.origin).toEqual([10, 5, 9]);
    expect(r.changed).toBe(4);
    for (const z of [9, 10, 11]) expect(doc.getState(10, 5, z)).toBe("minecraft:andesite");
    expect(doc.getState(10, 6, 10)).toBe("minecraft:oak_stairs[facing=south,half=bottom]");
    expect(doc.getState(11, 5, 10)).toBe("minecraft:air");
    expect(doc.componentLocal("step")).toMatchObject({ box: { min: [10, 5, 9], max: [11, 7, 12] }, anchors: { base: [10, 5, 10], top: [10, 6, 10] } });
    doc.undo();
    expect(doc.blockCount()).toBe(0);
  });

  it("mirrors, then rotates, and moves block entities with their blocks", async () => {
    const c = await libraryContext();
    const d = await tmp();
    const src = Document.create({ name: "src", dataVersion: 3955 });
    const nbt: Compound = { type: "compound", value: { id: { type: "string", value: "minecraft:chest" }, Lock: { type: "string", value: "k" } } };
    src.edit("b", "b", (tx) => {
      tx.set(0, 0, 0, "minecraft:andesite");
      tx.set(2, 0, 0, "minecraft:oak_stairs[facing=east,half=bottom]");
      tx.set(0, 0, 1, "minecraft:chest[facing=north,type=left]", nbt);
    });
    const { prefab } = await savePrefab([userRoot(d)], snapshotOf(src), { name: "lshape", anchors: { corner: [0, 0, 0] } });
    const loaded = await loadPrefab(prefab, c.registry);
    const env = { registry: c.registry, index: c.palette };

    const m = Document.create({ name: "m", dataVersion: 3955 });
    const rm = stampPrefab(m, env, prefab, loaded, { at: [0, 0, 0], anchor: "corner", mirror: "x" });
    // Mirror x across the prefab's own centre: x → 2 - x, so the anchor block is now at prefab x = 2.
    expect(rm.origin).toEqual([-2, 0, 0]);
    expect(m.getState(0, 0, 0)).toBe("minecraft:andesite");
    expect(m.getState(-2, 0, 0)).toMatch(/^minecraft:oak_stairs\[facing=west/);
    expect(m.getState(0, 0, 1)).toMatch(/^minecraft:chest\[facing=north,type=right/);
    expect(m.getBlockEntity(0, 0, 1)).toEqual(nbt);

    const t = Document.create({ name: "t", dataVersion: 3955 });
    const rt = stampPrefab(t, env, prefab, loaded, { at: [5, 0, 5], anchor: "corner", mirror: "x", rotate: 90 });
    // Mirrored then turned clockwise: (x,z) → (2-x, z) → (1-z, 2-x).
    expect(rt.origin).toEqual([4, 0, 3]);
    expect(t.getState(5, 0, 5)).toBe("minecraft:andesite");
    expect(t.getState(5, 0, 3)).toMatch(/^minecraft:oak_stairs\[facing=north/);
    expect(t.getState(4, 0, 5)).toMatch(/^minecraft:chest\[facing=east,type=right/);
    expect(t.getBlockEntity(4, 0, 5)).toEqual(nbt);
    expect(t.getBlockEntity(5, 0, 6)).toBeUndefined();
    expect(t.componentLocal("lshape")).toMatchObject({ box: { min: [4, 0, 3], max: [6, 1, 6] }, anchors: { corner: [5, 0, 5] } });
  });

  it("warns about namespaces missing from the instance and keeps unknown blocks", async () => {
    const c = await libraryContext();
    const d = await tmp();
    const src = Document.create({ name: "m", dataVersion: 3955 });
    setBlocks(src, {}, [{ pos: [0, 0, 0], block: "othermod:widget" }, { pos: [1, 0, 0], block: "minecraft:andesite" }]);
    const { prefab } = await savePrefab([userRoot(d)], snapshotOf(src), { name: "modded" });
    expect(prefab.meta.requires).toEqual(["minecraft", "othermod"]);
    const doc = Document.create({ name: "dst", dataVersion: 3955 });
    const r = stampPrefab(doc, { registry: c.registry, index: c.palette }, prefab, await loadPrefab(prefab, c.registry), { at: [0, 0, 0] });
    expect(doc.getState(0, 0, 0)).toBe("othermod:widget");
    expect(r.warnings.join("\n")).toMatch(/requires othermod, not in this instance/);
  });
});
