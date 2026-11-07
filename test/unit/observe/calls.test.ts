import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { LoggedEvent } from "../../../src/core/events.js";
import { Settings } from "../../../src/core/settings.js";
import { EventBus } from "../../../src/observe/bus.js";
import { startObserve } from "../../../src/observe/index.js";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { noteError, observeCall } from "../../../src/server/observe-call.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { fail, image, text } from "../../../src/server/tools/shared.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

const roots: string[] = [];
const tempWorkspace = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-obs-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

async function fixtureContext(): Promise<InstanceContext> {
  const registry = fakeRegistry([{ id: "minecraft:andesite", tags: ["c:stones"] }, { id: "minecraft:oak_planks", tags: ["minecraft:planks"] }]);
  const stack = await memStack([["base", "base", { "assets/minecraft/textures/block/andesite.png": solidPng([130, 130, 130]) }]]);
  const palette = new PaletteIndex(await buildPaletteIndexData(stack, registry), registry);
  return {
    info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root: "/fixture" },
    stack,
    registry,
    palette,
    plugins: [],
    sheets: new SheetRenderer(palette, stack),
    book: new PaletteBook(),
    warnings: [],
    timings: {},
  };
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
  ["fill", { box: { min: [0, 0, 0], max: [2, 3, 2] }, material: "andesite" }],
  ["checkpoint", { name: "base" }],
  ["fill", { box: { min: [0, 4, 0], max: [2, 4, 2] }, material: "no_such_block_xyz" }],
  ["undo", {}],
  ["doc_info", {}],
];

describe("tool-call events (12, phase 1)", () => {
  it("logs call.start and call.end around each tool, and tool results are identical with the log on or off", async () => {
    const ctx = fixtureContext();
    const run = async (workspace: string, observed: boolean) => {
      const session = new Session(workspace);
      const obs = observed ? startObserve({ workspace, settings: Settings.from([], {}), sessionId: "s", flushMs: 5 }) : undefined;
      if (obs) session.events = obs.sink();
      const client = await connect(ctx, session);
      const results = [];
      for (const [name, args] of CALLS) results.push(await client.callTool({ name, arguments: args }));
      await session.close();
      await obs?.close();
      return JSON.parse(JSON.stringify(results).replaceAll(workspace, "<workspace>")) as typeof results;
    };
    const plain = await run(tempWorkspace(), false);
    const workspace = tempWorkspace();
    const logged = await run(workspace, true);
    expect(logged).toEqual(plain);

    const events = readFileSync(join(workspace, "tower", "observe", "s", "events.ndjson"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as LoggedEvent);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    const summary = events.map((e) => (e.kind.startsWith("call.") ? `${e.kind} ${(e as { tool: string }).tool}` : e.kind));
    expect(summary).toEqual([
      "call.start doc_new", "session.open", "call.end doc_new",
      "call.start fill", "doc.op", "call.end fill",
      "call.start checkpoint", "doc.checkpoint", "call.end checkpoint",
      "call.start fill", "call.end fill",
      "call.start undo", "doc.undo", "call.end undo",
      "call.start doc_info", "call.end doc_info",
      "session.close",
    ]);
    const ends = events.filter((e): e is Extract<LoggedEvent, { kind: "call.end" }> => e.kind === "call.end");
    expect(ends.map((e) => e.ok)).toEqual([true, true, true, false, true, true]);
    const starts = events.filter((e) => e.kind === "call.start") as Extract<LoggedEvent, { kind: "call.start" }>[];
    expect(ends.map((e) => e.call)).toEqual(starts.map((e) => e.call));
    const firstText = (plain[1]!.content as { text: string }[]).map((c) => c.text.length).reduce((a, b) => a + b, 0);
    expect(ends[1]).toMatchObject({ tool: "fill", chars: firstText, images: 0, pixels: 0 });
  });

  it("logs call.refused for errors carrying a refusal code, and counts image pixels", async () => {
    const bus = new EventBus();
    const seen: LoggedEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const sink = bus.sink();
    const refusing = observeCall(() => sink, "scope_fork", async (_args: { scope?: string }) =>
      noteError(fail("work volume overlaps job s1"), Object.assign(new Error("work volume overlaps job s1"), { refusal: "lock_overlap" })),
    );
    const r = await refusing({ scope: "s2" });
    expect(r).toEqual(fail("work volume overlaps job s1"));
    const png = Buffer.from((await import("pngjs")).PNG.sync.write(Object.assign(new (await import("pngjs")).PNG({ width: 4, height: 3 }))));
    await observeCall(() => sink, "render", async () => image(png, "cap"))();
    await observeCall(() => sink, "plain", async () => text("hello"))();

    expect(seen.map((e) => ({ ...e, t: 0, ...("ms" in e ? { ms: 0 } : {}) }))).toEqual([
      { v: 1, seq: 1, t: 0, doc: "base", kind: "call.start", call: expect.any(Number), tool: "scope_fork", scope: "s2" },
      { v: 1, seq: 2, t: 0, doc: "base", kind: "call.refused", call: expect.any(Number), tool: "scope_fork", scope: "s2", code: "lock_overlap", message: "work volume overlaps job s1" },
      { v: 1, seq: 3, t: 0, doc: "base", kind: "call.end", call: expect.any(Number), tool: "scope_fork", scope: "s2", ms: 0, ok: false, chars: 27, images: 0, pixels: 0 },
      { v: 1, seq: 4, t: 0, doc: "base", kind: "call.start", call: expect.any(Number), tool: "render" },
      { v: 1, seq: 5, t: 0, doc: "base", kind: "call.end", call: expect.any(Number), tool: "render", ms: 0, ok: true, chars: 3, images: 1, pixels: 12 },
      { v: 1, seq: 6, t: 0, doc: "base", kind: "call.start", call: expect.any(Number), tool: "plain" },
      { v: 1, seq: 7, t: 0, doc: "base", kind: "call.end", call: expect.any(Number), tool: "plain", ms: 0, ok: true, chars: 5, images: 0, pixels: 0 },
    ]);
  });
});
