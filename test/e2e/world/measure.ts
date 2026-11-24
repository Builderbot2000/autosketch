/**
 * Measurements for docs/design/13's open questions (silo R): patch throughput and ack times,
 * snapshot and section-hash cost by volume, and change-tracker cost. Not a pass/fail test; prints
 * a JSON report. Needs a running server (test/e2e/world/server.sh) and the env of harness.ts.
 *
 *   npx tsx test/e2e/world/measure.ts throughput|snapshot|tracker|surface [--runs 5]
 *   npx tsx test/e2e/world/measure.ts select-search|select-fill|select-coarse|select-blocks [--at x z] [--gen n]
 *
 * The select-* runs are 18's *Measure first* (step Z1), on a normally generated world (see below).
 */
import { encodeMessage, type FillResult, type PatchBlock } from "../../../src/world/protocol/index.js";
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

// ── 18, *Measure first* (step Z1) ─────────────────────────────────────────────────────────────
//
// Run on a normally generated world (not the flat e2e world): the select reads are only telling on
// real terrain. The server has no player, so the select grant comes from `/autosketch measure grant`
// (MeasureCommands, console and RCON only), and each read's cost from `/autosketch measure last`.
//
//   --at <x> <z>     the grant's centre (default 0 0), a chunk inside the pre-generated area
//   --gen <chunks>   radius of the pre-generated square around it (default 24)

const OW = "minecraft:overworld";
const argAt = process.argv.indexOf("--at");
const AT: [number, number] = argAt > 0 ? [Number(process.argv[argAt + 1]), Number(process.argv[argAt + 2])] : [0, 0];
const argGen = process.argv.indexOf("--gen");
const GEN = argGen > 0 ? Number(process.argv[argGen + 1]) : 24;

/** The mod's last costs, one record per read kind (`measure last`), as key → number. */
async function last(r: Rcon): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const line of (await r.command("autosketch measure last")).split("\n")) {
    const m = /^(\w+) \w+\[(.*)\]$/.exec(line.trim());
    if (!m) continue;
    out[m[1]!] = Object.fromEntries(m[2]!.split(", ").map((kv) => kv.split("=")).map(([k, v]) => [k!, Number(v)]));
  }
  return out;
}

const ms = (nanos: number | undefined) => Math.round((nanos ?? 0) / 1e5) / 10;

/** The cost record with times in ms and the per-tick server time it implies. */
function cost(s: Record<string, number> | undefined): Record<string, number> {
  if (!s) return {};
  const o: Record<string, number> = {};
  for (const [k, v] of Object.entries(s)) o[k.replace(/Nanos$/, "Ms")] = k.endsWith("Nanos") ? ms(v) : v;
  if (s.serverNanos !== undefined && s.ticks) o.serverMsPerTick = ms(s.serverNanos / s.ticks);
  return o;
}

async function grant(r: Rcon, radius: number, at = AT): Promise<void> {
  const g = await r.command(`autosketch measure grant ${at[0]} ${at[1]} ${radius}`);
  if (!g.includes("select grant")) throw new Error(`grant failed: ${g}`);
}

/** Drops every forced chunk and waits for the chunks to unload (and be saved), so reads start cold. */
async function cold(r: Rcon, waitMs = 45_000): Promise<void> {
  await r.command("forceload remove all");
  await r.command("save-all flush");
  await sleep(waitMs);
}

const generated = (c: [number, number]) => Math.max(Math.abs(c[0] - (AT[0] >> 4)), Math.abs(c[1] - (AT[1] >> 4))) <= GEN;

async function search(m: Mcp, materials: string[], radius: number, stop?: number, around?: Vec3) {
  const t = performance.now();
  const res = await m.link.bridge.request({ type: "search", dimension: OW, materials, radius, ...(stop ? { stop } : {}), ...(around ? { around } : {}) });
  return { ms: Math.round(performance.now() - t), res, bytes: encodeMessage(res).length };
}

/**
 * Search (18, *Measure first* 1): how often real terrain's sections answer "maybe" per material over
 * the generated square, cold walks at 64 and 256 chunks for a material that isn't there, and the
 * time to the first closed cluster for a build near the centre, loaded and cold.
 */
async function selectSearch(r: Rcon, m: Mcp): Promise<void> {
  await grant(r, 256);
  const materials = ["minecraft:stone_bricks", "minecraft:mossy_stone_bricks", "minecraft:cobblestone", "minecraft:mossy_cobblestone", "minecraft:oak_planks", "minecraft:spruce_planks",
    "minecraft:oak_log", "minecraft:spruce_log", "minecraft:bricks", "minecraft:glass", "minecraft:glass_pane", "minecraft:smooth_stone", "minecraft:deepslate_bricks",
    "minecraft:stone", "minecraft:andesite", "minecraft:sandstone", "minecraft:terracotta", "minecraft:white_wool"];
  // Warm-up walk, so the first material doesn't pay the class loading.
  await search(m, ["minecraft:pink_concrete"], GEN, 1024);
  const rates: Record<string, unknown> = {};
  for (const mat of materials) {
    const s = await search(m, [mat], GEN, 1024);
    const c = (await last(r)).search!;
    const read = c.chunks! - c.missing!;
    const sections = read * 24;
    rates[mat] = { maybe_pct: Math.round((1000 * c.maybeSections!) / sections) / 10, match_pct: Math.round((1000 * c.matchSections!) / sections) / 10, clusters: s.res.clusters.length, blocks: s.res.chunks.reduce((a, ch) => a + ch.counts[0]!, 0), wall_ms: s.ms, server_ms_per_tick: cost(c).serverMsPerTick };
  }
  log("search_maybe_rates", { square_chunks: (GEN * 2 + 1) ** 2, sections_per_chunk: 24, rates });
  // Cold walks: nothing forced, a material that isn't there, so the walk goes to the radius.
  for (const radius of [64, 256]) {
    await cold(r);
    const idle = await mspt(r);
    const s = await search(m, ["minecraft:pink_concrete"], radius, 1024);
    const c = cost((await last(r)).search);
    const unexpected = s.res.missing.filter(generated).length;
    log(`search_cold_${radius}`, { wall_ms: s.ms, reached: s.res.reached, missing: s.res.missing.length, generated_listed_missing: unexpected, answer_bytes: s.bytes, ...c, mspt_idle: idle, mspt_last100_after: await mspt(r) });
  }
  // The same walks again, warm (chunks still cached by the chunk storage's I/O, nothing loaded).
  {
    const s = await search(m, ["minecraft:pink_concrete"], 64, 1024);
    log("search_again_64", { wall_ms: s.ms, ...cost((await last(r)).search) });
  }
  // A build near the centre: a mossy stone brick house 5 chunks east, a ruin of it 9 chunks north.
  const hx = AT[0] + 80, hz = AT[1] + 4;
  await r.command(`forceload add ${hx - 16} ${hz - 16} ${hx + 32} ${hz + 32}`);
  await sleep(5000);
  const y = await surfaceY(m, hx, hz);
  await r.command(`fill ${hx} ${y} ${hz} ${hx + 10} ${y + 6} ${hz + 8} minecraft:mossy_stone_bricks hollow`);
  await r.command(`fill ${hx + 1} ${y + 7} ${hz + 1} ${hx + 9} ${y + 7} ${hz + 7} minecraft:spruce_planks`);
  log("house", { at: [hx, y, hz], size: [11, 8, 9] });
  for (const state of ["loaded", "cold"] as const) {
    if (state === "cold") await cold(r);
    const idle = await mspt(r);
    const s = await search(m, ["minecraft:mossy_stone_bricks", "minecraft:mossy_stone_brick_stairs", "minecraft:mossy_stone_brick_slab"], 256);
    const c = cost((await last(r)).search);
    log(`search_first_closed_${state}`, { wall_ms: s.ms, reached: s.res.reached, clusters: s.res.clusters.map((k) => ({ min: k.min, max: k.max, blocks: k.blocks, closed: k.closed })), ...c, mspt_idle: idle, mspt_last100_after: await mspt(r) });
  }
  // M2's follow-up: a chunk between unload and save may read as missing. Walk the square every second
  // while the forced chunks unload, and count generated chunks listed missing.
  await r.command(`forceload add ${AT[0] - 128} ${AT[1] - 128} ${AT[0] + 127} ${AT[1] + 127}`);
  await sleep(10_000);
  await r.command("forceload remove all");
  const window: number[] = [];
  for (let i = 0; i < 40; i++) {
    const s = await search(m, ["minecraft:pink_concrete"], 8, 1024);
    window.push(s.res.missing.filter(generated).length);
    await sleep(1000);
  }
  log("unload_window_generated_listed_missing_per_walk", window);
}

/** The top non-air y of a column, through a one-column blocks snapshot (inside the grant). */
async function surfaceY(m: Mcp, x: number, z: number): Promise<number> {
  const s = await m.link.bridge.request({ type: "snapshot", dimension: OW, boxes: [{ min: [x, -64, z], max: [x, 319, z] }] });
  const st = s.regions[0]!.states;
  for (let i = st.length - 1; i >= 0; i--) if (!/air$/.test(s.palette[st[i]!]!)) return -64 + i + 1;
  return 64;
}

/**
 * Fill (18, *Measure first* 2): the terrain as a stand-in for a build of tens of millions of blocks,
 * `solid` from a seed underground, grown by `expand` frontier in rounds at the default budget.
 */
async function selectFill(r: Rcon, m: Mcp): Promise<void> {
  const rounds = Number(process.argv[process.argv.indexOf("--rounds") + 1] ?? 10) || 10;
  await grant(r, 256);
  await cold(r, 30_000);
  const seed: Vec3 = [AT[0] + 8, -40, AT[1] + 8];
  const rows: unknown[] = [];
  let res: FillResult | undefined;
  for (let i = 0; i < rounds; i++) {
    const idle = await mspt(r);
    const t = performance.now();
    res = i === 0
      ? await m.link.bridge.request({ type: "fill", dimension: OW, seed, match: ["solid"] })
      : await m.link.bridge.request({ type: "expand", dimension: OW, by: "frontier" });
    const wall = Math.round(performance.now() - t);
    const bytes = encodeMessage(res).length;
    const full = res.sections.filter((s) => s.mask === "full").length;
    const c = cost((await last(r)).fill);
    const row = { round: i, wall_ms: wall, count: res.count, stopped: res.stopped, sections_sent: res.sections.length, full_sections: full, frontier_sections: res.frontier.length, answer_bytes: bytes, missing: res.missing.length, generated_listed_missing: res.missing.filter(generated).length, ...c, mspt_idle: idle, mspt_last100_after: await mspt(r) };
    rows.push(row);
    log(`fill_round_${i}`, row);
    if (res.stopped === "complete") break;
  }
  log("fill_box", res?.box);
}

/**
 * Coarse view (18, *Measure first* 3): a big box of terrain read at 4³ cells, on the wire (the
 * mod's coarse snapshot) and through the MCP (world_view_read, then render of the view), with the
 * render saved for the legibility check.
 */
async function selectCoarse(r: Rcon, m: Mcp): Promise<void> {
  const out = process.argv[process.argv.indexOf("--out") + 1] ?? "/tmp";
  await grant(r, 256);
  const { WorldView } = await import("../../../src/world/view.js");
  const ctx = await (await import("./harness.js")).instanceContext();
  m.session.worldView = new WorldView({ bridge: m.link.bridge, request: () => 1, dimension: () => OW, dataVersion: () => m.link.bridge.hello?.game.dataVersion ?? 0, palettes: () => ctx.book });
  for (const half of [128, 256, 384]) {
    const box = { min: [AT[0] - half, -64, AT[1] - half] as Vec3, max: [AT[0] + half - 1, 191, AT[1] + half - 1] as Vec3 };
    if (half / 16 > GEN + 1) continue;
    await cold(r, 30_000);
    const idle = await mspt(r);
    let t = performance.now();
    const wire = await m.link.bridge.request({ type: "snapshot", kind: "coarse", dimension: OW, cell: 4, boxes: [box] });
    const wireMs = Math.round(performance.now() - t);
    const c = cost((await last(r)).coarse);
    log(`coarse4_wire_${half * 2}`, { blocks: (half * 2) ** 2 * 256, cells: wire.regions[0]!.states.length, palette: wire.palette.length, wall_ms: wireMs, answer_bytes: encodeMessage(wire).length, ...c, mspt_idle: idle, mspt_last100_after: await mspt(r) });
    m.session.worldView.clear();
    const heap0 = process.memoryUsage().heapUsed;
    t = performance.now();
    const read = await m.call("world_view_read", { box });
    const readMs = Math.round(performance.now() - t);
    const heap = Math.round((process.memoryUsage().heapUsed - heap0) / 1e6);
    t = performance.now();
    const rendered = await m.client.callTool({ name: "render", arguments: { view: "world" } });
    const renderMs = Math.round(performance.now() - t);
    const parts = rendered.content as { type: string; text?: string; data?: string }[];
    const img = parts.find((p) => p.type === "image");
    if (img?.data) (await import("node:fs")).writeFileSync(`${out}/coarse-${half * 2}.png`, Buffer.from(img.data, "base64"));
    log(`coarse_mcp_${half * 2}`, { read_ms: readMs, read: read.split("\n")[0], heap_mb_after_read: heap, render_ms: renderMs, caption: parts.filter((p) => p.type === "text").map((p) => p.text).join(" ").slice(0, 300) });
  }
}

/**
 * Blocks snapshots inside the select grant (M3's open item): an unloaded chunk is loaded on the
 * server thread (SurfaceReads.existing). Cold and loaded, the longest tick and the mean per tick.
 */
async function selectBlocks(r: Rcon, m: Mcp): Promise<void> {
  await grant(r, 256);
  for (const [name, chunks] of [["1x1", 1], ["4x4", 4], ["8x8", 8]] as const) {
    const box = { min: [AT[0], -64, AT[1]] as Vec3, max: [AT[0] + chunks * 16 - 1, Math.min(319, -64 + Math.floor(4_194_304 / (chunks * chunks * 256)) - 1), AT[1] + chunks * 16 - 1] as Vec3 };
    for (const state of ["cold", "loaded"] as const) {
      if (state === "cold") await cold(r, 30_000);
      else await r.command(`forceload add ${box.min[0]} ${box.min[2]} ${box.max[0]} ${box.max[2]}`), await sleep(5000);
      const idle = await mspt(r);
      const t = performance.now();
      const s = await m.link.bridge.request({ type: "snapshot", dimension: OW, boxes: [box] });
      const wall = Math.round(performance.now() - t);
      const c = cost((await last(r)).blocks);
      log(`blocks_${name}_${state}`, { blocks: (box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) * (box.max[2] - box.min[2] + 1), wall_ms: wall, missing: s.missing?.length ?? 0, ...c, mspt_idle: idle, mspt_last100_after: await mspt(r) });
    }
  }
  await r.command("forceload remove all");
}

const r = await rcon();
const m = await startMcp({ ackWaitMs: 0 });
try {
  if (what === "throughput") await throughput(r, m);
  else if (what === "snapshot") await snapshot(r, m);
  else if (what === "tracker") await tracker(r, m);
  else if (what === "surface") await surface(r, m);
  else if (what === "select-search") await selectSearch(r, m);
  else if (what === "select-fill") await selectFill(r, m);
  else if (what === "select-coarse") await selectCoarse(r, m);
  else if (what === "select-blocks") await selectBlocks(r, m);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
} catch (e) {
  process.stderr.write(`failed: ${(e as Error).stack}\n${JSON.stringify(out)}\n`);
} finally {
  await m.close();
  r.close();
  process.exit(0);
}
