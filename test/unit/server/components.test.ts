import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { tempDir, writeTree } from "../../helpers/fixtures.js";
import { libraryContext } from "../library/fixture.js";

let base: string;
beforeAll(async () => {
  base = await tempDir("autosketch-srvset-");
  vi.stubEnv("AUTOSKETCH_LIBRARY", join(base, "library"));
  vi.stubEnv("AUTOSKETCH_CACHE", join(base, "cache"));
  // Prefab scanning only needs the files to exist; nothing here loads their blocks.
  await writeTree(join(base, "library"), { "prefabs/gothic_tower_a/prefab.schem": "x", "prefabs/gate_small/prefab.schem": "x" });
  await writeTree(join(base, "instance", "config", "axiom", "blueprints"), { "castle/keep.bp": "x" });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(base, { recursive: true, force: true });
});

type Content = { type: string; text?: string }[];

async function connect() {
  const ctx = await libraryContext(join(base, "instance"));
  const session = new Session(join(base, "ws"));
  const server = createServer(Promise.resolve(ctx), { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: r.isError, text: (r.content as Content).map((c) => c.text ?? "").join("\n") };
  };
  return { call, session };
}

describe("component_set (17, pieces 1 and 2)", () => {
  it("shows, adds, replaces by label, removes and clears; every result shows the whole set", async () => {
    const { call, session } = await connect();
    expect((await call("component_set")).text).toBe("component set: empty");
    const add = await call("component_set", { add: [{ prefab: "gothic_tower_a", label: "corner tower" }, { prefab: "axiom/castle/keep", label: "keep", notes: "one only" }] });
    expect(add.text).toBe("component set (2):\n1. corner tower = gothic_tower_a\n2. keep = axiom/castle/keep — one only");
    const rep = await call("component_set", { add: [{ prefab: "gate_small", label: "Corner Tower" }] });
    expect(rep.text).toBe("component set (2):\n1. Corner Tower = gate_small\n2. keep = axiom/castle/keep — one only");
    const rm1 = await call("component_set", { remove: ["keep", "moat"] });
    expect(rm1.text).toBe("not in the set: moat\ncomponent set (1):\n1. Corner Tower = gate_small");
    // The set is session context: opening and closing documents leaves it alone.
    await call("doc_new", { name: "a" });
    await call("doc_new", { name: "b" });
    expect(session.componentSet.reminderLine()).toBe("set: Corner Tower = gate_small");
    expect((await call("component_set", { clear: true })).text).toBe("cleared\ncomponent set: empty");
  });

  it("refuses unknown prefab names with the nearest names and leaves the set unchanged", async () => {
    const { call, session } = await connect();
    await call("component_set", { add: [{ prefab: "gate_small" }] });
    const bad = await call("component_set", { remove: ["gate_small"], add: [{ prefab: "gothic_towr_a", label: "tower" }, { prefab: "axiom/castle/kep" }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toBe('no prefab "gothic_towr_a" (nearest: gothic_tower_a); no prefab "axiom/castle/kep" (nearest: axiom/castle/keep). Nothing was changed; prefab_search shows what\'s there.');
    expect(session.componentSet.entries).toEqual([{ prefab: "gate_small" }]);
  });

  it("saves the set as a kit, lists it with knowledge_list, and loads it into a fresh session", async () => {
    const one = await connect();
    const saved = await one.call("component_set", { add: [{ prefab: "gothic_tower_a", label: "corner tower", notes: "every corner" }, { prefab: "gate_small", label: "gatehouse" }], save_as: "Gothic cathedral kit" });
    const file = join(base, "library", "knowledge", "kits", "gothic_cathedral_kit.md");
    expect(saved.text).toBe(`saved kit "Gothic cathedral kit" in ${file}\ncomponent set (2):\n1. corner tower = gothic_tower_a — every corner\n2. gatehouse = gate_small`);
    expect(await readFile(file, "utf8")).toMatch(/^---\nkind: kit\nname: Gothic cathedral kit\n/);
    expect((await one.call("knowledge_list", { kind: "kit" })).text).toBe(
      "kits/gothic_cathedral_kit [kit]: Component set of 2: corner tower, gatehouse.\nRead one with knowledge_read({name}). Packs are suggestions to weigh, not rules.",
    );
    expect((await one.call("component_set", { save_as: "empty one", clear: true })).text).toBe("cleared\nnothing saved: the set is empty\ncomponent set: empty");

    const two = await connect();
    expect((await two.call("component_set")).text).toBe("component set: empty");
    await two.call("component_set", { add: [{ prefab: "axiom/castle/keep" }] });
    const ld = await two.call("component_set", { load: "gothic cathedral kit" });
    expect(ld.text).toBe('loaded kit "Gothic cathedral kit" (kits/gothic_cathedral_kit, user)\ncomponent set (2):\n1. corner tower = gothic_tower_a — every corner\n2. gatehouse = gate_small');
    expect((await two.call("component_set", { load: "nope" })).text).toMatch(/^no kit "nope" \(have: Gothic cathedral kit\)/);
    expect((await two.call("component_set", { load: "x", clear: true })).isError).toBe(true);
  });

  it("stamp resolves a set label before library names and sheet cells (17, piece 1)", async () => {
    const { call } = await connect();
    await call("doc_new", { name: "parts" });
    await call("set_blocks", { blocks: [{ pos: [0, 0, 0], block: "oak_planks" }, { pos: [2, 0, 0], block: "granite" }, { pos: [2, 1, 0], block: "granite" }] });
    expect((await call("prefab_save", { name: "plank_post", box: { min: [0, 0, 0], max: [0, 0, 0] }, tags: ["k2"] })).isError).toBeFalsy();
    expect((await call("prefab_save", { name: "stone_post", box: { min: [2, 0, 0], max: [2, 1, 0] }, tags: ["k2"] })).isError).toBeFalsy();
    const sheet = await call("prefab_sheet", { tags: ["k2"] });
    expect(sheet.text).toContain("A1 plank_post 1×1×1 · B1 stone_post 1×1×2");

    await call("doc_new", { name: "site" });
    // Labels win over a library name ("plank_post") and over a sheet cell ("A1").
    await call("component_set", { add: [{ prefab: "stone_post", label: "plank_post" }, { prefab: "gate_small", label: "unused" }] });
    const byName = await call("stamp", { prefab: "plank_post", at: [0, 0, 0] });
    expect(byName.text).toMatch(/prefab stone_post at \(0,0,0\)/);
    await call("component_set", { clear: true, add: [{ prefab: "stone_post", label: "A1" }] });
    const byCell = await call("stamp", { prefab: "A1", at: [2, 0, 0] });
    expect(byCell.text).toMatch(/prefab stone_post at \(2,0,0\)/);
    // Not a constraint: names and cells outside the set still stamp.
    const cell = await call("stamp", { prefab: "B1", at: [4, 0, 0], as: "c" });
    expect(cell.text).toMatch(/prefab stone_post at \(4,0,0\)/);
    await call("component_set", { clear: true, add: [{ prefab: "stone_post", label: "Corner Tower" }] });
    const byLabel = await call("stamp", { prefab: "corner tower", at: [6, 0, 0] });
    expect(byLabel.text).toMatch(/prefab stone_post at \(6,0,0\)/);
    const plain = await call("stamp", { prefab: "plank_post", at: [8, 0, 0] });
    expect(plain.text).toMatch(/prefab plank_post at \(8,0,0\)/);
    const at = async (x: number, y: number) => (await call("query_block", { pos: [x, y, 0] })).text;
    expect([await at(0, 0), await at(0, 1), await at(2, 1), await at(4, 1), await at(6, 1), await at(8, 0), await at(8, 1)]).toEqual([
      "(0,0,0) granite · in: stone_post",
      "(0,1,0) granite · in: stone_post",
      "(2,1,0) granite · in: stone_post_2",
      "(4,1,0) granite · in: c",
      "(6,1,0) granite · in: stone_post_3",
      "(8,0,0) oak_planks · in: plank_post",
      "(8,1,0) air",
    ]);
  });

  it("appends the reminder line to prefab_search, prefab_sheet and stamp only, and only while the set has entries", async () => {
    const { call } = await connect();
    await call("doc_new", { name: "parts2" });
    await call("set_blocks", { blocks: [{ pos: [0, 0, 0], block: "granite" }] });
    await call("prefab_save", { name: "pebble", box: { min: [0, 0, 0], max: [0, 0, 0] }, tags: ["k2r"] });
    const named = ["prefab_search", "prefab_sheet", "stamp"] as const;
    const run = async () => ({
      prefab_search: (await call("prefab_search", { query: "pebble" })).text,
      prefab_sheet: (await call("prefab_sheet", { tags: ["k2r"] })).text,
      stamp: (await call("stamp", { prefab: "pebble", at: [0, 2, 0], as: "p" })).text,
      miss: (await call("prefab_search", { query: "zzzz" })).text,
      others: [(await call("doc_info")).text, (await call("fill", { box: { min: [3, 0, 0], max: [3, 0, 0] }, pattern: "dirt" })).text, (await call("knowledge_list")).text],
    });
    const empty = await run();
    for (const k of named) expect(empty[k]).not.toMatch(/set: /);
    expect(empty.miss).toBe("No prefabs match. Try fewer words or tags, or prefab_sheet to browse.");

    await call("component_set", { add: [{ prefab: "gothic_tower_a", label: "corner tower" }, { prefab: "gate_small" }] });
    const line = "set: corner tower = gothic_tower_a, gate_small";
    const full = await run();
    for (const k of named) expect(full[k].endsWith(`\n${line}`)).toBe(true);
    expect(full.miss).toBe(`No prefabs match. Try fewer words or tags, or prefab_sheet to browse.\n${line}`);
    for (const t of full.others) expect(t).not.toContain(line);

    await call("component_set", { clear: true });
    const cleared = await run();
    for (const k of named) expect(cleared[k]).not.toMatch(/set: /);
  });
});
