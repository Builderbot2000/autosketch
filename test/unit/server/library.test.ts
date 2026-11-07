import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { tempDir, writeTree } from "../../helpers/fixtures.js";
import { libraryContext } from "../library/fixture.js";

let base: string;
beforeAll(async () => {
  base = await tempDir("autosketch-srvlib-");
  // Never touch the real ~/autosketch or ~/.cache: library, cache and workspace all live in temp.
  vi.stubEnv("AUTOSKETCH_LIBRARY", join(base, "library"));
  vi.stubEnv("AUTOSKETCH_CACHE", join(base, "cache"));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(base, { recursive: true, force: true });
});

type Content = { type: string; text?: string; data?: string }[];
const textOf = (r: { content: unknown }) => (r.content as Content).filter((c) => c.type === "text").map((c) => c.text).join("\n");

async function connect() {
  const ctx = await libraryContext(join(base, "instance"));
  const server = createServer(Promise.resolve(ctx), { session: new Session(join(base, "ws")) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { ...r, text: textOf(r) };
  };
  return { client, call, ctx };
}

describe("library tools", () => {
  it("saves a prefab, browses the sheet, stamps a cell at a component anchor with a remap, and undoes it in one step", async () => {
    const { call } = await connect();
    await call("doc_new", { name: "src" });
    await call("set_blocks", {
      blocks: [
        { pos: [0, 0, 0], block: "oak_planks" },
        { pos: [1, 0, 0], block: "oak_planks" },
        { pos: [0, 1, 0], block: "oak_stairs[facing=south]" },
      ],
    });
    const saved = await call("prefab_save", { name: "stoop", box: { min: [0, 0, 0], max: [1, 1, 0] }, tags: ["entry"], anchors: { base: [0, 0, 0] }, roles: { wood: ["oak_planks"] } });
    expect(saved.isError).toBeFalsy();
    expect(saved.text).toMatch(/saved prefab "stoop"/);

    const search = await call("prefab_search", { query: "stoop" });
    expect(search.text).toMatch(/^stoop 2×1×2 \[entry\] anchors base\(0,0,0\) roles wood/);

    const sheet = await call("prefab_sheet", { tags: ["entry"] });
    expect((sheet.content as Content)[0]!.type).toBe("image");
    expect(sheet.text).toMatch(/A1 stoop 2×1×2/);

    await call("doc_new", { name: "dst" });
    await call("fill", { box: { min: [0, 0, 0], max: [4, 0, 4] }, material: "granite", as: "court" });
    await call("palette_pick", { name: "castle", sheet: "family:minecraft:andesite", roles: { trim: "A1" } });
    const st = await call("stamp", { prefab: "A1", at: "court.top", palette_remap: { wood: "palette:castle.trim" } });
    expect(st.isError).toBeFalsy();
    expect(st.text).toMatch(/^ok · stamp · 3 blocks changed/);
    expect(st.text).toMatch(/prefab stoop at \(2,1,2\) .* component: stoop/);
    const info = await call("doc_info");
    expect(info.text).toMatch(/andesite_stairs\[facing=south/);
    expect(info.text).toMatch(/stoop/);
    const undo = await call("undo");
    expect(undo.text).toMatch(/undid 1: #\d+ stamp stoop/);
    expect((await call("doc_info")).text).not.toMatch(/andesite/);

    const rot = await call("stamp", { prefab: "stoop", at: [0, 1, 0], rotate: 90, as: "turned" });
    expect(rot.isError).toBeFalsy();
    expect(rot.text).toMatch(/^ok · stamp · 3 blocks changed/);
    expect((await call("query_column", { x: 0, z: 0 })).text).toMatch(/y1 oak_planks, y2 oak_stairs\[facing=west/);
    expect((await call("query_column", { x: 0, z: 1 })).text).toMatch(/y1 oak_planks/);
  });

  it("saves a palette from one document and loads it into another, reporting missing families", async () => {
    const { call, ctx } = await connect();
    await call("doc_new", { name: "one", overwrite: true });
    await call("palette_pick", { name: "warm", sheet: "family:minecraft:oak_planks", roles: { wall: "A1" } });
    const ed = await call("palette_edit", { name: "warm", sheet: "family:minecraft:granite", add: { wall: "A1" } });
    expect(ed.text).toMatch(/oak_planks 50%.*granite 50%/);
    const sv = await call("palette_save", { name: "warm", tags: ["warm"] });
    expect(sv.text).toMatch(/saved library palette "warm"/);
    expect((await call("palette_list", { tags: ["warm"] })).text).toMatch(/library warm \[warm\]: roles wall/);

    ctx.book.delete("warm");
    await call("doc_new", { name: "two", overwrite: true });
    const ld = await call("palette_load", { name: "warm" });
    expect(ld.text).toMatch(/palette "warm"/);
    expect(ctx.book.get("warm")!.roles.wall!.map((m) => m.block)).toEqual(["minecraft:oak_planks", "minecraft:granite"]);

    // The starter palette names vanilla families this tiny instance lacks: each is reported, nothing substituted.
    const st = await call("palette_load", { name: "timber_cottage" });
    expect(st.isError).toBe(true);
    expect(st.text).toMatch(/missing: frame: minecraft:spruce_log is not in this instance; no colour saved/);
  });

  it("lists and reads knowledge packs, also as MCP resources; lists procedures; run_procedure waits for the sandbox", async () => {
    await writeTree(join(base, "library"), { "procedures/bay.js": "/** Window bay. @param face the face */\n" });
    const { client, call } = await connect();
    const list = await call("knowledge_list", { kind: "heuristic" });
    expect(list.text).toMatch(/heuristics\/roofs \[heuristic\]/);
    expect((await call("knowledge_read", { name: "roofs" })).text).toMatch(/Roof pitch/);

    const res = (await client.listResources()).resources.map((r) => r.uri);
    expect(res).toContain("autosketch://knowledge/heuristics/roofs");
    const read = await client.readResource({ uri: "autosketch://knowledge/heuristics/depth" });
    expect(read.contents[0]).toMatchObject({ mimeType: "text/markdown" });
    expect((read.contents[0] as { text: string }).text).toMatch(/Depth and layering/);

    expect((await call("procedure_list")).text).toMatch(/^bay\(face\): Window bay\./);
    const run = await call("run_procedure", { name: "bay" });
    expect(run.isError).toBe(true);
    expect(run.text).toMatch(/needs the script sandbox \(silo C\), which is not available yet/);
  });
});
