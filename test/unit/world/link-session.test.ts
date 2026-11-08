import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, describe, expect, it } from "vitest";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session, type CallInfo } from "../../../src/server/session.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

/** The session side of the link core (13, Event fan-out; briefs/world, contested files). */

const roots: string[] = [];
const tempWorkspace = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-link-session-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function fixtureContext(): Promise<InstanceContext> {
  const registry = fakeRegistry([{ id: "minecraft:andesite", tags: ["c:stones"] }]);
  const stack = await memStack([["base", "base", { "assets/minecraft/textures/block/andesite.png": solidPng([130, 130, 130]) }]]);
  const palette = new PaletteIndex(await buildPaletteIndexData(stack, registry), registry);
  return { info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root: "/fixture" }, stack, registry, palette, plugins: [], sheets: new SheetRenderer(palette, stack), book: new PaletteBook(), warnings: [], timings: {} };
}

async function connect(ctx: Promise<InstanceContext>, session: Session) {
  const server = createServer(ctx, { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const CALLS: [string, Record<string, unknown>][] = [
  ["doc_new", { name: "tower", seed: 7 }],
  ["fill", { box: { min: [0, 0, 0], max: [2, 3, 2] }, pattern: "andesite" }],
  ["checkpoint", { name: "c" }],
  ["fill", { box: { min: [0, 4, 0], max: [2, 4, 2] }, pattern: "andesite" }],
  ["restore", { name: "c" }],
  ["fill", { box: { min: [0, 4, 0], max: [2, 4, 2] }, pattern: "no_such_block_xyz" }],
  ["undo", {}],
  ["history", {}],
];

describe("session fan-out and call hooks", () => {
  it("leaves tool results and the journal unchanged with a listener subscribed, which sees call.* and doc.* events with observability off", async () => {
    const ctx = fixtureContext();
    const run = async (listen: boolean) => {
      const workspace = tempWorkspace();
      const session = new Session(workspace);
      const seen: string[] = [];
      if (listen) session.subscribe((e, doc) => seen.push(`${doc}:${e.kind}${"tool" in e ? `:${e.tool}` : ""}`));
      const client = await connect(ctx, session);
      const results = [];
      for (const [name, args] of CALLS) results.push(await client.callTool({ name, arguments: args }));
      const journal = session.doc!.journal.entries.map((e) => [e.seq, e.op, e.summary, e.after.length]);
      await session.close();
      return { results: JSON.parse(JSON.stringify(results).replaceAll(workspace, "<workspace>")) as unknown, journal, seen };
    };
    const plain = await run(false);
    const listened = await run(true);
    expect(listened.results).toEqual(plain.results);
    expect(listened.journal).toEqual(plain.journal);
    expect(listened.seen).toContain("base:call.start:fill");
    expect(listened.seen).toContain("base:call.end:fill");
    expect(listened.seen.filter((k) => k === "base:doc.op")).toHaveLength(2);
    expect(listened.seen).toContain("base:doc.undo");
  });

  it("runs call hooks around every tool, inside its scope, and can append to the result", async () => {
    const session = new Session(tempWorkspace());
    const calls: CallInfo[] = [];
    session.callHooks.push({
      before: (c) => void calls.push(c),
      after: (c, r) => (c.tool === "fill" ? { ...r, content: [...r.content, { type: "text", text: "world: 48 placed, 0 skipped (hand-edited), 0 rejected" }] } : r),
    });
    const client = await connect(fixtureContext(), session);
    await client.callTool({ name: "doc_new", arguments: { name: "t" } });
    const r = await client.callTool({ name: "fill", arguments: { box: { min: [0, 0, 0], max: [3, 2, 3] }, pattern: "andesite" } });
    const texts = (r.content as { text: string }[]).map((c) => c.text);
    expect(texts.at(-1)).toBe("world: 48 placed, 0 skipped (hand-edited), 0 rejected");
    expect(calls.map((c) => [c.tool, c.scope, c.doc, c.mutating])).toEqual([
      ["doc_new", "base", false, false],
      ["fill", "base", true, true],
    ]);
    await session.close();
  });
});
