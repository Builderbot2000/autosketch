/**
 * Measurements for docs/design/13's open questions (silo R): patch throughput and ack times,
 * snapshot and section-hash cost by volume, and change-tracker cost. Not a pass/fail test; prints
 * a JSON report. Needs a running server (test/e2e/world/server.sh) and the env of harness.ts.
 *
 *   npx tsx test/e2e/world/measure.ts throughput|snapshot|tracker|surface [--runs 5]
 */
import { encodeMessage, type PatchBlock } from "../../../src/world/protocol/index.js";
import { rcon, setVolumes, startMcp, sleep, type Mcp, type Vec3 } from "./harness.js";
import type { Rcon } from "./rcon.js";

const what = process.argv[2] ?? "throughput";
const runs = Number(process.argv[process.argv.indexOf("--runs") + 1] ?? 5) || 5;
const X = 3000;
const Z = 1000;
const Y = -60; // first air layer of the flat world

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const out: Record<string, unknown> = {};
const log = (k: string, v: unknown) => {
  out[k] = v;
  process.stderr.write(`${k}: ${JSON.stringify(v)}\n`);
};

/** Mean whole-server ms/tick over the last 100 ticks ("Overall" in /neoforge tps; per-level lines leave out tick events). */
async function mspt(r: Rcon): Promise<number> {
  const t = await r.command("neoforge tps");
  return Number(/Overall: [\d.]+ TPS \(([\d.]+) ms\/tick\)/.exec(t)?.[1] ?? NaN);
}

/** Layer-by-layer positions of a box (x fastest), up to n. */
function positions(min: Vec3, size: Vec3, n: number): Vec3[] {
  const ps: Vec3[] = [];
  for (let y = 0; y < size[1]; y++) for (let z = 0; z < size[2]; z++) for (let x = 0; x < size[0]; x++) if (ps.length < n) ps.push([min[0] + x, min[1] + y, min[2] + z]);
  return ps;
}

async function patch(m: Mcp, blocks: PatchBlock[]): Promise<{ ms: number; applied: number }> {
  const v = m.link.volumes!;
  const t = performance.now();
  const ack = await m.link.bridge.request({ type: "patch", link: v.link, dimension: v.dimension, force: true, blocks });
  return { ms: performance.now() - t, applied: ack.applied };
}

async function throughput(r: Rcon, m: Mcp): Promise<void> {
  const work = { min: [X, -61, Z] as Vec3, max: [X + 127, -22, Z + 127] as Vec3 };
  await r.command(`forceload add ${X - 16} ${Z - 16} ${X + 144} ${Z + 144}`);
  await setVolumes(r, work, undefined, m.link);
  let t = performance.now();
  await m.call("doc_open", { world: true });
  log("link_ms_128x40x128", Math.round(performance.now() - t));
  const size: Vec3 = [128, 38, 128];
  const min: Vec3 = [X, Y, Z];
  // Plain states, alternating stone and air (forced, so expected states don't matter for cost).
  let state = "minecraft:stone";
  const flip = () => (state = state === "minecraft:stone" ? "minecraft:air" : "minecraft:stone");
  const plain = (n: number): PatchBlock[] => {
    const s = flip();
    const e = s === "minecraft:stone" ? "minecraft:air" : "minecraft:stone";
    return positions(min, size, n).map((pos) => ({ pos, expected: e, state: s }));
  };
  const lat: Record<number, number[]> = {};
  for (const n of [1, 100, 1000, 5000, 9000]) {
    lat[n] = [];
    state = "minecraft:air";
    for (let i = 0; i < runs * 2; i++) lat[n]!.push((await patch(m, plain(n))).ms);
    // leave air behind
    if (state === "minecraft:stone") await patch(m, plain(n));
  }
  log("ack_ms_by_blocks_median", Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, Math.round(median(v))])));
  log("ack_ms_by_blocks_max", Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, Math.round(Math.max(...v))])));
  // Large patches: ticks needed at the budget, and the server's tick time meanwhile.
  for (const n of [100_000, 300_000, 600_000]) {
    await sleep(6000);
    const base = await mspt(r);
    state = "minecraft:air";
    const p = await patch(m, plain(n));
    const after = await mspt(r);
    log(`large_${n}`, { ack_ms: Math.round(p.ms), applied: p.applied, mspt_idle: base, mspt_last100_after: after });
    await sleep(6000);
    await patch(m, plain(n)); // back to air
  }
  // Block entities: chests with one item each.
  const chestN = 4000;
  const chests = positions(min, size, chestN).map((pos) => ({
    pos,
    expected: "minecraft:air",
    state: "minecraft:chest[facing=north,type=single,waterlogged=false]",
    nbt: { type: "compound", value: { id: { type: "string", value: "minecraft:chest" }, Items: { type: "list", value: { type: "compound", value: [{ Slot: { type: "byte", value: 0 }, id: { type: "string", value: "minecraft:diamond" }, count: { type: "int", value: 7 } }] } } } } as PatchBlock["nbt"],
  }));
  await sleep(6000);
  const base = await mspt(r);
  t = performance.now();
  const pc = await patch(m, chests);
  const after = await mspt(r);
  log("chests_4000", { ack_ms: Math.round(pc.ms), applied: pc.applied, mspt_idle: base, mspt_last100_after: after });
  await patch(m, chests.map((c) => ({ pos: c.pos, expected: c.state, state: "minecraft:air" })));
}

async function snapshot(r: Rcon, m: Mcp): Promise<void> {
  // A 256×64×256 work volume (4.2M blocks) filled with a stone/planks checkerboard in its lower half.
  const work = { min: [X, -61, Z] as Vec3, max: [X + 223, 2, Z + 223] as Vec3 };
  await r.command(`forceload add ${X - 16} ${Z - 16} ${X + 272} ${Z + 272}`);
  await r.command("autosketch context clear");
  await setVolumes(r, work, undefined, m.link);
  let t = performance.now();
  const opened = await m.tryCall("doc_open", { world: true });
  log("link_224x64x224", { ms: Math.round(performance.now() - t), ok: !opened.isError, text: opened.text.split("\n")[0] });
  if (opened.isError) return;
  t = performance.now();
  await m.call("doc_open", { world: true });
  log("link_224x64x224_again_ms", Math.round(performance.now() - t));
  t = performance.now();
  const filled = await m.call("run_script", { source: 'fill({ box: { min: [0, 1, 0], max: [223, 32, 223] } }, { tile: "checker", blocks: ["minecraft:stone", "minecraft:oak_planks"] });', timeout_ms: 60000 });
  log("fill_1.6M_via_tool", { ms: Math.round(performance.now() - t), world: filled.split("\n").find((l) => l.startsWith("world:")) });
  await sleep(3000);
  t = performance.now();
  await m.call("doc_open", { world: true });
  log("link_224x64x224_filled_ms", Math.round(performance.now() - t));
  const dim = m.link.volumes!.dimension;
  for (const [name, size] of [
    ["16x16x16", [16, 16, 16]],
    ["64x32x64", [64, 32, 64]],
    ["128x32x128", [128, 32, 128]],
    ["224x32x128", [224, 32, 128]],
    ["224x32x224", [224, 32, 224]],
    ["224x63x224", [224, 63, 224]],
  ] as const) {
    const box = { min: [X, -60, Z] as Vec3, max: [X + size[0] - 1, -60 + size[1] - 1, Z + size[2] - 1] as Vec3 };
    const times: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 3; i++) {
      t = performance.now();
      const s = await m.link.bridge.request({ type: "snapshot", dimension: dim, boxes: [box] });
      times.push(performance.now() - t);
      if (!bytes) bytes = encodeMessage(s).length;
    }
    const ht: number[] = [];
    for (let i = 0; i < 3; i++) {
      t = performance.now();
      await m.link.bridge.request({ type: "hashes", dimension: dim, boxes: [box] });
      ht.push(performance.now() - t);
    }
    log(`snapshot_${name}`, { blocks: size[0] * size[1] * size[2], snapshot_ms: Math.round(median(times)), frame_bytes: bytes, hashes_ms: Math.round(median(ht)) });
  }
  t = performance.now();
  await m.call("world_sync", {});
  log("world_sync_unchanged_3.2M_ms", Math.round(performance.now() - t));
  await m.call("run_script", { source: 'fill({ box: { min: [0, 1, 0], max: [223, 32, 223] } }, "minecraft:air");', timeout_ms: 60000 });
}

/** Wall time of RCON fills (setBlock path) inside the work volume, outside it, and unlinked. */
async function tracker(r: Rcon, m: Mcp): Promise<void> {
  const big = process.argv.includes("--big");
  const work = { min: [X, -61, Z] as Vec3, max: (big ? [X + 223, 2, Z + 223] : [X + 63, -30, Z + 63]) as Vec3 };
  await r.command(`forceload add ${X - 16} ${Z - 16} ${X + 400} ${Z + 240}`);
  await setVolumes(r, work, undefined, m.link);
  await m.call("doc_open", { world: true });
  // The scan tracker's baseline gap: an edit right after the link.
  let seen = false;
  const off = m.link.bridge.on("dirty", () => (seen = true));
  await r.command(`setblock ${X + 5} -60 ${Z + 5} minecraft:gold_block`);
  const t0 = performance.now();
  while (!seen && performance.now() - t0 < 5000) await sleep(20);
  log("edit_right_after_link", { reported: seen, ms: Math.round(performance.now() - t0) });
  void off;
  await r.command(`setblock ${X + 5} -60 ${Z + 5} minecraft:air`);
  const fillTime = async (x0: number) => {
    const ts: number[] = [];
    for (let i = 0; i < runs * 2; i++) {
      const b = i % 2 ? "minecraft:air" : "minecraft:stone";
      const t = performance.now();
      await r.command(`fill ${x0} -60 ${Z} ${x0 + 31} -29 ${Z + 31} ${b}`); // 32,768 blocks
      ts.push(performance.now() - t);
    }
    return Math.round(median(ts) * 10) / 10;
  };
  log("rcon_fill_32768_inside_ms", await fillTime(X));
  log("rcon_fill_32768_outside_ms", await fillTime(X + 300));
  await sleep(2000);
  log("mspt_linked_idle", await mspt(r));
}

/**
 * Surface snapshots (13, B4; 18, piece 10) at 4 and 12 chunks (the former scan radii), with and
 * without a ceiling: wall time, frame size, and the server's tick time while reading. The area is
 * served inside a flat context box over the whole radius (no player, so no select grant), whose ticket
 * keeps the chunks loaded: this measures reading loaded chunks.
 */
async function surface(r: Rcon, m: Mcp): Promise<void> {
  const SX = 6000, SZ = 0;
  const cx = SX >> 4, cz = SZ >> 4;
  const area = (rad: number) => ({ min: [16 * (cx - rad), 16 * (cz - rad)] as [number, number], max: [16 * (cx + rad) + 15, 16 * (cz + rad) + 15] as [number, number] });
  const big = area(12);
  const work = { min: [SX, -61, SZ] as Vec3, max: [SX + 15, -50, SZ + 15] as Vec3 };
  await setVolumes(r, work, { min: [big.min[0], -64, big.min[1]], max: [big.max[0], -64, big.max[1]] }, m.link);
  await m.call("doc_open", { world: true });
  const dim = m.link.bridge.volumes?.dimension ?? "minecraft:overworld";
  // Wait for the ticket to load (and, on a first run, generate) every chunk of the area.
  const t0 = performance.now();
  for (;;) {
    const s = await m.link.bridge.request({ type: "snapshot", kind: "surface", dimension: dim, columns: big });
    if (s.missing.length === 0) break;
    if (performance.now() - t0 > 300_000) throw new Error(`${s.missing.length} chunks still missing`);
    await sleep(2000);
  }
  log("surface_chunks_ready_ms", Math.round(performance.now() - t0));
  await sleep(5000);
  for (const [name, a] of [["r4_144x144", area(4)], ["r12_400x400", big]] as const)
    for (const ceiling of [undefined, -62]) {
      const times: number[] = [];
      let bytes = 0;
      const idle = await mspt(r);
      for (let i = 0; i < runs; i++) {
        const t = performance.now();
        const s = await m.link.bridge.request({ type: "snapshot", kind: "surface", dimension: dim, columns: a, ...(ceiling !== undefined ? { ceiling } : {}) });
        times.push(performance.now() - t);
        if (!bytes) bytes = encodeMessage(s).length;
      }
      const columns = (a.max[0] - a.min[0] + 1) * (a.max[1] - a.min[1] + 1);
      log(`surface_${name}${ceiling !== undefined ? "_ceiling" : ""}`, { columns, ms_median: Math.round(median(times)), ms_max: Math.round(Math.max(...times)), frame_bytes: bytes, mspt_idle: idle, mspt_last100_after: await mspt(r) });
    }
  // Cold: release the ticket, let the chunks unload, then ask again right as the volumes come back
  // (the new ticket loads chunks over the next ticks; the read loads from disk whatever isn't loaded yet).
  // Unlinked by the clear, the harness's link doesn't relink, so nothing else reads the area first.
  for (let i = 0; i < 2; i++) {
    await r.command("autosketch clear");
    await sleep(60_000);
    const before = await mspt(r);
    await setVolumes(r, work, { min: [big.min[0], -64, big.min[1]], max: [big.max[0], -64, big.max[1]] }, m.link);
    const t = performance.now();
    const s = await m.link.bridge.request({ type: "snapshot", kind: "surface", dimension: dim, columns: big });
    log(`surface_r12_cold_${i}`, { ms: Math.round(performance.now() - t), missing: s.missing.length, mspt_before: before, mspt_last100_after: await mspt(r) });
  }
  await r.command("autosketch clear");
}

const r = await rcon();
const m = await startMcp({ ackWaitMs: 0 });
try {
  if (what === "throughput") await throughput(r, m);
  else if (what === "snapshot") await snapshot(r, m);
  else if (what === "tracker") await tracker(r, m);
  else if (what === "surface") await surface(r, m);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} catch (e) {
  process.stderr.write(`failed: ${(e as Error).stack}\n${JSON.stringify(out)}\n`);
} finally {
  await m.close();
  r.close();
  process.exit(0);
}
