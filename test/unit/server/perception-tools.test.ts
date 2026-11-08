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
  const registry = fakeRegistry([{ id: "minecraft:andesite" }]);
  const stack = await memStack([["base", "base", { "assets/minecraft/textures/block/andesite.png": solidPng([130, 130, 130]) }]]);
  const palette = new PaletteIndex(await buildPaletteIndexData(stack, registry), registry);
  return { info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root: "/fixture" }, stack, registry, palette, plugins: [], sheets: new SheetRenderer(palette, stack), book: new PaletteBook(), warnings: [], timings: {} };
}

const textOf = (r: unknown) => ((r as { content: { type: string; text?: string }[] }).content.filter((c) => c.type === "text").map((c) => c.text).join("\n"));

describe("perception tools over MCP", () => {
  it("render emits render.produced, and selections pick from its pixels", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "autosketch-perc-"));
    roots.push(workspace);
    const session = new Session(workspace);
    const seen: ObserveEvent[] = [];
    session.events = { enabled: true, emit: (e) => void seen.push(e) };
    const server = createServer(fixtureContext(), { session });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });

    await call("doc_new", { name: "t", seed: 1 });
    await call("fill", { box: { min: [0, 0, 0], max: [3, 3, 3] }, material: "andesite" });
    const r = await call("render", { views: ["top"], size: 256, style: "flat", highlight: { changed: "op:-1" } });
    expect(r.isError).toBeFalsy();
    expect(seen.filter((e) => e.kind === "render.produced")).toEqual([{ kind: "render.produced", view: "top", size: [256, 256], source: "tool" }]);
    const id = /id (r\d+)/.exec(textOf(r))![1];
    // The whole image, seen from above: the top layer of the cube.
    const s = await call("select", { sel: { view_box: { render: id, rect: [0, 0, 255, 255] } } });
    expect(textOf(s)).toMatch(/16 blocks/);
    const through = await call("select", { sel: { view_box: { rect: [0, 0, 255, 255], depth: "through" } } });
    expect(textOf(through)).toMatch(/64 blocks/);
    await session.close();
  });
});
