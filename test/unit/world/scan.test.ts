import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Vec3 } from "../../../src/core/region.js";
import { getCamera } from "../../../src/document/cameras.js";
import { buildPaletteIndexData, PaletteIndex } from "../../../src/palette/index.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { SheetRenderer } from "../../../src/palette/sheet.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { LiveLink } from "../../../src/world/live-link.js";
import { CHANNEL_INSTRUCTIONS, CHANNEL_METHOD, InGameRequests } from "../../../src/world/prompt.js";
import type { PlayerRef, SurfaceRequest, WireBox } from "../../../src/world/protocol/messages.js";
import { autoSyncHook, syncLink } from "../../../src/world/sync.js";
import { FakeHost, type FakeHostOptions } from "../../support/fake-host.js";
import { solidPng } from "../../helpers/fixtures.js";
import { fakeRegistry } from "../../helpers/registry.js";
import { memStack } from "../../helpers/stack.js";

/**
 * `/autosketch scan` on the MCP side (13, B4; briefs/release/Z, wave 2): the probe document and
 * `world_volumes`, against the fake host.
 *
 * Geometry: the player stands at (8.5, 64, 8.5), chunk (0, 0). Radius 1 gives the columns
 * (-16..31, -16..31), 48×48. From 4 below to 8 above the feet is y 60..72 (13 high), and the cap of
 * 3,328 blocks makes the full-block box 16×13×16 at (0, 60, 0)–(15, 72, 15). The probe's local
 * (0, 0, 0) is world (-16, 60, -16).
 */

const HOST: PlayerRef = { name: "Dev", uuid: "00000000-0000-4000-8000-000000000001" };
const O: Vec3 = [-16, 60, -16];
const local = (p: Vec3): Vec3 => [p[0] - O[0], p[1] - O[1], p[2] - O[2]];
const AT = { position: [8.5, 64, 8.5] as [number, number, number], eye: [8.5, 65.62, 8.5] as [number, number, number], yaw: 0, pitch: 0, facing: "south" as const };
const SCAN = { chunks: 1, chunksMax: 2, below: 4, above: 8, cap: 3328 };

const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-scan-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

let host: FakeHost | undefined;
let link: LiveLink | undefined;
let inGame: InGameRequests | undefined;
afterEach(async () => {
  inGame?.close();
  link?.close();
  await host?.close();
  host = link = inGame = undefined;
});

const ChannelNote = z.object({ method: z.literal(CHANNEL_METHOD), params: z.object({ content: z.string(), meta: z.record(z.string()) }) });

async function setup(hostOpts: FakeHostOptions = {}) {
  host = await FakeHost.start({ scan: SCAN, ...hostOpts });
  const session = new Session(tempDir());
  link = new LiveLink(session, { ackWaitMs: 2000, backoff: { minMs: 20, maxMs: 50 } });
  link.setSync(syncLink);
  session.world = link;
  session.callHooks.push(autoSyncHook(() => session.world));
  const server = createServer(fixtureContext(host.instanceDir), { session, channel: { instructions: CHANNEL_INSTRUCTIONS } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  const events: { content: string; meta: Record<string, string> }[] = [];
  client.setNotificationHandler(ChannelNote, (n) => void events.push(n.params));
  await Promise.all([server.connect(a), client.connect(b)]);
  inGame = new InGameRequests(link, {
    promptPlayers: [],
    idleMs: 60_000,
    activityMs: 0,
    subscribe: (fn) => session.subscribe(fn),
    notify: (content, meta) => server.server.notification({ method: CHANNEL_METHOD, params: { content, meta } } as never),
    listening: () => server.server.getClientCapabilities() !== undefined,
    host: session,
    log: () => {},
  });
  session.inGame = inGame;
  session.callHooks.push(inGame.modeRule);
  link.autoLink({ instanceDir: host.instanceDir, plugins: [], palettes: new PaletteBook() });
  await host.waitFor(() => link!.bridge.connected);
  return { session, client, host, events };
}

async function scan(h: FakeHost, events: unknown[], text = "the tower and the courtyard", context = {}) {
  const r = await h.playerAsk(HOST, text, { ...AT, ...context }, { mode: "scan" });
  expect(r).toMatchObject({ delivered: true });
  await h.waitFor(() => events.length >= 1);
}

const surfaces = (h: FakeHost) => h.received.filter((m): m is SurfaceRequest => m.type === "snapshot" && "kind" in m);

describe("the probe (13, B4)", () => {
  it("loads full blocks and the surface into a temporary read-only document before any link, and the views work on it", async () => {
    const { client, host, events, session } = await setup();
    host.set([5, 63, 5], "minecraft:stone"); // inside the full-block box
    host.set([5, 61, 5], "minecraft:andesite"); // under it, also inside the box
    host.set([30, 62, 30], "minecraft:grass_block"); // a surface block outside the box
    host.set([30, 50, 30], "minecraft:stone"); // under that surface: not read
    host.set([-10, 80, -10], "minecraft:oak_log"); // a surface block above the box
    host.set([6, 64, 5], "minecraft:oak_planks");
    await scan(host, events, "the tower and the courtyard", { target: { pos: [6, 64, 5], state: "minecraft:oak_planks", face: "west" } });
    expect(link!.state).not.toBe("linked");
    const doc = session.doc!;
    expect(doc.meta.name).toBe("probe");
    expect(doc.meta.source).toBe("world:probe minecraft:overworld (-16,-16)–(31,31)");
    const at = (p: Vec3) => doc.states.get(doc.voxels.get(...local(p)));
    expect(at([5, 63, 5])).toBe("minecraft:stone");
    expect(at([5, 61, 5])).toBe("minecraft:andesite");
    expect(at([30, 62, 30])).toBe("minecraft:grass_block");
    expect(at([30, 50, 30])).toBe("minecraft:air");
    expect(at([-10, 80, -10])).toBe("minecraft:oak_log");
    // Bounds: the scanned columns, from the box's bottom to the highest surface block.
    expect(doc.bounds).toEqual({ min: [0, 0, 0], max: [48, 21, 48] });
    // The surface read had no ceiling: the player stands under open sky.
    expect(surfaces(host)).toEqual([expect.not.objectContaining({ ceiling: expect.anything() })]);
    expect(events[0]!.content).toBe(
      'In-game scan request from Dev: "the tower and the courtyard". ' +
        "Scan mode: look around and set the volumes with world_volumes; edits and drafts (sandboxes, other documents) are refused while this request is open. " +
        'The probe is open as the read-only document "probe" (nothing is linked yet): the surface of 3×3 chunks (48×48 columns, local x 0–47, z 0–47), and full blocks in local (16, 0, 16)–(31, 12, 31) (16×13×16). ' +
        'Outside the full-block box each column holds only its top block: render({views:["top"]}) is a map of the surface. Set the volumes with world_volumes({work, context}) in this document\'s coordinates. ' +
        'Looking at minecraft:oak_planks (west face), saved as "target". Standing at (24, 4, 24) facing south; your view is saved as camera "player". ' +
        "Answer the player with world_reply (request 1); pass done: true when finished.",
    );
    expect(doc.selections.get("target")).toEqual({ min: local([6, 64, 5]), max: local([6, 64, 5]) });
    expect(getCamera(doc, "player")!.eye.map((c) => +c.toFixed(6))).toEqual([24, 5.12, 24]);
    // Read-only: every edit refused, nothing sent to the world.
    const fill = await client.callTool({ name: "fill", arguments: { box: { min: [16, 0, 16], max: [17, 1, 17] }, pattern: "stone" } });
    expect(fill.isError).toBe(true);
    expect(texts(fill)[0]).toMatch(/^The probe \(from scan request 1\) is a read-only look at the world around the player, so fill can't edit it; nothing in it reaches the world\./);
    expect(host.patchLog).toHaveLength(0);
    // The views work on it.
    const slice = await client.callTool({ name: "view_slice", arguments: { axis: "y", at: 3, region: { min: [16, 3, 16], max: [31, 3, 31] } } });
    expect(slice.isError).toBeFalsy();
    expect(texts(slice).join("\n")).toContain("stone");
    const render = await client.callTool({ name: "render", arguments: { views: ["top"], size: 128 } });
    expect(render.isError).toBeFalsy();
    expect((render.content as { type: string }[]).some((c) => c.type === "image")).toBe(true);
    // Never saved to the workspace.
    await session.flush();
    expect(existsSync(session.pathFor("probe"))).toBe(false);
  });

  it("reads the ceiling from the feet up when the player is covered", async () => {
    const { host, events, session } = await setup();
    host.set([8, 67, 8], "minecraft:stone"); // a roof over the player's head
    host.set([25, 66, 25], "minecraft:stone"); // a cave roof outside the box…
    host.set([25, 75, 25], "minecraft:grass_block"); // …under the surface
    await scan(host, events);
    expect(surfaces(host)).toEqual([expect.objectContaining({ kind: "surface", columns: { min: [-16, -16], max: [31, 31] }, ceiling: 64 })]);
    expect(events[0]!.content).toContain("You are covered, so each column's ceiling from local y 4 up is in it too.");
    const doc = session.doc!;
    const at = (p: Vec3) => doc.states.get(doc.voxels.get(...local(p)));
    expect(at([25, 66, 25])).toBe("minecraft:stone");
    expect(at([25, 75, 25])).toBe("minecraft:grass_block");
  });

  it("lists scan in the hello by default, and arrives without a probe when the mod sends no grant", async () => {
    const { host, events, session } = await setup({ features: ["modes", "volumes.set"] });
    expect(host.mcpModes).toEqual(["ask", "scan", "plan", "build"]);
    await scan(host, events);
    expect(events[0]!.content).toContain("No probe: the mod sent no scan grant");
    expect(session.doc).toBeUndefined();
  });
});

describe("world_volumes (13, B4)", () => {
  it("sets the volumes from probe coordinates; the link follows and replaces the probe", async () => {
    const { client, host, events, session } = await setup();
    host.set([5, 63, 5], "minecraft:stone");
    await scan(host, events);
    const r = await client.callTool({ name: "world_volumes", arguments: { work: { min: [18, 2, 18], max: [25, 9, 25] } } });
    expect(texts(r)[0]).toBe(
      "ok · world_volumes · work 8×8×8 at probe (18,2,18)–(25,9,25) (world (2,62,2)–(9,69,9)), the default context (+3) · link 2. " +
        "The game shows the outlines; linking follows on its own, replacing the open document, and the work volume's minimum corner becomes local (0,0,0).",
    );
    expect(host.volumes).toMatchObject({ dimension: "minecraft:overworld", work: { min: [2, 62, 2], max: [9, 69, 9] }, context: [{ min: [-1, 59, -1], max: [12, 72, 12] }] });
    await host.waitFor(() => link!.state === "linked");
    expect(session.doc!.meta.name).toBe("world");
    expect(session.doc!.states.get(session.doc!.voxels.get(3, 1, 3))).toBe("minecraft:stone"); // world (5, 63, 5)
    // The scan request's mode still holds on the linked document.
    const fill = await client.callTool({ name: "fill", arguments: { box: { min: [0, 0, 0], max: [0, 0, 0] }, pattern: "stone" } });
    expect(texts(fill)[0]).toContain("The open in-game scan request (request 1 from Dev) allows looking and setting the volumes only");
  });

  it("takes context boxes or a padding, in the linked document's coordinates when no probe is open", async () => {
    const WORK: WireBox = { min: [100, 64, 100], max: [109, 69, 109] };
    const { client, host } = await setup({ volumes: { work: WORK } });
    await host.waitFor(() => link!.state === "linked");
    const r = await client.callTool({ name: "world_volumes", arguments: { work: { min: [0, 0, 0], max: [3, 3, 3] }, context: { padding: 2 } } });
    expect(texts(r)[0]).toContain("work 4×4×4 at local (0,0,0)–(3,3,3) (world (100,64,100)–(103,67,103)), context +2");
    expect(host.volumes!.context).toEqual([{ min: [98, 62, 98], max: [105, 69, 105] }]);
    const r2 = await client.callTool({ name: "world_volumes", arguments: { work: { min: [0, 0, 0], max: [3, 3, 3] }, context: [{ min: [10, 0, 10], max: [12, 2, 12] }] } });
    expect(texts(r2)[0]).toContain("2 context boxes");
    expect(host.volumes!.context).toEqual([{ min: [99, 63, 99], max: [104, 68, 104] }, { min: [110, 64, 110], max: [112, 66, 112] }]); // the game put the seam first
  });

  it("is refused in ask and plan requests, without the mod feature, and with no probe or link", async () => {
    const { client, host, events } = await setup({ features: ["modes", "scan"] });
    const none = await client.callTool({ name: "world_volumes", arguments: { work: { min: [0, 0, 0], max: [1, 1, 1] } } });
    expect(texts(none)[0]).toContain("world_volumes takes coordinates in the scan probe or the linked document, and neither is open.");
    await scan(host, events);
    const old = await client.callTool({ name: "world_volumes", arguments: { work: { min: [18, 2, 18], max: [20, 4, 20] } } });
    expect(old.isError).toBe(true);
    expect(texts(old)[0]).toContain('doesn\'t support setting the volumes (its hello doesn\'t list "volumes.set")');
    expect(host.received.some((m) => m.type === "volumes.set")).toBe(false);
    // A plan request (the mod side of plan arrives with silo Y): the rule reads the open request.
    inGame!.stream.open({ id: 9, player: HOST, mode: "plan" });
    const plan = await client.callTool({ name: "world_volumes", arguments: { work: { min: [18, 2, 18], max: [20, 4, 20] } } });
    expect(texts(plan)[0]).toContain("The open in-game plan request (request 9 from Dev) allows looking and proposing only, so world_volumes can't change the volumes.");
  });
});

// -- helpers ------------------------------------------------------------------------------------

async function fixtureContext(root: string): Promise<InstanceContext> {
  const registry = fakeRegistry([{ id: "minecraft:andesite", tags: ["c:stones"] }, { id: "minecraft:stone", tags: [] }]);
  const stack = await memStack([["base", "base", { "assets/minecraft/textures/block/andesite.png": solidPng([130, 130, 130]) }]]);
  const palette = new PaletteIndex(await buildPaletteIndexData(stack, registry), registry);
  return { info: { name: "Fixture", mcVersion: "1.21.1", launcher: "generic", root }, stack, registry, palette, plugins: [], sheets: new SheetRenderer(palette, stack), book: new PaletteBook(), warnings: [], timings: {} };
}

function texts(r: Awaited<ReturnType<Client["callTool"]>>): string[] {
  return (r.content as { type: string; text: string }[]).filter((c) => c.type === "text").map((c) => c.text);
}
