import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ObserveEvent } from "../../../src/core/events.js";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function fixtureContext(): Promise<InstanceContext> {
  const registry = fakeRegistry([{ id: "minecraft:andesite" }, { id: "minecraft:diorite" }]);
  const stack = await memStack([["base", "base", {
    "assets/minecraft/textures/block/andesite.png": solidPng([130, 130, 130]),
    "assets/minecraft/textures/block/diorite.png": solidPng([220, 220, 220]),
  }]]);
  const palette = new PaletteIndex(await buildPaletteIndexData(stack, registry), registry);
  return { info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root: "/fixture" }, stack, registry, palette, plugins: [], sheets: new SheetRenderer(palette, stack), book: new PaletteBook(), warnings: [], timings: {} };
}

const textOf = (r: unknown) => (r as { content: { type: string; text?: string }[] }).content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

async function start() {
  const workspace = mkdtempSync(join(tmpdir(), "autosketch-scope-"));
  roots.push(workspace);
  const session = new Session(workspace);
  const seen: ObserveEvent[] = [];
  session.events = { enabled: true, emit: (e) => void seen.push(e) };
  const server = createServer(fixtureContext(), { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args });
  return { session, seen, call };
}

describe("scope tools over MCP (11)", () => {
  it("forks, requires scope on edits while open, works in the sandbox, and merges as one undo step", async () => {
    const { session, seen, call } = await start();
    await call("doc_new", { name: "castle", size: [32, 16, 32], seed: 1 });
    await call("fill", { box: { min: [0, 0, 0], max: [31, 0, 31] }, pattern: "andesite" });
    const f = await call("scope_fork", { work: { min: [8, 1, 8], max: [15, 8, 15] }, brief: "Build the keep", spec: { levels: { floor2: 5 } } });
    expect(f.isError).toBeFalsy();
    const ft = textOf(f);
    expect(ft).toMatch(/^forked s1 from base \(depth 1\) · work \(8,1,8\)–\(15,8,15\), 512 blocks, locked here/);
    expect(ft).toContain('Pass scope:"s1" on EVERY');
    expect(ft).toContain("floor2 4");

    // Every document tool takes scope; an edit without it is refused while the job is open.
    const bare = await call("fill", { box: { min: [0, 1, 0], max: [0, 1, 0] }, pattern: "diorite" });
    expect(bare.isError).toBe(true);
    expect(textOf(bare)).toMatch(/must name its target: scope:"<id>".*scope:"base"/);
    expect(seen.find((e) => e.kind === "call.refused")).toMatchObject({ tool: "fill", code: "scope_required" });
    // Reads without scope go to the base document.
    expect(textOf(await call("query_block", { pos: [8, 0, 8] }))).toMatch(/andesite/);
    expect((await call("fill", { box: { min: [0, 1, 0], max: [0, 1, 0] }, pattern: "diorite", scope: "base" })).isError).toBeFalsy();
    expect(textOf(await call("fill", { box: { min: [0, 1, 0], max: [0, 1, 0] }, pattern: "diorite", scope: "s9" }))).toMatch(/no open scope "s9"/);

    // In the sandbox: local frame, writes outside the work volume refused, perception marks context.
    const out = await call("fill", { box: { min: [0, 0, 0], max: [8, 0, 0] }, pattern: "diorite", scope: "s1" });
    expect(textOf(out)).toMatch(/outside the work volume of scope s1/);
    expect(seen.filter((e) => e.kind === "call.refused").map((e) => (e as { code: string }).code)).toEqual(["scope_required", "scope_unknown", "outside_work_volume"]);
    expect((await call("fill", { box: { min: [0, 0, 0], max: [7, 3, 7] }, pattern: "diorite", mode: "walls", scope: "s1" })).isError).toBeFalsy();
    expect(textOf(await call("query_block", { pos: [0, -1, 0], scope: "s1" }))).toMatch(/andesite/);
    const slice = textOf(await call("view_slice", { axis: "y", at: -1, scope: "s1" }));
    expect(slice).toMatch(/\| ctx$/m);
    expect(textOf(await call("view_slice", { axis: "y", at: 0, scope: "s1" }))).toMatch(/\| ctx x-3\.\.-1,8\.\.10$/m);
    const r = await call("render", { views: ["iso_se"], size: 256, scope: "s1" });
    expect(textOf(r)).toMatch(/196 read-only context blocks ghosted/);
    expect(textOf(await call("render", { views: ["iso_se"], size: 256, scope: "s1", context: "hide" }))).toMatch(/context hidden/);
    // Scripts in the sandbox obey the same rules.
    expect(textOf(await call("run_script", { source: 'fill(sel.box([0,5,0],[9,5,0]), "diorite");', scope: "s1" }))).toMatch(/outside the work volume/);

    // Opening another document is refused while a job is open.
    expect(textOf(await call("doc_new", { name: "other" }))).toMatch(/Can't start a new document while 1 scoped job is open/);
    expect(textOf(await call("scope_list"))).toMatch(/^s1 · from base · depth 1 · open \d+s · lock \(8,1,8\)–\(15,8,15\) \(512 blocks\) · 1 op · "Build the keep"$/);

    const m = textOf(await call("scope_merge", { scope: "s1", report: "Walls of the keep up to y=4." }));
    expect(m).toMatch(/^merged s1 into base as op #\d+ \(one undo step\) · lock released\nreport: Walls of the keep/);
    expect(m).toMatch(/changes: 112 positions changed in \(8,1,8\)–\(15,4,15\)/);
    expect(textOf(await call("query_block", { pos: [8, 1, 8] }))).toMatch(/diorite/);
    expect(seen.map((e) => e.kind).filter((k) => k.startsWith("scope."))).toEqual(["scope.fork", "scope.merge"]);
    // No scope open: scope is optional again, and one undo reverts the whole merge.
    expect(textOf(await call("undo"))).toMatch(/undid 1: #\d+ merge s1/);
    expect(textOf(await call("query_block", { pos: [8, 1, 8] }))).toMatch(/air/);
    expect(textOf(await call("scope_list"))).toBe("No scoped jobs are open.");
    await session.close();
  });

  it("refuses over-nested and overlapping forks with their codes, and abandons", async () => {
    const { session, seen, call } = await start();
    await call("doc_new", { name: "c2", size: [16, 16, 16], seed: 1 });
    expect(textOf(await call("scope_fork", { work: { min: [0, 0, 0], max: [3, 3, 3] }, brief: "x" }))).toMatch(/^Small enough to do directly\./);
    expect(textOf(await call("scope_fork", { work: { min: [0, 0, 0], max: [7, 7, 7] }, context: { expand: 2 }, brief: "x" }))).toMatch(/was renamed \{"padding": n\}/);
    expect(textOf(await call("scope_fork", { work: { min: [0, 0, 0], max: [15, 9, 15] }, brief: "x" }))).toMatch(/^This is most of your own job/);
    await call("scope_fork", { work: { min: [0, 0, 0], max: [7, 7, 7] }, brief: "a" });
    expect(textOf(await call("scope_fork", { work: { min: [4, 0, 0], max: [11, 7, 7] }, brief: "b", scope: "base" }))).toMatch(/overlaps the lock held by job s1/);
    expect(textOf(await call("scope_abandon", { scope: "s1" }))).toBe("abandoned s1 · lock released, nothing merged");
    expect(seen.filter((e) => e.kind === "call.refused").map((e) => (e as { code: string }).code)).toEqual(["nest_too_small", "nest_too_large", "lock_overlap"]);
    expect(seen.filter((e) => e.kind === "scope.abandon")).toEqual([{ kind: "scope.abandon", scope: "s1", reason: "call" }]);
    await session.close();
  });
});
