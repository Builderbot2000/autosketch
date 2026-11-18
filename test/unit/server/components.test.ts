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
});
