import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { tempDir } from "../../helpers/fixtures.js";
import { libraryContext } from "../library/fixture.js";

let base: string;
beforeAll(async () => {
  base = await tempDir("autosketch-srvgen-");
  vi.stubEnv("AUTOSKETCH_LIBRARY", join(base, "library"));
  vi.stubEnv("AUTOSKETCH_CACHE", join(base, "cache"));
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(base, { recursive: true, force: true });
});

type Content = { type: string; text?: string }[];
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
  return { client, call };
}

describe("generator, anchor and script tools", () => {
  it("builds through the tools, echoes anchors, and runs scripts as one undo step", async () => {
    const { client, call } = await connect();
    await call("doc_new", { name: "gen" });
    await call("fill", { box: { min: [0, 0, 0], max: [4, 2, 4] }, material: "andesite", mode: "walls", as: "hut" });

    const roof = await call("roof", { sel: { component: "hut" }, material: "oak_planks", style: "hip" });
    expect(roof.isError).toBeFalsy();
    expect(roof.text).toMatch(/^ok · roof · \d+ blocks changed/);
    expect(roof.text).toMatch(/hip roof, pitch 1, eaves at y=3/);
    expect(roof.text).toMatch(/component: roof/);

    const anchor = await call("anchor", { at: { face: "hut.front", u: 0.5, v: 0 } });
    expect(anchor.text).toBe('hut.front(u 0.5, v 0) = (2,0,4)');
    expect((await call("anchor", { component: "hut", name: "gate", at: "hut.front" })).text).toBe("anchor hut.gate = 2,1,4 (from hut.front = (2,1,4))");
    expect((await call("anchor", { component: "hut" })).text).toMatch(/gate\* \(2,1,4\)/);

    const col = await call("column", { at: { anchor: "hut.gate", offset: [0, -1, 2] }, material: "oak_log", height: 2 });
    expect(col.text).toMatch(/at: hut\.gate \+ \(0,-1,2\) = \(2,0,6\)/);

    const s = await call("run_script", { source: 'fill(sel.box([10,0,0],[11,0,0]), "andesite"); log("hi"); return component("hut").box;' });
    expect(s.text).toMatch(/^ok · script · 2 blocks changed · box \(10,0,0\)–\(11,0,0\)/);
    expect(s.text).toMatch(/returned: \{"min":\[0,0,0\],"max":\[4,2,4\]\}/);
    expect(s.text).toMatch(/log:\nhi/);
    expect((await call("undo")).isError).toBeFalsy();

    const bad = await call("run_script", { source: 'fill(sel.box([20,0,0],[21,0,0]), "andesite");\nnope();' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toBe("script error at line 2: ReferenceError: 'nope' is not defined; nothing was changed");

    const dts = await client.readResource({ uri: "autosketch://script/api.d.ts" });
    expect((dts.contents[0] as { text: string }).text).toMatch(/declare function tower\(material: Material, opts: TowerOpts\)/);
  });
});
