import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalEntries, ComponentSet, knownEntries, nearestNames } from "../../../src/library/component-set.js";
import { findKit, kitStem, listKnowledge, parseKitEntries, readKit, writeKit } from "../../../src/library/knowledge.js";
import { scanPrefabs } from "../../../src/library/prefabs.js";
import type { LibraryRoot } from "../../../src/library/roots.js";
import { tempDir, writeTree } from "../../helpers/fixtures.js";

describe("component set record (17, piece 1)", () => {
  it("adds in order, replaces by label or prefab in place, removes, clears", () => {
    const s = new ComponentSet();
    expect(s.format()).toBe("component set: empty");
    expect(s.reminderLine()).toBe("");
    s.add([{ prefab: "gothic_tower_a", label: "corner tower" }, { prefab: "gate_small", label: "gatehouse" }, { prefab: "buttress_a" }]);
    expect(s.reminderLine()).toBe("set: corner tower = gothic_tower_a, gatehouse = gate_small, buttress_a");
    // Same label: replaced in place.
    s.add([{ prefab: "gothic_tower_b", label: "Corner Tower", notes: " taller " }]);
    expect(s.entries).toEqual([
      { prefab: "gothic_tower_b", label: "Corner Tower", notes: "taller" },
      { prefab: "gate_small", label: "gatehouse" },
      { prefab: "buttress_a" },
    ]);
    // Same prefab: replaced in place, label added.
    s.add([{ prefab: "buttress_a", label: "buttress" }]);
    expect(s.entries[2]).toEqual({ prefab: "buttress_a", label: "buttress" });
    // Matching two entries (one by label, one by prefab): one entry remains, at the first position.
    s.add([{ prefab: "gate_small", label: "corner tower" }]);
    expect(s.entries).toEqual([{ prefab: "gate_small", label: "corner tower" }, { prefab: "buttress_a", label: "buttress" }]);
    expect(s.format()).toBe("component set (2):\n1. corner tower = gate_small\n2. buttress = buttress_a");
    expect(s.resolve(" CORNER tower")).toBe("gate_small");
    expect(s.resolve("gate_small")).toBeUndefined();
    expect(s.labelFor("buttress_a")).toBe("buttress");
    expect(s.remove(["buttress", "nope"])).toEqual(["nope"]);
    expect(s.size).toBe(1);
    s.remove(["gate_small"]);
    expect(s.size).toBe(0);
    s.add([{ prefab: "a" }]);
    s.clear();
    expect(s.reminderLine()).toBe("");
  });

  it("maps a stamp reference through set labels only, and appends the reminder only while non-empty", () => {
    const s = new ComponentSet();
    expect(s.stampRef("corner tower")).toBe("corner tower");
    expect(s.remind("ok")).toBe("ok");
    s.add([{ prefab: "gothic_tower_a", label: "corner tower" }, { prefab: "gate_small", label: "B2" }, { prefab: "buttress_a" }]);
    expect(s.stampRef(" Corner Tower ")).toBe("gothic_tower_a");
    expect(s.stampRef("B2")).toBe("gate_small");
    expect(s.stampRef("buttress_a")).toBe("buttress_a");
    expect(s.stampRef("park_bench")).toBe("park_bench");
    expect(s.remind("ok\nmore")).toBe("ok\nmore\nset: corner tower = gothic_tower_a, B2 = gate_small, buttress_a");
    s.clear();
    expect(s.remind("ok")).toBe("ok");
  });

  it("suggests the nearest names for typos", () => {
    const names = ["gothic_tower_a", "gothic_tower_b", "gate_small", "axiom/castle/keep", "park_bench"];
    expect(nearestNames("gothic_towr_a", names)).toEqual(["gothic_tower_a", "gothic_tower_b"]);
    expect(nearestNames("keep", names)).toEqual(["axiom/castle/keep"]);
    expect(nearestNames("tower", names)).toEqual(["gothic_tower_a", "gothic_tower_b"]);
    expect(nearestNames("zzz", names)).toEqual([]);
  });
});

describe("kits (17, piece 2)", () => {
  let base: string;
  let roots: LibraryRoot[];
  beforeAll(async () => {
    base = await tempDir("autosketch-kits-");
    roots = [
      { path: join(base, "user"), label: "user", kind: "library", readOnly: false },
      { path: join(base, "starter"), label: "starter", kind: "library", readOnly: true },
    ];
    await writeTree(join(base, "user"), { "prefabs/gothic_tower_a/prefab.schem": "x", "prefabs/gate_small/prefab.schem": "x", "prefabs/gate_small/prefab.json": { name: "Small gate" } });
    await writeTree(join(base, "starter"), {
      "knowledge/kits/castle.md": "---\nkind: kit\nname: Castle kit\ntags: [castle]\nentries:\n  - prefab: gothic_tower_a\n    label: tower\n    notes: \"corners, 4 of them\"\n  - gate_small\n  - { prefab: gate_smal, label: lost }\n---\nNotes here.\n",
      "knowledge/heuristics/castle.md": "---\nkind: heuristic\n---\nNot a kit.\n",
    });
  });
  afterAll(() => rm(base, { recursive: true, force: true }));

  it("parses flow maps, block maps and bare names, with quotes and commas", () => {
    expect(
      parseKitEntries(
        '---\nkind: kit\nentries:\n  - { prefab: buttress_flying_a, label: buttress, notes: every third bay }\n  - { prefab: "a,b", label: \'it\'\'s\', notes: "x: \\"y\\"" }\n  # comment\n  - prefab: t\n    label: corner tower\nsummary: after\n---\nbody',
      ),
    ).toEqual([
      { prefab: "buttress_flying_a", label: "buttress", notes: "every third bay" },
      { prefab: "a,b", label: "it's", notes: 'x: "y"' },
      { prefab: "t", label: "corner tower" },
    ]);
    expect(parseKitEntries("no frontmatter")).toEqual([]);
  });

  it("finds kits by name, title or stem; only kind kit", async () => {
    expect((await findKit(roots, "castle kit")).name).toBe("kits/castle");
    expect((await findKit(roots, "castle")).name).toBe("kits/castle");
    expect((await findKit(roots, "kits/castle")).kind).toBe("kit");
    await expect(findKit(roots, "roofs")).rejects.toThrow(/no kit "roofs" \(have: Castle kit\)/);
    expect((await listKnowledge(roots, { kind: "kit" })).map((e) => e.name)).toEqual(["kits/castle"]);
    const r = await readKit(roots, "Castle kit");
    expect(r.notes).toBe("Notes here.");
    const all = await scanPrefabs(roots);
    const known = knownEntries(all, r.entries);
    expect(known.entries).toEqual([{ prefab: "gothic_tower_a", label: "tower", notes: "corners, 4 of them" }, { prefab: "gate_small" }]);
    expect(known.warnings).toEqual(['skipped no prefab "gate_smal" (nearest: gate_small)']);
  });

  it("canonicalises display names and refuses unknown names with the nearest", async () => {
    const all = await scanPrefabs(roots);
    expect(canonicalEntries(all, [{ prefab: "small GATE", label: "g" }])).toEqual([{ prefab: "gate_small", label: "g" }]);
    expect(() => canonicalEntries(all, [{ prefab: "gothic_towr_a" }, { prefab: "gate_small" }])).toThrow(/^no prefab "gothic_towr_a" \(nearest: gothic_tower_a\)\. Nothing was changed/);
  });

  it("writes a new kit to the writable root, then updates only its entries", async () => {
    expect(kitStem("  Gothic cathedral kit! ")).toBe("gothic_cathedral_kit");
    const w = await writeKit(roots, "Gothic cathedral kit", [{ prefab: "gothic_tower_a", label: "corner tower", notes: "taller, if room" }, { prefab: "gate_small" }]);
    expect(w).toEqual({ file: join(base, "user", "knowledge", "kits", "gothic_cathedral_kit.md"), replaced: false });
    const text = await readFile(w.file, "utf8");
    expect(text).toBe(
      "---\nkind: kit\nname: Gothic cathedral kit\nsummary: \"Component set of 2: corner tower, gate_small.\"\nentries:\n  - { prefab: gothic_tower_a, label: corner tower, notes: \"taller, if room\" }\n  - { prefab: gate_small }\n---\n",
    );
    const listed = await listKnowledge(roots, { kind: "kit" });
    expect(listed.map((e) => [e.name, e.title, e.summary])).toEqual([
      ["kits/gothic_cathedral_kit", "Gothic cathedral kit", "Component set of 2: corner tower, gate_small."],
      ["kits/castle", "Castle kit", "Notes here."],
    ]);
    // The player edits the kit by hand; saving again keeps their notes, tags and title.
    await writeFile(w.file, text.replace("kind: kit\n", "kind: kit\ntags: [gothic]\n")+ "Used with palette castle.\n");
    const again = await writeKit(roots, "gothic cathedral kit", [{ prefab: "gate_small", label: "gatehouse" }]);
    expect(again.replaced).toBe(true);
    expect(await readFile(w.file, "utf8")).toBe(
      "---\nkind: kit\ntags: [gothic]\nname: Gothic cathedral kit\nsummary: \"Component set of 2: corner tower, gate_small.\"\nentries:\n  - { prefab: gate_small, label: gatehouse }\n---\nUsed with palette castle.\n",
    );
    expect((await readKit(roots, "gothic_cathedral_kit")).entries).toEqual([{ prefab: "gate_small", label: "gatehouse" }]);
  });
});
