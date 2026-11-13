import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENABLED, instanceContext, killServer, rcon, setVolumes, startMcp, startServer, until, worldBlock, worldBlocks, type Mcp, type Vec3 } from "./harness.js";
import type { Rcon } from "./rcon.js";
import type { Document } from "../../../src/document/document.js";

/**
 * End-to-end scenarios (docs/briefs/world/R-end-to-end.md, *Scenarios*; docs/design/10, e2e world
 * tier) against a running server with the mod. Each scenario sets its own work volume in its own
 * patch of a flat world (ground at y = -61), so they don't see each other's blocks.
 */

const X0 = 1000;
const Z0 = 1000;
/** A work volume for scenario n: 16×12×16 from the grass layer up, 64 blocks apart along x. */
const work = (n: number) => ({ min: [X0 + 64 * n, -61, Z0] as Vec3, max: [X0 + 64 * n + 15, -50, Z0 + 15] as Vec3 });

describe.skipIf(!ENABLED)("e2e world: scenarios", () => {
  let r: Rcon;
  let mcp: Mcp;

  beforeAll(async () => {
    await instanceContext();
    r = await rcon();
    await r.command(`forceload add ${X0 - 16} ${Z0 - 16} ${X0 + 64 * 8 + 32} ${Z0 + 32}`);
    // Clear the scenario area above the ground, so reruns start from the same world.
    for (let n = 0; n < 8; n++) {
      const w = work(n);
      await r.command(`fill ${w.min[0] - 4} -60 ${w.min[2] - 4} ${w.max[0] + 40} -40 ${w.max[2] + 4} minecraft:air`);
    }
    mcp = await startMcp();
  }, 300_000);

  afterAll(async () => {
    await mcp?.close();
    await r?.command("autosketch clear").catch(() => {});
    r?.close();
  });

  it("links a work volume with a distant reference box: the agent reads the reference but can't write it", async () => {
    const w = work(0);
    // A reference tower 30 blocks east of the work volume, outside the default context.
    const ref = { min: [w.max[0] + 30, -60, Z0] as Vec3, max: [w.max[0] + 32, -55, Z0 + 2] as Vec3 };
    await r.command(`fill ${ref.min.join(" ")} ${ref.max.join(" ")} minecraft:stone_bricks`);
    await setVolumes(r, w, ref, mcp.link);
    const opened = await mcp.call("doc_open", { world: true });
    expect(opened).toContain("Linked to the world (minecraft:overworld)");
    expect(opened).toContain("context 2 boxes");
    // Local = world − work min.
    const refLocal: Vec3 = [ref.min[0] - w.min[0], ref.min[1] - w.min[1], ref.min[2] - w.min[2]];
    expect(await mcp.call("query_block", { pos: refLocal })).toContain("stone_bricks");
    const refused = await mcp.tryCall("fill", { box: { min: refLocal, max: refLocal }, pattern: "minecraft:gold_block" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("outside the work volume");
    expect(refused.text).toContain("Nothing was written");
    expect(await worldBlock(mcp.link, ref.min)).toBe("minecraft:stone_bricks");
    // Grass under the work volume came in with the snapshot.
    expect(await mcp.call("query_block", { pos: [0, 0, 0] })).toContain("grass_block");
  });

  it("builds a small house with ops, a script and a stamp, and the world matches the cache", async () => {
    const w = work(1);
    await setVolumes(r, w, undefined, mcp.link);
    await mcp.call("doc_open", { world: true });
    const floor = await mcp.call("fill", { box: { min: [1, 1, 1], max: [9, 1, 9] }, pattern: "minecraft:oak_planks" });
    expect(floor).toMatch(/world: 81 placed, 0 skipped \(hand-edited\), 0 rejected/);
    const walls = await mcp.call("fill", { box: { min: [1, 2, 1], max: [9, 5, 9] }, pattern: "minecraft:spruce_planks", mode: "walls" });
    expect(walls).toMatch(/world: 128 placed/);
    const script = await mcp.call("run_script", { source: 'fill({ box: { min: [1, 6, 1], max: [9, 6, 9] } }, "minecraft:cobblestone");' });
    expect(script).toMatch(/world: 81 placed/);
    const door = await mcp.call("set_blocks", { blocks: [{ pos: [5, 2, 1], block: "minecraft:oak_door[facing=north]" }] });
    expect(door).toMatch(/world: \d+ placed, 0 skipped/);
    const stamp = await mcp.call("stamp", { prefab: "lamp_post", at: [12, 1, 12] });
    expect(stamp).toMatch(/world: \d+ placed, 0 skipped \(hand-edited\), 0 rejected/);
    // Every position of the work volume: world == cache.
    const world = await worldBlocks(mcp.link, w.min, w.max);
    const doc = mcp.link.doc!;
    const diffs: string[] = [];
    for (const [k, s] of world.states) {
      const [x, y, z] = k.split(",").map(Number) as Vec3;
      const local = doc.getState(x - w.min[0], y - w.min[1], z - w.min[2]);
      if (local !== s) diffs.push(`${k}: world ${s}, cache ${local}`);
    }
    expect(diffs).toEqual([]);
    expect(world.states.get(`${w.min[0] + 5},${w.min[1] + 1},${w.min[2] + 5}`)).toBe("minecraft:oak_planks");
  });

  it("a hand edit reaches the cache before the next op, and a contents-only edit is skipped by the precondition", async () => {
    const w = work(2);
    await setVolumes(r, w, undefined, mcp.link);
    await mcp.call("doc_open", { world: true });
    await mcp.call("fill", { box: { min: [0, 1, 0], max: [4, 1, 4] }, pattern: "minecraft:stone" });
    // (a) The player places a block where the next op writes: the tracker's dirty notice syncs it
    // into the cache before the call, so the agent's op is built on the world's block.
    const hand: Vec3 = [w.min[0] + 2, w.min[1] + 2, w.min[2] + 2];
    await r.command(`setblock ${hand.join(" ")} minecraft:diamond_block`);
    await until(() => mcp.link.isDirty(), 5000, "dirty notice");
    expect(await mcp.call("query_block", { pos: [2, 2, 2] })).toContain("diamond_block");
    const hist = await mcp.call("history", {});
    expect(hist).toMatch(/world[ _]sync/);
    // (b) A contents-only edit isn't tracked; the NBT hash in the precondition catches it.
    await mcp.call("set_blocks", { blocks: [{ pos: [3, 2, 3], block: "minecraft:chest[facing=north]" }] });
    const chest: Vec3 = [w.min[0] + 3, w.min[1] + 2, w.min[2] + 3];
    await r.command(`item replace block ${chest.join(" ")} container.0 with minecraft:diamond 5`);
    const out = await mcp.call("fill", { box: { min: [3, 2, 3], max: [3, 2, 3] }, pattern: "minecraft:glass" });
    expect(out).toContain("world: 0 placed, 1 skipped (hand-edited), 0 rejected");
    expect(await worldBlock(mcp.link, chest)).toMatch(/^minecraft:chest\[/);
    expect(await mcp.call("query_block", { pos: [3, 2, 3] })).toContain("chest");
    const items = JSON.stringify(mcp.link.doc!.getBlockEntity(3, 2, 3));
    expect(items).toContain("minecraft:diamond");
  });

  it("undo across a sync is refused, then forced with overwriteHandEdits", async () => {
    const w = work(3);
    await setVolumes(r, w, undefined, mcp.link);
    await mcp.call("doc_open", { world: true });
    await mcp.call("fill", { box: { min: [0, 1, 0], max: [3, 1, 3] }, pattern: "minecraft:stone" });
    const hand: Vec3 = [w.min[0] + 1, w.min[1] + 1, w.min[2] + 1];
    await r.command(`setblock ${hand.join(" ")} minecraft:gold_block`);
    await until(() => mcp.link.isDirty(), 5000, "dirty notice");
    await mcp.call("history", {}); // the auto-sync runs before this call
    const refused = await mcp.tryCall("undo", {});
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("overwriteHandEdits");
    expect(await worldBlock(mcp.link, hand)).toBe("minecraft:gold_block");
    // Forced: the sync entry is undone and pushed, so the world goes back to the cache's stone.
    const forced = await mcp.call("undo", { overwriteHandEdits: true });
    expect(forced).toMatch(/world: 1 placed, 0 skipped \(hand-edited\), 0 rejected/);
    expect(await worldBlock(mcp.link, hand)).toBe("minecraft:stone");
    // Then the fill itself undoes normally, and redo brings it back, at the same world positions.
    expect(await mcp.call("undo", {})).toMatch(/world: 16 placed/);
    expect(await worldBlock(mcp.link, [w.min[0] + 3, w.min[1] + 1, w.min[2] + 3])).toBe("minecraft:air");
    expect(await mcp.call("redo", {})).toMatch(/world: 16 placed/);
    expect(await worldBlock(mcp.link, [w.min[0] + 3, w.min[1] + 1, w.min[2] + 3])).toBe("minecraft:stone");
    expect(await worldBlock(mcp.link, [w.min[0] + 4, w.min[1] + 1, w.min[2] + 3])).toBe("minecraft:air");
  });

  it("restore, relink and a re-opened document keep patches at the right world positions", async () => {
    const w = work(4);
    await setVolumes(r, w, undefined, mcp.link);
    await mcp.call("doc_open", { world: true });
    await mcp.call("checkpoint", { name: "empty" });
    await mcp.call("fill", { box: { min: [2, 1, 2], max: [2, 3, 2] }, pattern: "minecraft:oak_log" });
    await mcp.call("fill", { box: { min: [4, 1, 4], max: [4, 1, 4] }, pattern: "minecraft:bricks" });
    const restored = await mcp.call("restore", { name: "empty" });
    expect(restored).toMatch(/world: 4 placed/);
    expect(await worldBlock(mcp.link, [w.min[0] + 2, w.min[1] + 2, w.min[2] + 2])).toBe("minecraft:air");
    // A relink to a work volume 5 blocks east: local (0,1,0) is now world min + (5,1,0).
    const w2 = { min: [w.min[0] + 5, w.min[1], w.min[2]] as Vec3, max: [w.max[0] + 5, w.max[1], w.max[2]] as Vec3 };
    await setVolumes(r, w2, undefined, mcp.link);
    await until(() => mcp.link.volumes?.origin.join() === w2.min.join(), 10_000, "relink");
    await mcp.call("fill", { box: { min: [0, 1, 0], max: [0, 1, 0] }, pattern: "minecraft:emerald_block" });
    expect(await worldBlock(mcp.link, [w2.min[0], w2.min[1] + 1, w2.min[2]])).toBe("minecraft:emerald_block");
    // The document opened again by a new MCP session on the same server.
    await mcp.close();
    mcp = await startMcp();
    await mcp.call("doc_open", { world: true });
    expect(await mcp.call("query_block", { pos: [0, 1, 0] })).toContain("emerald_block");
    await mcp.call("fill", { box: { min: [1, 1, 0], max: [1, 1, 0] }, pattern: "minecraft:lapis_block" });
    expect(await worldBlock(mcp.link, [w2.min[0] + 1, w2.min[1] + 1, w2.min[2]])).toBe("minecraft:lapis_block");
    expect(await mcp.call("undo", {})).toMatch(/world: 1 placed/);
    expect(await worldBlock(mcp.link, [w2.min[0] + 1, w2.min[1] + 1, w2.min[2]])).toBe("minecraft:air");
  });

  it("a fork and merge with a hand edit inside the lock keeps the hand edit", async () => {
    const w = work(5);
    await setVolumes(r, w, undefined, mcp.link);
    await mcp.call("doc_open", { world: true });
    const fork = await mcp.call("scope_fork", { work: { box: { min: [2, 1, 2], max: [9, 8, 9] } }, brief: "a brick floor" });
    const id = /forked (\S+)/.exec(fork)![1]!;
    await mcp.call("fill", { scope: id, box: { min: [0, 0, 0], max: [7, 0, 7] }, pattern: "minecraft:bricks" });
    // The player edits inside the locked volume while the job works.
    const hand: Vec3 = [w.min[0] + 5, w.min[1] + 1, w.min[2] + 5];
    await r.command(`setblock ${hand.join(" ")} minecraft:glass`);
    await until(() => mcp.link.isDirty(), 5000, "dirty notice");
    await mcp.call("history", { scope: "base" });
    const merged = await mcp.call("scope_merge", { scope: id, report: "floor done" });
    expect(merged).toMatch(/world: 63 placed, 0 skipped/);
    expect(await worldBlock(mcp.link, hand)).toBe("minecraft:glass");
    expect(await worldBlock(mcp.link, [w.min[0] + 2, w.min[1] + 1, w.min[2] + 2])).toBe("minecraft:bricks");
    expect(await mcp.call("query_block", { pos: [5, 1, 5] })).toContain("glass");
  });

  it("modded blocks from Craftoria round-trip with their NBT; states the registry gets wrong are rejected, never written", async () => {
    const w = work(6);
    await r.command(`setblock ${w.min[0] + 1} -60 ${w.min[2] + 1} create:cogwheel`);
    await r.command(`setblock ${w.min[0] + 2} -60 ${w.min[2] + 1} framedblocks:framed_cube`);
    await r.command(`setblock ${w.min[0] + 3} -60 ${w.min[2] + 1} create:mechanical_press[facing=north]`);
    await r.command(`setblock ${w.min[0] + 4} -60 ${w.min[2] + 1} minecraft:chest[facing=north]{Items:[{Slot:0b,id:"minecraft:diamond",count:3}]}`);
    await setVolumes(r, w, undefined, mcp.link);
    await mcp.call("doc_open", { world: true });
    const copied = await mcp.call("copy", { box: { min: [1, 1, 1], max: [4, 1, 1] }, by: [0, 0, 2] });
    expect(copied).toContain("world: 4 placed, 0 skipped (hand-edited), 0 rejected");
    const src = await worldBlocks(mcp.link, [w.min[0] + 1, -60, w.min[2] + 1], [w.min[0] + 4, -60, w.min[2] + 1]);
    const dst = await worldBlocks(mcp.link, [w.min[0] + 1, -60, w.min[2] + 3], [w.min[0] + 4, -60, w.min[2] + 3]);
    expect([...dst.states.values()]).toEqual([...src.states.values()]);
    // Create rewrites its kinetic keys as the copy loads (NeedsSpeedUpdate); compare the rest.
    const strip = (m: Map<string, unknown>) => [...m.values()].map((v) => JSON.stringify(v).replace(/"NeedsSpeedUpdate":\{[^}]*\},?/g, ""));
    expect(strip(dst.nbt)).toEqual(strip(src.nbt));
    expect(dst.states.get(`${w.min[0] + 1},-60,${w.min[2] + 3}`)).toBe("create:cogwheel[axis=y,waterlogged=false]");
    expect(JSON.stringify(dst.nbt.get(`${w.min[0] + 4},-60,${w.min[2] + 3}`))).toContain("minecraft:diamond");
    // A modded block typed by name: the asset registry may miss properties the game has
    // (waterlogged), and then the game refuses it rather than writing air or a default.
    const typed = await mcp.call("set_blocks", { blocks: [{ pos: [6, 1, 6], block: "create:cogwheel" }] });
    const at: Vec3 = [w.min[0] + 6, -60, w.min[2] + 6];
    if (typed.includes("1 rejected")) {
      expect(typed).toContain("unknown_state");
      expect(await worldBlock(mcp.link, at)).toBe("minecraft:air");
      expect(await mcp.call("query_block", { pos: [6, 1, 6] })).toContain("air");
    } else expect(await worldBlock(mcp.link, at)).toBe("create:cogwheel[axis=y,waterlogged=false]");
  });

  it("kill and restart the server mid-build: nothing queued is replayed, and relinking resumes from the world", async () => {
    const w = work(7);
    await setVolumes(r, w, undefined, mcp.link);
    await mcp.call("doc_open", { world: true });
    await mcp.call("fill", { box: { min: [0, 1, 0], max: [7, 1, 7] }, pattern: "minecraft:stone_bricks" });
    await r.command("save-all flush");
    r.close();
    killServer();
    const offline = await mcp.call("fill", { box: { min: [0, 2, 0], max: [7, 2, 7] }, pattern: "minecraft:glass" });
    expect(offline).toMatch(/not connected to the game|disconnected/);
    startServer();
    r = await rcon();
    await r.command(`forceload add ${X0 - 16} ${Z0 - 16} ${X0 + 64 * 8 + 32} ${Z0 + 32}`);
    // Volumes aren't saved with the world: after the restart the link has none, and unlinks.
    await until(() => mcp.link.bridge.connected, 60_000, "reconnect");
    await until(() => mcp.link.state !== "linked", 10_000, "unlink after restart");
    await setVolumes(r, w, undefined, mcp.link);
    const reopened = await mcp.call("doc_open", { world: true });
    expect(reopened).toContain("Linked to the world");
    expect(await worldBlock(mcp.link, [w.min[0] + 3, w.min[1] + 2, w.min[2] + 3])).toBe("minecraft:air");
    expect(await worldBlock(mcp.link, [w.min[0] + 3, w.min[1] + 1, w.min[2] + 3])).toBe("minecraft:stone_bricks");
    expect(await mcp.call("query_block", { pos: [3, 2, 3] })).toContain("air");
    expect(cacheMatchesWorld(mcp.link.doc!, await worldBlocks(mcp.link, w.min, w.max), w.min)).toEqual([]);
  }, 1_200_000);
});

function cacheMatchesWorld(doc: Document, world: { states: Map<string, string> }, origin: Vec3): string[] {
  const diffs: string[] = [];
  for (const [k, s] of world.states) {
    const [x, y, z] = k.split(",").map(Number) as Vec3;
    const local = doc.getState(x - origin[0], y - origin[1], z - origin[2]);
    if (local !== s) diffs.push(`${k}: world ${s}, cache ${local}`);
  }
  return diffs;
}
