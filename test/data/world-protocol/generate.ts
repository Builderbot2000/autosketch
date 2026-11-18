/**
 * Regenerates the golden vectors of the current protocol version (3) in this folder
 * (docs/design/13-live-world.md, *Wire format*, *Golden vectors*). Run:
 * `npx tsx test/data/world-protocol/generate.ts`. All content is synthetic. The vectors are frozen:
 * regenerate only for a protocol change, and say so in the commit. Earlier versions' vectors live in
 * `v1/` and `v2/`, each copied unchanged when the next version was cut; this script never writes there.
 */
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync, gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFrame, encodeMessage, splitFrame } from "../../../src/world/protocol/codec.js";
import { encodePreviewBody } from "../../../src/world/protocol/body.js";
import { canonicalNbt, DEFAULT_VOLATILE, nbtHash, sectionHash } from "../../../src/world/protocol/hash.js";
import { MCP_FEATURES, MOD_FEATURES, REQUEST_MODES, UI_PART_BYTES, type Message, type PatchBlock, type Sender, type UiGhost, type UiJob, type VolatileList, type WireBox } from "../../../src/world/protocol/messages.js";
import { bytesToHex } from "../../../src/world/protocol/bytes.js";
import { parseSnbt, toSnbt as snbtOf } from "../../../src/world/protocol/snbt.js";
import { sidecarOf } from "./sidecar.js";

const dir = dirname(fileURLToPath(import.meta.url));

/** Pretty JSON with arrays of numbers kept on one line. */
function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2).replace(/\[\s+(-?[\d.e+-]+(?:,\s+-?[\d.e+-]+)*)\s+\]/g, (_, inner: string) => `[${inner.split(/,\s+/).join(", ")}]`) + "\n";
}
const S = parseSnbt;

const OW = "minecraft:overworld";
const UUID_KEV = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const UUID_ALEX = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const CHEST = S('{id:"minecraft:chest",Items:[{Slot:0b,id:"minecraft:oak_planks",count:3},{Slot:13b,id:"minecraft:lantern",count:1}]}');
const SIGN = S('{id:"minecraft:oak_sign",is_waxed:0b,front_text:{has_glowing_text:0b,color:"black",messages:["\\"North tower\\"","\\"Hi \u{1F600}\\"","\\"\\"","\\"\\""]},back_text:{has_glowing_text:0b,color:"black",messages:["\\"\\"","\\"\\"","\\"\\"","\\"\\""]}}');
const FURNACE = S('{id:"minecraft:furnace",BurnTime:120s,CookTime:40s,CookTimeTotal:200s,RecipesUsed:{},Items:[{Slot:0b,id:"minecraft:raw_iron",count:5}]}');
const BARREL = S('{id:"minecraft:barrel",Items:[]}');
const STAIRS = "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]";
const AIR = "minecraft:air";
const work: WireBox = { min: [100, 64, -200], max: [131, 87, -169] };
const ctx: WireBox = { min: [97, 61, -203], max: [134, 90, -166] };

function vector(name: string, sender: Sender, description: string, m: Message, extra: Record<string, unknown> = {}): void {
  const frame = encodeMessage(m);
  const decoded = decodeFrame(frame, sender);
  writeFileSync(join(dir, `${name}.bin`), frame);
  const side = { ...sidecarOf(description, sender, decoded, frame), ...extra };
  if (side.generated) delete side.body;
  writeFileSync(join(dir, `${name}.json`), pretty(side));
}

mkdirSync(dir, { recursive: true });

// ── handshake and control ──────────────────────────────────────────────────────────────────────
vector("hello-mcp", "mcp", "MCP hello: protocol, pairing token, client, volatile-key list (the built-in default plus one plugin entry and one state-only type), every request mode, and every MCP feature (prompt.close: the mod may send /autosketch done)", {
  type: "hello",
  protocol: 3,
  token: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  client: { name: "autosketch", version: "1.0.0" },
  volatile: { ...DEFAULT_VOLATILE, "create:mechanical_press": ["Speed", "Network/Stress"], "create:belt": "state_only" },
  modes: [...REQUEST_MODES],
  features: [...MCP_FEATURES],
});
vector("hello-mcp-build-only", "mcp", "MCP hello listing only the build mode and no features: the mod refuses ask, scan and plan requests itself (unsupported_mode), and /autosketch done (the MCP needs updating)", {
  type: "hello",
  protocol: 3,
  token: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  client: { name: "autosketch", version: "1.1.0" },
  volatile: {},
  modes: ["build"],
});
vector("hello-mod-singleplayer", "mod", "Mod hello from the integrated server of a singleplayer world, listing every feature up to version 3", {
  type: "hello",
  protocol: 3,
  mod: { version: "0.1.0" },
  game: { version: "1.21.1", dataVersion: 3955, loader: "neoforge", loaderVersion: "21.1.249" },
  singleplayer: true,
  host: { name: "Kev", uuid: UUID_KEV },
  features: [...MOD_FEATURES],
});
vector("hello-mod-dedicated", "mod", "Mod hello from a dedicated server (no host player), listing only some features", {
  type: "hello",
  protocol: 3,
  mod: { version: "0.1.0" },
  game: { version: "1.21.1", dataVersion: 3955, loader: "neoforge", loaderVersion: "21.1.249" },
  singleplayer: false,
  host: null,
  features: ["modes", "volumes.set", "registry"],
});
vector("error-protocol-mismatch", "mod", "The mod refuses a hello with another protocol version and closes (the MCP sent a newer one: the mod tells the player to update the mod)", { type: "error", id: null, code: "protocol_mismatch", message: "mod speaks protocol 3, MCP sent 4", protocol: 3 });
vector("error-request", "mod", "A request the mod can't serve, answered by id; the connection stays open", { type: "error", id: 12, code: "outside_volumes", message: "box 0,0,0..15,15,15 lies outside the linked volumes" });
vector("error-internal", "mod", "A valid request the mod failed to serve (its own fault, unlike bad_request); the connection stays open", { type: "error", id: 13, code: "internal", message: "failed to read block entity at 104,66,-195" });
vector("volumes", "mod", "Work volume and two context boxes: the default (work grown by 3) and a distant reference box", {
  type: "volumes",
  link: 3,
  dimension: OW,
  work,
  context: [ctx, { min: [300, 60, -40], max: [340, 110, 0] }],
});
vector("volumes-extend", "mcp", "The MCP declares the work volume extended to whole blocks (a plugin multi-block cut by the player's box), for link 3", {
  type: "volumes.extend",
  id: 4,
  link: 3,
  work: { min: [98, 64, -200], max: [131, 90, -169] },
});
vector("volumes-extended", "mod", "The mod accepted the extension: same link, the player's work box unchanged, the extension in force", {
  type: "volumes",
  link: 3,
  dimension: OW,
  work,
  context: [ctx],
  extended: { min: [98, 64, -200], max: [131, 90, -169] },
});
vector("error-bad-extension", "mod", "An extension that doesn't contain the player's work volume is refused; the connection stays open", { type: "error", id: 4, code: "bad_extension", message: "the extended work volume must contain the player's work volume" });
vector("volumes-set", "mcp", "The agent sets the work volume and two context boxes (B4): the default-style seam box and a reference box", {
  type: "volumes.set",
  id: 30,
  dimension: OW,
  work,
  context: [ctx, { min: [300, 60, -40], max: [340, 110, 0] }],
});
vector("volumes-set-default", "mcp", "The agent sets only the work volume: the mod gives it the default context, as when the player marks one", {
  type: "volumes.set",
  id: 31,
  dimension: OW,
  work: { min: [-20, 60, 40], max: [11, 83, 71] },
});
vector("volumes-set-confirmed", "mod", "The mod confirms volumes.set 31 with a volumes message carrying its id: a new link, the default context", {
  type: "volumes",
  id: 31,
  link: 5,
  dimension: OW,
  work: { min: [-20, 60, 40], max: [11, 83, 71] },
  context: [{ min: [-23, 57, 37], max: [14, 86, 74] }],
});
vector("error-bad-volumes", "mod", "volumes.set refused: the context exceeds the mod's contextCap; the connection stays open", { type: "error", id: 30, code: "bad_volumes", message: "the context holds 5000000 blocks, more than the cap of 4194304" });
vector("volumes-none", "mod", "No work volume (cleared, or never set): unlinked", { type: "volumes", link: 4, work: null });
vector("hashes", "mcp", "Section hashes over the work and context boxes", { type: "hashes", id: 5, dimension: OW, boxes: [work, ctx] });
vector("hashes-result", "mod", "One hash per section the boxes touch, ascending y, z, x (truncated list for the vector)", {
  type: "hashes.result",
  id: 5,
  sections: [
    { section: [6, 3, -13], hash: "0123456789abcdef" },
    { section: [7, 3, -13], hash: "fedcba9876543210" },
    { section: [6, 4, -13], hash: "00000000000000ff" },
  ],
});
vector("snapshot-boxes", "mcp", "Full snapshot of the work and context boxes (linking)", { type: "snapshot", id: 6, dimension: OW, boxes: [work, ctx] });
vector("snapshot-sections", "mcp", "Snapshot of the sections whose hashes differ", { type: "snapshot", id: 7, dimension: OW, sections: [[6, 4, -13], [7, 5, -12]] });

vector("snapshot-surface", "mcp", "Surface snapshot of a scan's columns (B4): topmost non-air block per column", { type: "snapshot", id: 40, dimension: OW, kind: "surface", columns: { min: [-2, 30], max: [1, 32] } });
vector("snapshot-surface-ceiling", "mcp", "Surface snapshot with the ceiling above y 20 (the player is underground)", { type: "snapshot", id: 41, dimension: OW, kind: "surface", columns: { min: [-2, 30], max: [1, 32] }, ceiling: 20 });
{
  // 4 × 3 columns, x fastest, then z. minY −64, so y = −64 + h − 1. Chunk [-1, 2] (x −16…−1, z 32…47) isn't generated.
  const pal = ["minecraft:grass_block[snowy=false]", "minecraft:water[level=0]", "minecraft:oak_leaves[distance=1,persistent=false,waterlogged=false]", "minecraft:stone"];
  const h = (y: number) => y + 64 + 1;
  vector("snapshot-result-surface", "mod", "Surface result: grass, water, leaves; the columns of a missing (ungenerated) chunk read as none", {
    type: "snapshot.result",
    id: 40,
    dimension: OW,
    kind: "surface",
    columns: { min: [-2, 30], max: [1, 32] },
    minY: -64,
    missing: [[-1, 2]],
    palette: pal,
    surface: {
      heights: Uint32Array.of(h(70), h(70), h(71), h(62), h(70), h(77), h(62), h(62), 0, 0, h(-64), h(62)),
      states: Uint32Array.of(0, 0, 0, 1, 0, 2, 1, 1, 0, 0, 3, 1),
    },
  });
  vector("snapshot-result-surface-ceiling", "mod", "Surface result with ceilings above y 20: a cave roof over some columns, open to the surface over others (none), none in the missing chunk", {
    type: "snapshot.result",
    id: 41,
    dimension: OW,
    kind: "surface",
    columns: { min: [-2, 30], max: [1, 32] },
    minY: -64,
    ceiling: 20,
    missing: [[-1, 2]],
    palette: pal,
    surface: {
      heights: Uint32Array.of(h(70), h(70), h(71), h(62), h(70), h(77), h(62), h(62), 0, 0, h(-64), h(62)),
      states: Uint32Array.of(0, 0, 0, 1, 0, 2, 1, 1, 0, 0, 3, 1),
    },
    ceilings: {
      heights: Uint32Array.of(h(24), h(24), h(25), h(62), h(23), h(70), h(62), h(62), 0, 0, 0, h(62)),
      states: Uint32Array.of(3, 3, 3, 1, 3, 0, 1, 1, 0, 0, 0, 1),
    },
  });
}

// ── snapshot results ───────────────────────────────────────────────────────────────────────────
vector("snapshot-result-empty", "mod", "Snapshot result with no regions", { type: "snapshot.result", id: 8, dimension: OW, palette: [], regions: [] });
vector("snapshot-result-one", "mod", "One one-block region holding stone", {
  type: "snapshot.result",
  id: 9,
  dimension: OW,
  palette: ["minecraft:stone"],
  regions: [{ box: { min: [5, -60, 7], max: [5, -60, 7] }, states: Uint32Array.of(0), blockEntities: [] }],
});
{
  // Two regions: a 3×2×2 box and a 2×1×1 box. States listed x fastest, then z, then y.
  const pal = [AIR, "minecraft:stone_bricks", STAIRS, "minecraft:chest[facing=north,type=single,waterlogged=false]", "minecraft:oak_sign[rotation=8,waterlogged=false]"];
  vector("snapshot-result-mixed", "mod", "Three regions with a mixed palette and block entities (a chest and a sign with an emoji, exercising modified UTF-8); the third region overlaps the first, so the chest appears in both", {
    type: "snapshot.result",
    id: 10,
    dimension: OW,
    palette: pal,
    regions: [
      {
        box: { min: [-2, 70, 3], max: [0, 71, 4] },
        states: Uint32Array.of(1, 1, 1, 1, 3, 1, 0, 0, 2, 0, 0, 4),
        blockEntities: [
          { pos: [0, 71, 4], nbt: SIGN },
          { pos: [-1, 70, 4], nbt: CHEST },
        ],
      },
      { box: { min: [40, 64, 40], max: [41, 64, 40] }, states: Uint32Array.of(2, 0), blockEntities: [] },
      { box: { min: [-1, 70, 4], max: [-1, 70, 4] }, states: Uint32Array.of(3), blockEntities: [{ pos: [-1, 70, 4], nbt: CHEST }] },
    ],
  });
}

// ── patches ────────────────────────────────────────────────────────────────────────────────────
vector("patch-empty", "mcp", "A patch with no blocks (an entry that changed nothing the world holds)", { type: "patch", id: 20, link: 3, dimension: OW, blocks: [] });
vector("patch-one", "mcp", "One block: air to stone at a world position (the worked example in the spec)", {
  type: "patch",
  id: 21,
  link: 3,
  dimension: OW,
  blocks: [{ pos: [100, 64, -200], expected: AIR, state: "minecraft:stone" }],
});
vector("patch-mixed", "mcp", "Mixed palette, given out of order (the encoder sorts by grid index)", {
  type: "patch",
  id: 22,
  link: 3,
  dimension: OW,
  blocks: [
    { pos: [103, 65, -199], expected: AIR, state: STAIRS },
    { pos: [101, 64, -200], expected: "minecraft:grass_block[snowy=false]", state: "minecraft:stone_bricks" },
    { pos: [100, 64, -200], expected: "minecraft:grass_block[snowy=false]", state: "minecraft:stone_bricks" },
    { pos: [100, 65, -200], expected: AIR, state: "minecraft:glass" },
    { pos: [102, 64, -198], expected: "minecraft:dirt", state: AIR },
  ],
});
vector("patch-block-entities", "mcp", "New block-entity NBT, and expected NBT hashes for replaced block entities (computed with the default volatile list)", {
  type: "patch",
  id: 23,
  link: 3,
  dimension: OW,
  blocks: [
    { pos: [110, 70, -190], expected: AIR, state: "minecraft:chest[facing=north,type=single,waterlogged=false]", nbt: CHEST },
    { pos: [111, 70, -190], expected: "minecraft:furnace[facing=south,lit=true]", expectedNbtHash: nbtHash(FURNACE, DEFAULT_VOLATILE)!, state: "minecraft:barrel[facing=up,open=false]", nbt: BARREL },
    { pos: [112, 70, -190], expected: "minecraft:oak_sign[rotation=8,waterlogged=false]", expectedNbtHash: nbtHash(SIGN, DEFAULT_VOLATILE)!, state: AIR },
  ],
});
vector("patch-force", "mcp", "A forced patch (overwriteHandEdits): expected states still sent so the mod can count overwrites", {
  type: "patch",
  id: 24,
  link: 3,
  dimension: OW,
  force: true,
  blocks: [
    { pos: [120, 80, -180], expected: "minecraft:stone", state: "minecraft:oak_planks" },
    { pos: [121, 80, -180], expected: "minecraft:stone", state: "minecraft:oak_planks" },
  ],
});
{
  const pal = ["minecraft:oak_planks", "minecraft:stone_bricks", STAIRS, "minecraft:glass"];
  const blocks: PatchBlock[] = [];
  for (let dy = 0; dy < 16; dy++)
    for (let dz = 0; dz < 40; dz++)
      for (let dx = 0; dx < 40; dx++) {
        if ((dx + 3 * dy + 7 * dz) % 5 === 0) continue;
        blocks.push({ pos: [100 + dx, 64 + dy, -200 + dz], expected: dy < 8 ? AIR : "minecraft:stone", state: pal[(dx + dy + dz) % 4]! });
      }
  vector("patch-large", "mcp", `A large patch of ${blocks.length} blocks, described by a rule rather than listed`, { type: "patch", id: 25, link: 3, dimension: OW, blocks }, {
    generated:
      'For dy in 0..15, dz in 0..39, dx in 0..39 (y outermost, x innermost), skip when (dx + 3*dy + 7*dz) % 5 == 0; otherwise a block at (100+dx, 64+dy, -200+dz) with expected "minecraft:air" when dy < 8, else "minecraft:stone", and new state ["minecraft:oak_planks", "minecraft:stone_bricks", "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]", "minecraft:glass"][(dx + dy + dz) % 4]. No NBT, no expected NBT hashes.',
  });
}

// ── acks, dirty ────────────────────────────────────────────────────────────────────────────────
vector("ack-applied", "mod", "Every block applied", { type: "patch.ack", id: 21, applied: 1, overwritten: 0, skipped: [], rejected: [], normalized: [] });
vector("ack-mixed", "mod", "Applied, skipped (hand-edited, with actual state and NBT), rejected and normalized positions", {
  type: "patch.ack",
  id: 23,
  applied: 1,
  overwritten: 0,
  skipped: [
    { pos: [111, 70, -190], state: "minecraft:furnace[facing=south,lit=false]", nbt: S('{id:"minecraft:furnace",BurnTime:0s,CookTime:0s,CookTimeTotal:200s,RecipesUsed:{},Items:[]}') },
    { pos: [112, 70, -190], state: "minecraft:cobblestone" },
  ],
  rejected: [{ pos: [113, 70, -190], reason: "unknown_state" }],
  normalized: [{ pos: [110, 70, -190], nbt: S('{id:"minecraft:chest",Items:[{Slot:0b,id:"minecraft:oak_planks",count:3},{Slot:13b,id:"minecraft:lantern",count:1}],components:{}}') }],
});
vector("ack-force", "mod", "A forced patch: both blocks applied, one over a hand edit", { type: "patch.ack", id: 24, applied: 2, overwritten: 1, skipped: [], rejected: [], normalized: [] });
vector("ack-stale", "mod", "A patch built for an older work volume: every position rejected", {
  type: "patch.ack",
  id: 26,
  applied: 0,
  overwritten: 0,
  skipped: [],
  rejected: [
    { pos: [100, 64, -200], reason: "stale_link" },
    { pos: [101, 64, -200], reason: "stale_link" },
  ],
  normalized: [],
});
vector("dirty-positions", "mod", "Hand edits in one tick, with the states (and NBT) the world holds at the end of that tick", {
  type: "dirty",
  everything: false,
  blocks: [
    { pos: [105, 66, -195], state: "minecraft:torch" },
    { pos: [104, 66, -195], state: AIR },
    { pos: [99, 64, -201], state: "minecraft:chest[facing=west,type=single,waterlogged=false]", nbt: S('{id:"minecraft:chest",Items:[]}') },
  ],
});
vector("dirty-everything", "mod", `More than the cap of positions changed in one tick`, { type: "dirty", everything: true });

// ── prompting ──────────────────────────────────────────────────────────────────────────────────
vector("prompt", "mod", "An in-game request with full game context", {
  type: "prompt",
  id: 1,
  player: { name: "Kev", uuid: UUID_KEV },
  text: "put a balcony here",
  context: {
    dimension: OW,
    position: [110.5, 64, -185.25],
    eye: [110.5, 65.62, -185.25],
    yaw: 172.5,
    pitch: 12.25,
    facing: "north",
    target: { pos: [110, 66, -190], state: "minecraft:oak_planks", face: "south" },
    focus: { min: [108, 66, -191], max: [112, 68, -190] },
  },
  mode: "build",
});
vector("prompt-minimal", "mod", "An ask request looking at nothing, no focus box", {
  type: "prompt",
  id: 2,
  player: { name: "Alex", uuid: UUID_ALEX },
  text: "what is the tower over there made of?",
  context: { dimension: OW, position: [0.5, 70, 0.5], eye: [0.5, 71.62, 0.5], yaw: -90.5, pitch: -30.75, facing: "east" },
  mode: "ask",
});
vector("prompt-scan", "mod", "A scan request (/autosketch scan 20 the tower and the courtyard): radius clipped to 12 chunks, the columns and full-block box the mod grants for the probe", {
  type: "prompt",
  id: 3,
  player: { name: "Kev", uuid: UUID_KEV },
  text: "the tower and the courtyard",
  context: { dimension: OW, position: [-40.5, 68, 23.5], eye: [-40.5, 69.62, 23.5], yaw: 45, pitch: 10, facing: "west" },
  mode: "scan",
  scan: { radius: 12, clipped: true, columns: { min: [-240, -176], max: [159, 223] }, box: { min: [-144, 36, -80], max: [62, 132, 126] } },
});
vector("prompt-close", "mod", "The player ran /autosketch done: end the open read-only request (sent only when the MCP's hello lists prompt.close)", { type: "prompt.close", player: { name: "Kev", uuid: UUID_KEV } });
vector("prompt-result-delivered", "mcp", "Request delivered to the agent session", { type: "prompt.result", id: 1, delivered: true });
vector("prompt-result-refused", "mcp", "Request refused: the player isn't on the allowlist", { type: "prompt.result", id: 2, delivered: false, reason: "not_allowed" });
vector("prompt-result-unsupported-mode", "mcp", "Request refused: its mode isn't one the MCP's hello listed (the mod should have refused it itself)", { type: "prompt.result", id: 3, delivered: false, reason: "unsupported_mode" });
vector("notice", "mcp", "Action-bar text for every player with notices on", { type: "notice", text: "Autosketch: 1,204 placed, 3 skipped", player: null });
vector("notice-prompt-closed", "mcp", "The MCP's answer to prompt.close, on that player's action bar", { type: "notice", text: "Autosketch: ask request 3 ended; the agent may edit again.", player: UUID_KEV });
vector("chat-activity", "mcp", "Activity lines following a request, to the requesting player", { type: "chat", request: 1, player: UUID_KEV, kind: "activity", lines: ["fill: 1,204 blocks", "world: 1,204 placed, 3 skipped (hand-edited), 0 rejected"] });
vector("chat-reply", "mcp", "The agent's reply closing a request", { type: "chat", request: 1, player: UUID_KEV, kind: "reply", lines: ["Balcony added on the south face, 5 wide.", "Tell me if you want railings."] });

// ── registry report and upgrades (protocol 3) ──────────────────────────────────────────────────
{
  // A synthetic report in format 1 (`14`, *Version-specific data lives in the mod*): one modded block
  // with a property its blockstate file wouldn't list (waterlogged), and one tag.
  const report = {
    format: 1,
    minecraft: "1.21.1",
    dataVersion: 3955,
    loader: "neoforge",
    loaderVersion: "21.1.249",
    blocks: {
      "examplemod:gear": { properties: { axis: ["x", "y", "z"], waterlogged: ["true", "false"] }, default: { axis: "y", waterlogged: "false" }, blockEntity: true },
      "minecraft:air": {},
      "minecraft:stone": {},
    },
    tags: { "minecraft:mineable/pickaxe": ["examplemod:gear", "minecraft:stone"] },
  };
  const json = Buffer.from(JSON.stringify(report), "utf8");
  const hash = createHash("sha256").update(json).digest("hex").slice(0, 16);
  vector("registry", "mcp", "The MCP asks for the registry report, holding none", { type: "registry", id: 50 });
  vector("registry-have", "mcp", "The MCP asks for the registry report, holding the one with this hash (from the file beside the pointer)", { type: "registry", id: 51, have: hash });
  vector("registry-result", "mod", "The registry report: the gzip file the mod writes beside its pointer file, as the body; hash over the uncompressed JSON", {
    type: "registry.result",
    id: 50,
    hash,
    dataVersion: 3955,
    report: new Uint8Array(gzipSync(json, { level: 9 })),
  });
  vector("registry-result-unchanged", "mod", "The MCP already holds this report: no body", { type: "registry.result", id: 51, hash, dataVersion: 3955, unchanged: true });
}
vector("upgrade-elements", "mcp", "Upgrade a 1.19.4 schematic's elements: palette states as the file names them, a sign with its pre-1.20 text layout, an armor stand", {
  type: "upgrade",
  id: 60,
  from: 3337,
  kind: "elements",
  states: ["minecraft:grass", "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]", "othermod:gizmo[lit=true]"],
  blockEntities: [S('{id:"minecraft:sign",Text1:"{\\"text\\":\\"North\\"}",Text2:"{\\"text\\":\\"\\"}",Text3:"{\\"text\\":\\"\\"}",Text4:"{\\"text\\":\\"\\"}",Color:"black",GlowingText:0b}')],
  entities: [S('{id:"minecraft:armor_stand",Rotation:[90.0f,0.0f],Invisible:0b}')],
});
vector("upgrade-result-elements", "mod", "The upgraded elements, in the request's order: grass became short_grass, the unknown block passed through, the sign's text moved to front_text and back_text (the game keeps the old keys too; left out here)", {
  type: "upgrade.result",
  id: 60,
  to: 3955,
  kind: "elements",
  states: ["minecraft:short_grass", "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]", "othermod:gizmo[lit=true]"],
  blockEntities: [S('{id:"minecraft:sign",is_waxed:0b,front_text:{has_glowing_text:0b,color:"black",messages:["{\\"text\\":\\"North\\"}","{\\"text\\":\\"\\"}","{\\"text\\":\\"\\"}","{\\"text\\":\\"\\"}"]},back_text:{has_glowing_text:0b,color:"black",messages:["\\"\\"","\\"\\"","\\"\\"","\\"\\""]}}')],
  entities: [S('{id:"minecraft:armor_stand",Rotation:[90.0f,0.0f],Invisible:0b}')],
});
vector("upgrade-result-failed", "mod", "An upgrade where the fixer threw on one element, returned unchanged and counted in failed", {
  type: "upgrade.result",
  id: 61,
  to: 3955,
  failed: 1,
  kind: "elements",
  states: ["minecraft:stone"],
  blockEntities: [S('{id:"examplemod:broken",Data:[I;1,2,3]}')],
  entities: [],
});
{
  const structure = S('{size:[1,1,1],palette:[{Name:"minecraft:grass_path"}],blocks:[{pos:[0,0,0],state:0}],entities:[]}');
  vector("upgrade-structure", "mcp", "Upgrade a whole structure file (STRUCTURE fix type); it has no DataVersion, so from is 500 as the game assumes", { type: "upgrade", id: 62, from: 500, kind: "structure", structure });
  vector("upgrade-result-structure", "mod", "The upgraded structure, stamped with the running version", {
    type: "upgrade.result",
    id: 62,
    to: 3955,
    kind: "structure",
    structure: S('{DataVersion:3955,size:[1,1,1],palette:[{Name:"minecraft:dirt_path"}],blocks:[{pos:[0,0,0],state:0}],entities:[]}'),
  });
}

// ── in-game UI (feature ui, added within protocol 3) ───────────────────────────────────────────
{
  const players = [UUID_KEV, UUID_ALEX];
  const jobA: UiJob = { id: "j1", colour: "#3fa7d6", brief: "east tower: four storeys, conical roof", dimension: OW, work: { min: [120, 64, -190], max: [131, 87, -179] }, context: [{ min: [119, 63, -191], max: [132, 88, -178] }] };
  const jobB: UiJob = { id: "j2", colour: "#f26419", brief: "courtyard paving", dimension: OW, work: { min: [100, 64, -200], max: [119, 64, -181] }, context: [] };
  vector("ui-state-full", "mcp", "The whole overlay state, as sent to every player when the connection opens: two jobs, an open ask request, token totals with a cost, no refusal", {
    type: "ui.state",
    players,
    seq: 1,
    full: true,
    jobs: [jobA, jobB],
    request: { id: 7, mode: "ask", text: "how tall should the east tower be?" },
    tokens: { input: 18234, output: 2210, cacheRead: 120400, cacheCreation: 5320, cost: 0.4825 },
    refusal: null,
  });
  vector("ui-state-changes", "mcp", "Changes since seq 1: job j1 changed (its brief) and is sent whole, j2 ended, the request closed, a refusal happened; tokens unchanged (absent)", {
    type: "ui.state",
    players,
    seq: 2,
    full: false,
    jobs: [{ ...jobA, brief: "east tower: five storeys, conical roof" }],
    removed: ["j2"],
    request: null,
    refusal: { code: "outside_work_volume", text: "set_blocks in j1 reached outside its work volume" },
  });
  vector("ui-state-resync", "mcp", "A full state answering one player's resync: only that player, the current seq without taking a new one, no jobs, no token figures yet", {
    type: "ui.state",
    players: [UUID_ALEX],
    seq: 2,
    full: true,
    jobs: [],
    request: null,
    tokens: null,
    refusal: { code: "outside_work_volume", text: "set_blocks in j1 reached outside its work volume" },
  });
  vector("ui-flash", "mcp", "Boxes changed in one 250 ms window: two boxes by job j1, one by the root", {
    type: "ui.flash",
    players,
    flashes: [
      { job: "j1", colour: "#3fa7d6", dimension: OW, boxes: [{ min: [120, 64, -190], max: [131, 64, -179] }, { min: [125, 65, -185], max: [125, 70, -185] }] },
      { job: "base", colour: "#9b9b9b", dimension: OW, boxes: [{ min: [100, 63, -200], max: [100, 63, -200] }] },
    ],
  });
  const section = (f: (i: number) => number) => Uint32Array.from({ length: 4096 }, (_, i) => f(i));
  const STONE = "minecraft:stone_bricks";
  vector("ui-ghost-full", "mcp", "A sandbox's whole ghost: two sections of its local grid (a floor in the first, the corner posts in the second), job j1's tint", {
    type: "ui.ghost",
    players,
    ghost: "j1",
    dimension: OW,
    origin: [120, 64, -190],
    tint: "#3fa7d6",
    full: true,
    palette: [AIR, STONE, STAIRS],
    sections: [
      { section: [0, 0, 0], states: section((i) => (i < 256 ? 1 : i < 512 && i % 16 === 0 ? 2 : 0)) },
      { section: [0, 1, 0], states: section((i) => ((i & 15) === 0 && ((i >> 4) & 15) === 0 ? 1 : 0)) },
    ],
  });
  vector("ui-ghost-update", "mcp", "A partial update: one section replaced (all air now, so the client frees it); the ghost's other sections stay", {
    type: "ui.ghost",
    players,
    ghost: "j1",
    dimension: OW,
    origin: [120, 64, -190],
    tint: "#3fa7d6",
    full: false,
    palette: [AIR],
    sections: [{ section: [0, 1, 0], states: section(() => 0) }],
  });
  vector("ui-ghost-move", "mcp", "An anchored document's ghost moved to a new origin: no sections, so no blocks resent (the body is an empty palette and an empty NBT list)", {
    type: "ui.ghost",
    players: [UUID_KEV],
    ghost: "anchor-1",
    dimension: OW,
    origin: [40, 70, 12],
    tint: "#b0b0b0",
    full: false,
    palette: [],
    sections: [],
  });
  vector("ui-ghost-clear", "mcp", "Job j1 merged: its ghost goes", { type: "ui.ghost.clear", players, ghost: "j1" });
  const replayBox: WireBox = { min: [100, 64, -200], max: [103, 65, -199] };
  vector("replay-frame-keyframe", "mcp", "The first frame of a replay: every position of the replayed volume at step 12, with the strip's markers, one open job and the step's flash", {
    type: "replay.frame",
    players: [UUID_KEV],
    replay: "r1",
    step: 12,
    steps: 40,
    keyframe: true,
    dimension: OW,
    palette: [AIR, STONE, "minecraft:oak_planks"],
    regions: [{ box: replayBox, states: Uint32Array.from([1, 1, 1, 1, 1, 2, 2, 1, 0, 0, 0, 0, 0, 2, 0, 0]) }],
    time: "2026-11-17T10:15:30.250Z",
    hud: { call: "fill: 6 blocks", brief: "courtyard paving" },
    jobs: [jobB],
    flashes: [{ job: "j2", colour: "#f26419", dimension: OW, boxes: [{ min: [100, 64, -200], max: [103, 64, -199] }] }],
    markers: [
      { step: 3, kind: "checkpoint", label: "before paving" },
      { step: 5, kind: "fork", label: "j2: courtyard paving" },
      { step: 18, kind: "refusal", label: "outside_work_volume" },
      { step: 30, kind: "merge", label: "j2" },
    ],
  });
  vector("replay-frame-delta", "mcp", "A forward delta from step 12 to 13: two positions changed, and the strip carries a gap note for the steps after it", {
    type: "replay.frame",
    players: [UUID_KEV],
    replay: "r1",
    step: 13,
    steps: 40,
    keyframe: false,
    from: 12,
    dimension: OW,
    blocks: [
      { pos: [100, 65, -200], state: "minecraft:oak_planks" },
      { pos: [103, 65, -199], state: AIR },
    ],
    time: "2026-11-17T10:15:31.000Z",
    hud: { call: "set_blocks: 2 blocks", brief: null, note: "no deltas recorded for steps 14 to 16; the nearest time-lapse snapshot is at step 17" },
    jobs: [],
    flashes: [],
  });
  vector("ui-request-resync", "mod", "A client fell behind (a gap in seq) and asks for the whole state again", { type: "ui.request", request: 1, player: { name: "Alex", uuid: UUID_ALEX }, kind: "resync", args: {} });
  vector("ui-request-settings-set", "mod", "Save one setting, with the config.toml hash the screen read", {
    type: "ui.request",
    request: 2,
    player: { name: "Kev", uuid: UUID_KEV },
    kind: "settings.set",
    args: { key: "scope.maxDepth", value: "2", hash: "5d41402abc4b2a76" },
  });
  vector("ui-request-ghost-anchor", "mod", "Anchor the open unlinked document's ghost at the player's position (/autosketch ghost here)", {
    type: "ui.request",
    request: 3,
    player: { name: "Kev", uuid: UUID_KEV },
    kind: "ghost.anchor",
    args: { dimension: OW, pos: [40, 70, 12] },
  });
  // `17` piece 3: candidates in a reply.
  vector("chat-reply-action", "mcp", "A reply offering candidates: its last line is clickable and makes the client send candidates.open (feature ui; a client without it shows plain text)", {
    type: "chat",
    request: 12,
    player: UUID_KEV,
    kind: "reply",
    lines: ["Three towers in your library match: a slim gothic one, a round keep tower and a gatehouse.", "[Show candidates]"],
    action: { line: 1, kind: "candidates.open", args: { id: "c1" } },
  });
  vector("ui-request-candidates-open", "mod", "The player clicked [Show candidates]: open the list", {
    type: "ui.request",
    request: 8,
    player: { name: "Kev", uuid: UUID_KEV },
    kind: "candidates.open",
    args: { id: "c1" },
  });
  vector("ui-result-candidates-open", "mcp", "The candidates list: cells as on the agent's last sheet, the open request and its question", {
    type: "ui.result",
    request: 8,
    player: UUID_KEV,
    ok: true,
    result: {
      id: "c1",
      request: 12,
      question: "show me a tower",
      entries: [
        { cell: "B2", prefab: "gothic_tower_a", root: "user", size: [7, 24, 7], tags: ["gothic", "tower"], notes: "corner piece, door on the south face" },
        { cell: "C2", prefab: "round_keep_tower", root: "user", size: [9, 18, 9], tags: ["tower", "keep"], notes: null },
        { cell: "A3", prefab: "gate_small", root: "starter", size: [11, 9, 5], tags: ["gate"], notes: null },
      ],
    },
  });
  vector("ui-request-candidates-ghost", "mod", "Preview here: one candidate as the candidate ghost at the block the player looks at, turned 90 degrees", {
    type: "ui.request",
    request: 9,
    player: { name: "Kev", uuid: UUID_KEV },
    kind: "candidates.ghost",
    args: { id: "c1", prefab: "gothic_tower_a", dimension: OW, at: [120, 64, -180], rotate: 90 },
  });
  vector("ui-result-candidates-ghost", "mcp", "The candidate ghost's id; the ghost follows as a full ui.ghost", {
    type: "ui.result",
    request: 9,
    player: UUID_KEV,
    ok: true,
    result: { ghost: "candidate" },
  });
  vector("ui-request-candidates-ghost-clear", "mod", "Clear candidate ghost, from the Autosketch menu", {
    type: "ui.request",
    request: 10,
    player: { name: "Kev", uuid: UUID_KEV },
    kind: "candidates.ghost.clear",
    args: {},
  });
  vector("ui-request-candidates-submit", "mod", "Submit: two picks, one labelled, and a note", {
    type: "ui.request",
    request: 11,
    player: { name: "Kev", uuid: UUID_KEV },
    kind: "candidates.submit",
    args: { id: "c1", picks: [{ prefab: "gothic_tower_a", cell: "B2", label: "corner tower" }, { prefab: "gate_small", cell: "A3" }], note: "smaller if possible" },
  });
  vector("ui-result-candidates-submit", "mcp", "The picks went to the agent as text on in-game request 12", {
    type: "ui.result",
    request: 11,
    player: UUID_KEV,
    ok: true,
    result: { request: 12 },
  });
  vector("ui-result-answered", "mcp", "A second submit (or an open) after the list was answered", {
    type: "ui.result",
    request: 13,
    player: UUID_KEV,
    ok: false,
    error: "answered",
    message: "You already answered these candidates.",
  });
  vector("ui-result-settings-list", "mcp", "Settings rows for the settings screen: one toggle and one number field, with sources, an overridden launch value and a restart-needed mark", {
    type: "ui.result",
    request: 4,
    player: UUID_KEV,
    ok: true,
    result: {
      path: "/home/kev/.autosketch/config.toml",
      hash: "5d41402abc4b2a76",
      warnings: [],
      unknown: [],
      settings: [
        { key: "library.starter", group: "Library", summary: "Include the starter library", applies: "restart", accepts: "true or false", control: { type: "toggle" }, default: true, value: true, text: "true", source: { kind: "default", label: "default" }, restartNeeded: false },
        {
          key: "scope.maxDepth",
          group: "Scopes",
          summary: "How deep scoped jobs may nest",
          applies: "restart",
          accepts: "an integer from 0 to 3",
          control: { type: "number", min: 0, max: 3 },
          default: 1,
          value: 2,
          text: "2",
          source: { kind: "file", label: "config.toml" },
          overrides: { label: "command line", raw: "1", same: false, note: "launch command sets scope.maxDepth=1; ignored, config.toml says 2" },
          restartNeeded: true,
          running: 1,
        },
      ],
    },
  });
  vector("ui-result-conflict", "mcp", "A settings write refused: config.toml changed since the screen read it", {
    type: "ui.result",
    request: 2,
    player: UUID_KEV,
    ok: false,
    error: "conflict",
    message: "config.toml changed since the settings screen read it; reloading",
  });
  vector("ui-result-not-allowed", "mcp", "A request from a player who isn't on the allowlist", {
    type: "ui.result",
    request: 5,
    player: UUID_ALEX,
    ok: false,
    error: "not_allowed",
    message: "Alex isn't on world.promptPlayers, so can't use the Autosketch screens",
  });
  vector("ui-result-thumbnail", "mcp", "A prefab thumbnail: a synthetic 2×2 PNG as the body", {
    type: "ui.result",
    request: 6,
    player: UUID_KEV,
    ok: true,
    result: { format: "png", width: 2, height: 2 },
    body: tinyPng(),
  });
  vector("ui-result-preview", "mcp", "A prefab's blocks for the 3D preview: a 2×2×1 region, prefab-local, as the body", {
    type: "ui.result",
    request: 7,
    player: UUID_KEV,
    ok: true,
    result: { size: [2, 2, 1] },
    body: encodePreviewBody([STONE, AIR, "minecraft:lantern[hanging=false,waterlogged=false]"], [2, 2, 1], Uint32Array.from([0, 0, 2, 1])),
  });

  // relay-parts: no .bin (it would be over a megabyte); both sides rebuild the frame from the rule.
  const sections: UiGhost["sections"] = [];
  let k = 0;
  for (let sy = 0; sy < 2; sy++)
    for (let sz = 0; sz < 10; sz++)
      for (let sx = 0; sx < 13; sx++) {
        const kk = k++;
        sections.push({ section: [sx, sy, sz], states: section((i) => (i + kk) % 3) });
      }
  const big: UiGhost = { type: "ui.ghost", players: [UUID_KEV], ghost: "j9", dimension: OW, origin: [0, 64, 0], tint: "#3fa7d6", full: true, palette: [AIR, "minecraft:stone", "minecraft:glass"], sections };
  const frame = encodeMessage(big);
  const parts: { bytes: number; sha256: string }[] = [];
  for (let p = 0; p < frame.length; p += UI_PART_BYTES) {
    const part = frame.subarray(p, Math.min(frame.length, p + UI_PART_BYTES));
    parts.push({ bytes: part.length, sha256: createHash("sha256").update(part).digest("hex") });
  }
  const { header } = splitFrame(frame.subarray(4));
  writeFileSync(
    join(dir, "relay-parts.json"),
    pretty({
      description: "A ghost frame over 1,000,000 bytes and the parts the relay splits it into (13, *Relay to the client*). No .bin: rebuild the frame from the rule, check its length and hash, then split it",
      sender: "mcp",
      header,
      generated:
        'Sections in header order: for sy in 0..1, sz in 0..9, sx in 0..12 (sy outermost, sx innermost), the k-th section (k from 0) holding at local index i (0..4095, x fastest, then z, then y) the state ["minecraft:air", "minecraft:stone", "minecraft:glass"][(i + k) % 3]. No NBT.',
      frame: { bytes: frame.length, sha256: createHash("sha256").update(frame).digest("hex") },
      partBytes: UI_PART_BYTES,
      parts,
    }),
  );
}

/** A synthetic 2×2 RGB PNG (two colours), built here so nothing comes from the game's assets. */
function tinyPng(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.from([0, 0x3f, 0xa7, 0xd6, 0xf2, 0x64, 0x19, 0, 0xf2, 0x64, 0x19, 0x3f, 0xa7, 0xd6]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

// ── hashing ────────────────────────────────────────────────────────────────────────────────────
/** The starting default list the hash vectors were cut with; pinned so the frozen hash vectors don't follow later growth of `DEFAULT_VOLATILE`. */
const STARTING_VOLATILE: VolatileList = Object.fromEntries(["minecraft:furnace", "minecraft:blast_furnace", "minecraft:smoker", "minecraft:hopper", "minecraft:brewing_stand"].map((k) => [k, DEFAULT_VOLATILE[k]!]));
interface NbtCase {
  name: string;
  description: string;
  snbt: string;
  volatile: VolatileList;
}
const nbtCases: NbtCase[] = [
  { name: "empty", description: "An empty compound", snbt: "{}", volatile: {} },
  { name: "unordered", description: "Keys given out of order are sorted; position keys x, y, z are removed", snbt: '{z:5,id:"minecraft:barrel",y:64,Items:[],x:-3,CustomName:"\\"Stash\\""}', volatile: {} },
  { name: "nested", description: "Nested compounds and a list of compounds sort their keys recursively; x inside a nested compound stays", snbt: '{id:"test:machine",b:{zeta:1b,alpha:{y:2s,x:1s}},a:[{k2:1,k1:2},{k1:3}]}', volatile: {} },
  {
    name: "all-types",
    description: "Every tag type: byte, short, int, long, float, double, string, byte array, int array, long array, list of lists, empty list",
    snbt: '{id:"test:all",b:-5b,s:-300s,i:-70000,l:-5000000000L,big:9223372036854775807L,f:0.15625f,d:-2.5d,str:"text",ba:[B;1b,-1b],ia:[I;1,-2,3],la:[L;1L,-1L],lol:[[I;1,2],[I;3]],ll:[[1,2],[3s]],e:[]}',
    volatile: {},
  },
  { name: "unicode", description: "Strings with an emoji and U+00E9 are written in Java modified UTF-8", snbt: '{id:"minecraft:oak_sign",text:"café \u{1F600}"}', volatile: {} },
  { name: "furnace-default", description: "A furnace with the default volatile list: burn and cook times dropped, items and RecipesUsed kept", snbt: snbtOf(FURNACE), volatile: STARTING_VOLATILE },
  { name: "furnace-ticked", description: "The same furnace a few ticks later (only volatile keys changed): same hash as furnace-default", snbt: '{id:"minecraft:furnace",BurnTime:97s,CookTime:63s,CookTimeTotal:200s,RecipesUsed:{},Items:[{Slot:0b,id:"minecraft:raw_iron",count:5}]}', volatile: STARTING_VOLATILE },
  { name: "furnace-no-volatile", description: "The same furnace with an empty volatile list: every key hashed", snbt: snbtOf(FURNACE), volatile: {} },
  { name: "nested-path", description: "A nested volatile path (Network/Stress) and a key dropped for every type (*)", snbt: '{id:"create:mechanical_press",Speed:32.0f,Network:{Id:7L,Stress:12.5f},Owner:"Kev",LastTick:1234L}', volatile: { "*": ["LastTick"], "create:mechanical_press": ["Speed", "Network/Stress"] } },
  { name: "state-only", description: "A state-only type has no NBT hash", snbt: '{id:"create:belt",Speed:1.0f}', volatile: { "create:belt": "state_only" } },
];

const nbtOut = nbtCases.map((c) => {
  const value = parseSnbt(c.snbt);
  const canon = canonicalNbt(value, c.volatile);
  return { ...c, canonical: canon ? bytesToHex(canon) : null, hash: nbtHash(value, c.volatile) ?? null };
});
writeFileSync(join(dir, "hash-nbt.json"), pretty({ description: "NBT hash vectors: canonical bytes (hex) and hash (first 8 bytes of SHA-256, hex) of each compound under its volatile list. null = state only.", cases: nbtOut }));

interface SectionCase {
  name: string;
  description: string;
  section: [number, number, number];
  boxes: WireBox[];
  volatile: VolatileList;
  /** State of every position not listed in `blocks`. */
  fill: string;
  blocks: { pos: [number, number, number]; state: string; nbt?: string }[];
}
const sectionCases: SectionCase[] = [
  { name: "air-full", description: "A section of air, fully inside the box", section: [0, 4, 0], boxes: [{ min: [0, 64, 0], max: [15, 79, 15] }], volatile: {}, fill: AIR, blocks: [] },
  { name: "air-one", description: "A single position of the section inside the box", section: [0, 4, 0], boxes: [{ min: [3, 70, 5], max: [3, 70, 5] }], volatile: {}, fill: AIR, blocks: [] },
  {
    name: "mixed-partial",
    description: "Negative section coordinates, two overlapping boxes covering part of the section, mixed states, one block outside both boxes (ignored)",
    section: [-1, -4, -2],
    boxes: [
      { min: [-16, -64, -32], max: [-9, -60, -25] },
      { min: [-12, -62, -28], max: [-1, -57, -20] },
    ],
    volatile: {},
    fill: "minecraft:stone",
    blocks: [
      { pos: [-16, -64, -32], state: "minecraft:deepslate[axis=y]" },
      { pos: [-1, -57, -20], state: AIR },
      { pos: [-10, -61, -26], state: STAIRS },
      { pos: [-1, -49, -17], state: "minecraft:gold_block" },
    ],
  },
  {
    name: "block-entities",
    description: "Block entities: a chest (hashed), a furnace (volatile keys dropped) and a state-only type (no hash, flag 0)",
    section: [6, 4, -13],
    boxes: [work],
    volatile: { ...STARTING_VOLATILE, "create:belt": "state_only" },
    fill: AIR,
    blocks: [
      { pos: [100, 64, -200], state: "minecraft:chest[facing=north,type=single,waterlogged=false]", nbt: snbtOf(CHEST) },
      { pos: [101, 64, -200], state: "minecraft:furnace[facing=south,lit=true]", nbt: snbtOf(FURNACE) },
      { pos: [102, 64, -200], state: "create:belt[casing=false,facing=east,part=middle,slope=horizontal]", nbt: '{id:"create:belt",Speed:1.0f}' },
    ],
  },
];
const sectionOut = sectionCases.map((c) => {
  const blocks = new Map(c.blocks.map((b) => [b.pos.join(","), { state: b.state, nbt: b.nbt ? parseSnbt(b.nbt) : undefined }]));
  const hash = sectionHash(c.section, c.boxes, (x, y, z) => blocks.get(`${x},${y},${z}`) ?? { state: c.fill }, c.volatile);
  return { ...c, hash: hash ?? null };
});
writeFileSync(join(dir, "hash-sections.json"), pretty({ description: "Section hash vectors. Positions not in `blocks` hold `fill`; only positions inside at least one box are hashed.", cases: sectionOut }));
console.log("golden vectors written to", dir);
