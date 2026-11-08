import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

async function connect() {
  const workspace = mkdtempSync(join(tmpdir(), "autosketch-cam-"));
  roots.push(workspace);
  const session = new Session(workspace);
  const server = createServer(fixtureContext(), { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  return { session, call };
}

describe("camera tool and perspective renders over MCP", () => {
  it("saves, lists, shows, renders and removes cameras", async () => {
    const { session, call } = await connect();
    await call("doc_new", { name: "t", seed: 1 });
    // A hollow 9×9×9 box.
    await call("fill", { box: { min: [0, 0, 0], max: [8, 8, 8] }, pattern: "andesite" });
    await call("clear", { box: { min: [1, 1, 1], max: [7, 7, 7] } });
    await call("fill", { box: { min: [7, 3, 4], max: [7, 3, 4] }, pattern: "andesite", as: "post" });

    const saved = await call("camera", { name: "inside", eye: [4, 4, 4], target: [7, 4, 4], fov: 80 });
    expect(saved.isError).toBeFalsy();
    expect(textOf(saved)).toMatch(/saved camera inside: eye \(4,4,4\) target \(7,4,4\) fov 80°/);
    // An anchor target resolves to its block.
    const anchored = await call("camera", { name: "a", eye: [2, 2, 2], target: "post.center" });
    expect(textOf(anchored)).toMatch(/target \(7,3,4\)/);
    // A selection target aims at its centre; the fov is fitted.
    const framed = await call("camera", { name: "f", eye: [20, 4, 4], target: { sel: { min: [0, 0, 0], max: [8, 8, 8] } } });
    expect(textOf(framed)).toMatch(/target \(4,4,4\) fov (\d+(\.\d+)?)°/);
    expect(Number(/fov ([\d.]+)°/.exec(textOf(framed))![1])).toBeLessThan(70);

    expect(textOf(await call("camera", {}))).toMatch(/^a: [\s\S]*\nf: [\s\S]*\ninside: eye \(4,4,4\)/);
    expect(textOf(await call("camera", { name: "inside" }))).toMatch(/inside: eye \(4,4,4\) target \(7,4,4\) fov 80°/);
    expect((await call("camera", { name: "zzz" })).isError).toBe(true);

    const r = await call("render", { views: [{ camera: "inside" }, { eye: [4, 4, 4], target: { sel: { component: "post" } } }, "top"], size: 384, style: "flat" });
    expect(r.isError, textOf(r)).toBeFalsy();
    const caption = textOf(r);
    expect(caption).toMatch(/camera inside: eye \(4,4,4\) target \(7,4,4\) fov 80°/);
    expect(caption).toMatch(/perspective: eye \(4,4,4\) target \(7,3,4\)/);
    // raycast through the saved camera's centre pixel (first cell, 192×192) hits the post's west face.
    const id = /id (r\d+)/.exec(caption)![1];
    const hit = await call("raycast", { view: id, px: 96, py: 96 });
    expect(textOf(hit)).toMatch(/camera inside \(96,96\) → \(8,4,4\) andesite, west face/);

    expect(textOf(await call("camera", { name: "inside", delete: true }))).toMatch(/removed camera "inside"/);
    expect((await call("render", { views: [{ camera: "inside" }] })).isError).toBe(true);
    expect((await call("camera", { name: "x", eye: [1, 1, 1] })).isError).toBe(true);
    await session.close();
  });
});
