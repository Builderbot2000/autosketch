/**
 * Regenerates the golden vectors in this folder (docs/design/13-live-world.md, *Wire format*,
 * *Golden vectors*). Run: `npx tsx test/data/world-protocol/generate.ts`. All content is synthetic.
 * The vectors are frozen: regenerate only for a protocol change, and say so in the commit.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeFrame, encodeMessage } from "../../../src/world/protocol/codec.js";
import { canonicalNbt, DEFAULT_VOLATILE, nbtHash, sectionHash } from "../../../src/world/protocol/hash.js";
import type { Message, PatchBlock, Sender, VolatileList, WireBox } from "../../../src/world/protocol/messages.js";
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
vector("hello-mcp", "mcp", "MCP hello: protocol, pairing token, client, volatile-key list (the built-in default plus one plugin entry and one state-only type)", {
  type: "hello",
  protocol: 1,
  token: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  client: { name: "autosketch", version: "1.0.0" },
  volatile: { ...DEFAULT_VOLATILE, "create:mechanical_press": ["Speed", "Network/Stress"], "create:belt": "state_only" },
});
vector("hello-mod-singleplayer", "mod", "Mod hello from the integrated server of a singleplayer world", {
  type: "hello",
  protocol: 1,
  mod: { version: "0.1.0" },
  game: { version: "1.21.1", dataVersion: 3955, loader: "neoforge", loaderVersion: "21.1.249" },
  singleplayer: true,
  host: { name: "Kev", uuid: UUID_KEV },
});
vector("hello-mod-dedicated", "mod", "Mod hello from a dedicated server (no host player)", {
  type: "hello",
  protocol: 1,
  mod: { version: "0.1.0" },
  game: { version: "1.21.1", dataVersion: 3955, loader: "neoforge", loaderVersion: "21.1.249" },
  singleplayer: false,
  host: null,
});
vector("error-protocol-mismatch", "mod", "The mod refuses a hello with another protocol version and closes", { type: "error", id: null, code: "protocol_mismatch", message: "mod speaks protocol 1, MCP sent 2", protocol: 1 });
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
});
vector("prompt-minimal", "mod", "A request looking at nothing, no focus box", {
  type: "prompt",
  id: 2,
  player: { name: "Alex", uuid: UUID_ALEX },
  text: "match the tower over there",
  context: { dimension: OW, position: [0.5, 70, 0.5], eye: [0.5, 71.62, 0.5], yaw: -90.5, pitch: -30.75, facing: "east" },
});
vector("prompt-result-delivered", "mcp", "Request delivered to the agent session", { type: "prompt.result", id: 1, delivered: true });
vector("prompt-result-refused", "mcp", "Request refused: the player isn't on the allowlist", { type: "prompt.result", id: 2, delivered: false, reason: "not_allowed" });
vector("notice", "mcp", "Action-bar text for every player with notices on", { type: "notice", text: "Autosketch: 1,204 placed, 3 skipped", player: null });
vector("chat-activity", "mcp", "Activity lines following a request, to the requesting player", { type: "chat", request: 1, player: UUID_KEV, kind: "activity", lines: ["fill: 1,204 blocks", "world: 1,204 placed, 3 skipped (hand-edited), 0 rejected"] });
vector("chat-reply", "mcp", "The agent's reply closing a request", { type: "chat", request: 1, player: UUID_KEV, kind: "reply", lines: ["Balcony added on the south face, 5 wide.", "Tell me if you want railings."] });

// ── hashing ────────────────────────────────────────────────────────────────────────────────────
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
  { name: "furnace-default", description: "A furnace with the default volatile list: burn and cook times dropped, items and RecipesUsed kept", snbt: snbtOf(FURNACE), volatile: DEFAULT_VOLATILE },
  { name: "furnace-ticked", description: "The same furnace a few ticks later (only volatile keys changed): same hash as furnace-default", snbt: '{id:"minecraft:furnace",BurnTime:97s,CookTime:63s,CookTimeTotal:200s,RecipesUsed:{},Items:[{Slot:0b,id:"minecraft:raw_iron",count:5}]}', volatile: DEFAULT_VOLATILE },
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
    volatile: { ...DEFAULT_VOLATILE, "create:belt": "state_only" },
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
