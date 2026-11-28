import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runHook } from "../../../src/cli/hook.js";
import type { ObserveEvent } from "../../../src/core/events.js";
import { Settings } from "../../../src/core/settings.js";
import { startObserve, type Observer } from "../../../src/observe/index.js";
import { CanvasReads } from "../../../src/world/canvas.js";
import { WorldMap } from "../../../src/world/map.js";
import { InGameRequests } from "../../../src/world/prompt.js";
import { MCP_FEATURES, type PlayerRef, type PromptMessage, type WireBox } from "../../../src/world/protocol/messages.js";
import { WorldView } from "../../../src/world/view.js";
import { ENABLED, instanceContext, rcon, setVolumes, startMcp, until, worldBlock, worldBlocks, type Mcp, type Vec3 } from "./harness.js";
import type { Rcon } from "./rcon.js";

/**
 * End to end on Craftoria for the canvas and request control (docs/design/19-canvas-and-requests.md,
 * step K4; canvas set, step Z1): a 64×64-chunk canvas, three brush moves with no local coordinate
 * change, an undo after moving back, a stop while a patch is in flight (unstarted patches dropped,
 * the one in progress finished), and a queued prompt delivered when the turn ends.
 *
 * The MCP is wired as `server/index.ts` wires it for these parts: in-game requests with the
 * lifecycle's call hook first, observe/ with its turn-end route and port file (in a temporary run
 * folder), the world view, the canvas reads and `world_map`. A headless server has no player, so the
 * player's `prompt` and `/autosketch stop` are handed to the MCP as the mod would send them
 * (`InGameRequests.onPrompt`, `onControl`), as `requests.test.ts` does; the turn's end is posted by
 * the hook command itself (`runHook`, what the plugin's `Stop` hook runs) to the route it finds in
 * the port file. Everything after that is checked against the real mod and world.
 */

const X0 = 9216; // chunk 576: away from the other files' areas (x 1000–1600, 3000–3256, 5000, 6000, 7008–7170)
const Z0 = 1024; // chunk 64
const CHUNKS = 64;
const OW = "minecraft:overworld";
const P: PlayerRef = { name: "E2E", uuid: "e2e00000-0000-4000-8000-000000000019" };
/** The canvas as the mod widens it: whole chunk columns, the full build height. */
const CANVAS: WireBox = { min: [X0, -64, Z0], max: [X0 + 16 * CHUNKS - 1, 319, Z0 + 16 * CHUNKS - 1] };
const ORIGIN: Vec3 = [X0, -64, Z0];
const local = (p: Vec3): Vec3 => [p[0] - ORIGIN[0], p[1] - ORIGIN[1], p[2] - ORIGIN[2]];
const localBox = (b: { min: Vec3; max: Vec3 }) => ({ min: local(b.min), max: local(b.max) });

/** Brushes, world boxes, all inside the canvas and far apart (A near one corner, B and C hundreds of blocks off). */
const A = { min: [X0 + 16, -61, Z0 + 16] as Vec3, max: [X0 + 47, -40, Z0 + 47] as Vec3 };
const B = { min: [X0 + 640, -61, Z0 + 96] as Vec3, max: [X0 + 671, -40, Z0 + 127] as Vec3 };
const C = { min: [X0 + 160, -61, Z0 + 880] as Vec3, max: [X0 + 191, -40, Z0 + 911] as Vec3 };
/** The brush for the stop: 128×64×128 blocks, one fill of 128×48×128 (786,432 blocks, about 40 ticks at the mod's 20,000 per tick). */
const S = { min: [X0 + 512, -61, Z0 + 512] as Vec3, max: [X0 + 639, 2, Z0 + 639] as Vec3 };
const BIG = { min: [X0 + 512, -60, Z0 + 512] as Vec3, max: [X0 + 639, -13, Z0 + 639] as Vec3 };
const BIG_BLOCKS = 128 * 48 * 128;
const PT: Vec3 = [X0 + 20, -60, Z0 + 20]; // in A only

describe.skipIf(!ENABLED)("e2e world: canvas, brush and request control (19, K4)", () => {
  let r: Rcon;
  let mcp: Mcp;
  let inGame: InGameRequests;
  let observer: Observer;
  let worldMap: WorldMap;
  let runDir: string;
  const events: string[] = [];
  const patches: Extract<ObserveEvent, { kind: "world.patch" }>[] = [];
  let nextId = 19_000;

  const prompt = async (text: string): Promise<number> => {
    const m: PromptMessage = {
      type: "prompt",
      id: ++nextId,
      player: P,
      text,
      context: { dimension: OW, position: [PT[0] + 0.5, PT[1], PT[2] + 0.5], eye: [PT[0] + 0.5, PT[1] + 1.62, PT[2] + 0.5], yaw: 0, pitch: 30, facing: "south" },
      mode: "build",
    };
    await inGame.onPrompt(m);
    return m.id;
  };
  /** What the plugin's `Stop` hook runs: `autosketch hook turn-end`, reading Claude Code's hook input. */
  const turnEnd = () => runHook(["turn-end"], { dir: runDir, input: async () => JSON.stringify({ session_id: "e2e-z1", hook_event_name: "Stop", stop_hook_active: false }) });
  const state = (id: number) => inGame.lifecycle.entry(id)?.state;

  beforeAll(async () => {
    const ctx = await instanceContext();
    r = await rcon();
    // The brushes' areas: clear above the flat ground so reruns start from the same world.
    for (const b of [A, B, C, S]) await r.command(`forceload add ${b.min[0]} ${b.min[2]} ${b.max[0]} ${b.max[2]}`);
    for (const b of [A, B, C])
      expect(await r.command(`fill ${b.min[0]} -60 ${b.min[2]} ${b.max[0]} -40 ${b.max[2]} minecraft:air`)).not.toMatch(/maximum|not loaded/i);
    for (let x = S.min[0]; x <= S.max[0]; x += 16)
      for (let z = S.min[2]; z <= S.max[2]; z += 32)
        expect(await r.command(`fill ${x} -60 ${z} ${x + 15} -12 ${z + 31} minecraft:air`)).not.toMatch(/maximum|not loaded/i);
    mcp = await startMcp({ ackWaitMs: 0, features: [...MCP_FEATURES] });
    expect(mcp.link.bridge.hello?.features).toEqual(expect.arrayContaining(["requests", "canvas"]));
    await r.command("autosketch clear");
    await r.command("autosketch canvas clear");
    const session = mcp.session;
    runDir = mkdtempSync(join(tmpdir(), "autosketch-e2e-run-"));
    observer = startObserve({ workspace: mcp.workspace, settings: Settings.from(["--set", "observe.http=true"], {}), getDoc: () => session.doc, runDir });
    expect(await observer.ready).toBeTruthy();
    inGame = new InGameRequests(mcp.link, {
      promptPlayers: [P.name],
      idleMs: 600_000,
      activityMs: 0,
      subscribe: (fn) => session.subscribe(fn),
      notify: async (content) => void events.push(content),
      listening: () => true,
      touch: () => session.touch(),
      turnEnds: (fn) => observer.bus.subscribe((e) => e.kind === "turn.end" && fn()),
      baseDoc: () => session.doc,
      log: () => {},
    });
    session.inGame = inGame;
    session.callHooks.unshift(inGame.lifecycle.callHook);
    session.callHooks.push(inGame.modeRule);
    const view = new WorldView({ bridge: mcp.link.bridge, request: () => inGame.current?.id, dimension: () => mcp.link.volumes?.dimension, dataVersion: () => mcp.link.bridge.hello?.game.dataVersion ?? 0, palettes: () => ctx.book });
    session.worldView = view;
    session.canvasReads = new CanvasReads({ frame: () => mcp.link.canvasFrame(), view: () => view, note: (line) => mcp.link.addNote(line) });
    worldMap = new WorldMap({ bridge: mcp.link.bridge, linked: () => (mcp.link.state === "linked" && mcp.link.volumes ? { origin: mcp.link.volumes.origin, dimension: mcp.link.volumes.dimension } : undefined), player: () => view.context });
    session.worldMap = worldMap;
    session.subscribe((e) => void (e.kind === "world.patch" && patches.push(e)));
    mcp.link.autoLink({ instanceDir: ctx.info.root, plugins: ctx.plugins, palettes: ctx.book });
  }, 300_000);

  afterAll(async () => {
    inGame?.close();
    worldMap?.close();
    await r?.command("autosketch clear").catch(() => {});
    await r?.command("autosketch canvas clear").catch(() => {});
    await r?.command("forceload remove all").catch(() => {});
    await observer?.close();
    await mcp?.close();
    if (runDir) rmSync(runDir, { recursive: true, force: true });
    r?.close();
  }, 60_000);

  it("a 64×64-chunk canvas: three brush moves keep every local coordinate; undo outside the brush is refused, and after moving back it undoes in the world", async () => {
    await setVolumes(r, A, undefined, mcp.link);
    await until(() => mcp.link.state === "linked", 30_000, "the automatic link");
    // The canvas, as select confirm sets it (canvas.set): 64×64 chunks around the brush.
    const set = await mcp.link.bridge.request({ type: "canvas.set", dimension: OW, box: { min: [X0 + 3, 0, Z0 + 5], max: [X0 + 16 * CHUNKS - 2, 0, Z0 + 16 * CHUNKS - 9] } });
    expect(set).toMatchObject({ type: "canvas", dimension: OW, box: CANVAS });
    await until(() => mcp.link.state === "linked" && mcp.link.volumes?.origin.join() === ORIGIN.join(), 30_000, "the relink onto the canvas frame");
    expect(mcp.link.volumes?.canvas).toEqual(CANVAS);
    expect(await mcp.call("doc_info")).toContain("canvas");

    const map = await mcp.client.callTool({ name: "world_map", arguments: {} });
    const mapText = (map.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    expect(map.isError, mapText).toBeFalsy();
    expect(mapText).toContain("64×64");

    await mcp.call("set_blocks", { blocks: [{ pos: local(PT), block: "minecraft:andesite" }] });
    await until(async () => (await worldBlock(mcp.link, PT)) === "minecraft:andesite", 10_000, "the andesite in the world");
    await mcp.call("select", { sel: localBox({ min: [PT[0] - 2, PT[1], PT[2] - 2], max: [PT[0] + 2, PT[1] + 4, PT[2] + 2] }), name: "spot" });
    const doc = mcp.session.doc!;
    const head = doc.journal.headSeq;

    for (const to of [B, C]) {
      const t = await mcp.call("world_volumes", { work: localBox(to) });
      expect(t).toContain("local (0,0,0) stays");
      expect(mcp.link.volumes?.work).toEqual({ min: to.min, max: to.max });
      expect(mcp.link.volumes?.origin).toEqual(ORIGIN);
      expect(mcp.session.doc).toBe(doc);
      expect(doc.journal.headSeq).toBe(head);
      expect(mcp.link.toLocal(PT)).toEqual(local(PT));
      // The old brush reads through the world view, at the same local coordinates.
      expect(await mcp.call("query_block", { pos: local(PT) })).toContain("andesite");
      // Undo would write outside the brush.
      const u = await mcp.tryCall("undo", {});
      expect(u.isError).toBe(true);
      expect(u.text).toContain("outside the brush");
      expect(u.text).toContain("Nothing was written.");
    }
    const back = await mcp.call("world_volumes", { work: localBox(A) });
    expect(back).toContain("The brush moved from");
    expect(mcp.link.volumes?.origin).toEqual(ORIGIN);
    expect(mcp.session.doc).toBe(doc);
    expect(doc.journal.headSeq).toBe(head);
    expect(doc.selections.has("spot")).toBe(true);
    expect(doc.getState(...local(PT))).toBe("minecraft:andesite");

    await mcp.call("undo", {});
    await until(async () => (await worldBlock(mcp.link, PT)) === "minecraft:air", 10_000, "the undo in the world");
    expect(doc.getState(...local(PT))).toBe("minecraft:air");
  }, 300_000);

  it("a stop while a patch is in flight: the patch in progress finishes, unstarted ones are dropped; a queued prompt is delivered when the turn ends", async () => {
    expect(await mcp.call("world_volumes", { work: localBox(S) })).toContain("The brush moved from");
    const before = events.length;
    const first = await prompt("fill the field with stone");
    expect(events.length).toBe(before + 1);
    expect(state(first)).toBe("working");

    patches.length = 0;
    await mcp.call("fill", { box: localBox(BIG), pattern: "minecraft:stone" });
    const g1: Vec3 = [BIG.min[0], BIG.max[1] + 1, BIG.min[2]];
    const g2: Vec3 = [BIG.min[0] + 1, BIG.max[1] + 1, BIG.min[2]];
    await mcp.call("set_blocks", { blocks: [{ pos: local(g1), block: "minecraft:gold_block" }] });
    await mcp.call("set_blocks", { blocks: [{ pos: local(g2), block: "minecraft:gold_block" }] });
    const second = await prompt("then put a lantern on it");
    expect(events.length).toBe(before + 1); // queued, not delivered
    expect(state(second)).toBe("queued");

    // The player's /autosketch stop (request.control from the server half).
    inGame.onControl({ type: "request.control", player: P, action: "stop" });
    expect(state(first)).toBe("stopping");
    const refused = await mcp.tryCall("query_block", { pos: local(g1) });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("The player stopped this request.");

    await until(() => patches.length === 3, 30_000, "three patch results");
    const seen = JSON.stringify(patches.map(({ patch, blocks, applied, dropped }) => ({ patch, blocks, applied, dropped })));
    const big = patches.find((p) => p.blocks === BIG_BLOCKS)!;
    expect(big, seen).toMatchObject({ applied: BIG_BLOCKS });
    expect(big.dropped).toBeUndefined();
    expect(patches.filter((p) => p.dropped === "dropped").map((p) => p.blocks), seen).toEqual([1, 1]);
    const world = await worldBlocks(mcp.link, BIG.min, BIG.max);
    expect([...world.states.values()].every((s) => s === "minecraft:stone")).toBe(true);
    expect(await worldBlock(mcp.link, g1)).toBe("minecraft:air");
    expect(await worldBlock(mcp.link, g2)).toBe("minecraft:air");

    // The turn ends (the plugin's Stop hook): stopped, the refusal lifts, the queued prompt goes out.
    await turnEnd();
    await until(() => state(first) === "stopped", 5_000, "the stopped line");
    await until(() => events.length === before + 2, 5_000, "the queued prompt delivered");
    expect(events.at(-1)).toContain("then put a lantern on it");
    expect(state(second)).toBe("working");
    // The dropped patches' blocks were resynced from the world.
    expect(await mcp.call("query_block", { pos: local(g1) })).toContain("air");
    expect(mcp.session.doc!.getState(...local(g2))).toBe("minecraft:air");
    expect(mcp.session.doc!.getState(...local(BIG.max))).toBe("minecraft:stone");
    await turnEnd();
    await until(() => state(second) === "done", 5_000, "the second request done");
    expect(inGame.lifecycle.entry(second)?.noTurnSignal).toBeFalsy();
  }, 300_000);
});
