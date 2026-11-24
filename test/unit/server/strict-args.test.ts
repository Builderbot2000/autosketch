import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ObserveEvent } from "../../../src/core/events.js";
import { createServer, unknownArguments } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { smallContext } from "../../helpers/context.js";

/** Unknown tool arguments are refused, not stripped (05, *Unknown arguments*; 18, piece 5). */

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const textOf = (r: unknown) => (r as { content: { type: string; text?: string }[] }).content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

async function start() {
  const workspace = mkdtempSync(join(tmpdir(), "autosketch-strict-"));
  roots.push(workspace);
  const session = new Session(workspace);
  const seen: ObserveEvent[] = [];
  session.events = { enabled: true, emit: (e) => void seen.push(e) };
  const server = createServer(smallContext(), { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { session, seen, call, client };
}

const refusals = (seen: ObserveEvent[]) => seen.filter((e) => e.kind === "call.refused").map((e) => (e as { code: string }).code);

describe("unknown tool arguments", () => {
  it("refuses an unknown argument on a mutating tool, naming it and the accepted ones, and edits nothing", async () => {
    const { session, seen, call } = await start();
    expect((await call("doc_new", { name: "t", size: [8, 8, 8] })).isError).toBeFalsy();
    const r = await call("fill", { sel: { min: [0, 0, 0], max: [1, 0, 0] }, pattern: "stone_bricks", mdoe: "hollow" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^fill has no argument "mdoe", so the call was refused\. It takes: .*\bsel\b.*\bpattern\b.*\bmode\b.*\bscope\b/);
    expect(refusals(seen)).toEqual(["unknown_argument"]);
    const doc = session.require();
    expect(doc.getState(0, 0, 0)).toBe("minecraft:air");
    expect(doc.getState(1, 0, 0)).toBe("minecraft:air");
  });

  it("names every unknown argument at once", async () => {
    const { call } = await start();
    await call("doc_new", { name: "t", size: [8, 8, 8] });
    const r = await call("clear", { sel: { min: [0, 0, 0], max: [1, 1, 1] }, foo: 1, bar: 2 });
    expect(textOf(r)).toMatch(/^clear has no arguments "foo", "bar", so the call was refused\./);
  });

  it("refuses an unknown argument on a read-only tool too", async () => {
    const { seen, call } = await start();
    await call("doc_new", { name: "t", size: [8, 8, 8] });
    const r = await call("doc_info", { verbose: true });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^doc_info has no argument "verbose"/);
    expect(refusals(seen)).toEqual(["unknown_argument"]);
  });

  it("refuses fill({view:\"world\"}) as a world-view edit and leaves the document unchanged", async () => {
    const { session, seen, call } = await start();
    await call("doc_new", { name: "t", size: [8, 8, 8] });
    await call("fill", { sel: { min: [0, 0, 0], max: [0, 0, 0] }, pattern: "cobblestone" });
    const r = await call("fill", { sel: { min: [0, 0, 0], max: [2, 0, 0] }, pattern: "stone_bricks", view: "world" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^fill has no view argument, so view: "world" is refused rather than editing the open document\. The world view is a read-only look/);
    expect(refusals(seen)).toEqual(["world_view_read_only"]);
    const doc = session.require();
    expect(doc.getState(0, 0, 0)).toBe("minecraft:cobblestone");
    expect(doc.getState(1, 0, 0)).toBe("minecraft:air");
    expect(doc.getState(2, 0, 0)).toBe("minecraft:air");
  });

  it("still accepts every declared argument, scope and view where declared", async () => {
    const { call } = await start();
    await call("doc_new", { name: "t", size: [8, 8, 8] });
    const f = await call("fill", { sel: { min: [0, 0, 0], max: [1, 1, 1] }, pattern: "stone_bricks", mode: "fill", scope: "base" });
    expect(f.isError).toBeFalsy();
    const s = await call("select", { sel: { min: [0, 0, 0], max: [1, 1, 1] }, name: "a" });
    expect(s.isError).toBeFalsy();
  });

  it("lists every tool's input schema as closed (additionalProperties: false)", async () => {
    const { client } = await start();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(20);
    for (const t of tools) expect([t.name, (t.inputSchema as { additionalProperties?: unknown }).additionalProperties]).toEqual([t.name, false]);
  });

  it("unknownArguments: view on a read-only tool without it is an ordinary unknown argument", () => {
    expect(unknownArguments("doc_info", ["scope"], false, { view: "world" })).toMatchObject({ refusal: "unknown_argument" });
    expect(unknownArguments("fill", ["sel", "view"], true, { view: "world" })).toBeUndefined();
    expect(unknownArguments("doc_list", [], false, { x: 1 })?.message).toBe('doc_list has no argument "x", so the call was refused. It takes no arguments.');
  });
});
