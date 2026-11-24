import type { Compound } from "prismarine-nbt";
import type { Vec3 } from "../../core/region.js";

/**
 * Message shapes of the bridge protocol (docs/design/13-live-world.md, *Wire format*, *Messages*).
 * Positions and boxes are world coordinates; boxes are inclusive (`01`). Body-bearing messages
 * (patch, snapshot.result, patch.ack, dirty) carry their decoded body here; the header fields that
 * only describe the encoding (origin, size, counts) are produced and checked by the codec.
 */

/** The protocol version this side speaks natively (`N`). */
export const PROTOCOL_VERSION = 4;
/**
 * Every version the MCP speaks: its own and the one before (`N`, `N−1`; `14`, *Version skew between
 * mod and MCP*). Version 4 only retired mode `scan` and `prompt.scan` (`18`, *Removal*), which this
 * MCP never asks a version-3 mod for (its hello doesn't list the mode), so one codec reads both.
 */
export const SUPPORTED_PROTOCOLS: readonly number[] = [PROTOCOL_VERSION, PROTOCOL_VERSION - 1];
/** Largest frame length value (bytes after the 4-byte length prefix). */
export const MAX_FRAME = 256 * 1024 * 1024;
/** Largest JSON header. */
export const MAX_HEADER = 1024 * 1024;
/** Most positions one `dirty` notice may list; the mod may be configured lower, so never assume the exact cap. */
export const DIRTY_CAP = 4096;
/** Pairing file, relative to the instance (game) directory. */
export const PAIRING_FILE = "config/autosketch-bridge.toml";
/** The handshake must finish within this many milliseconds of connecting. */
export const HELLO_TIMEOUT_MS = 10_000;

/** Inclusive world box. */
export interface WireBox {
  min: Vec3;
  max: Vec3;
}

/** Inclusive area of block columns, `[x, z]` world coordinates (`snapshot` kind `surface`). */
export interface WireArea {
  min: [number, number];
  max: [number, number];
}

/** 64-bit hash as 16 lowercase hex digits. */
export type Hash64 = string;

/**
 * Volatile-key list (*Hashing*): block-entity type id (the NBT `id`) or `"*"` (every type) → keys
 * to drop before hashing (`/` separates nested compound keys), or `"state_only"`.
 */
export type VolatileList = Record<string, string[] | "state_only">;

export interface PlayerRef {
  name: string;
  /** Lowercase hyphenated UUID. */
  uuid: string;
}

export type Face = "down" | "up" | "north" | "south" | "west" | "east";
export type Cardinal = "north" | "south" | "west" | "east";

export const REJECT_REASONS = ["unknown_state", "bad_nbt", "outside_volumes", "stale_link"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export const ERROR_CODES = ["protocol_mismatch", "bad_token", "not_ready", "bad_request", "unknown_type", "no_volumes", "wrong_dimension", "outside_volumes", "too_large", "replaced", "stale_link", "bad_extension", "bad_volumes", "internal", "no_grant"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const PROMPT_REFUSALS = ["no_link", "not_allowed", "no_listener", "unsupported_mode"] as const;
export type PromptRefusal = (typeof PROMPT_REFUSALS)[number];

/**
 * Request modes, named by the player's subcommand (`13`, B6). `select` (`18`, piece 1; feature
 * `select`) is read-only and may change the volumes; its prompt carries no grant. Protocol 4
 * retired `scan` (`18`, *Removal*).
 */
export const REQUEST_MODES = ["ask", "plan", "build", "select"] as const;
export type RequestMode = (typeof REQUEST_MODES)[number];

/**
 * Optional capabilities a mod's `hello` lists in `features` (*Versions and features*). The MCP uses
 * an addition only when the mod lists it, never because of the protocol number.
 */
export const MOD_FEATURES = ["modes", "volumes.set", "registry", "upgrade", "ui", "select"] as const;
export type ModFeature = (typeof MOD_FEATURES)[number];

/**
 * Optional capabilities the MCP's `hello` lists in `features` (*Versions and features*), mirroring
 * the mod's list: the mod uses an addition only when the MCP lists it. `prompt.close`: the MCP
 * handles the mod's `prompt.close` (`/autosketch done`, B6). `ui`: the MCP sends `16`'s in-game UI
 * messages and answers `ui.request` (*In-game UI*); used only when the mod lists `ui` too.
 */
export const MCP_FEATURES = ["prompt.close", "ui"] as const;
export type McpFeature = (typeof MCP_FEATURES)[number];

/** A world block as the mod reports it: canonical state, block-entity NBT when it has one. */
export interface WorldBlock {
  pos: Vec3;
  state: string;
  nbt?: Compound;
}

export interface ClientHello {
  type: "hello";
  protocol: number;
  token: string;
  client: { name: string; version: string };
  volatile: VolatileList;
  /** Request modes the MCP enforces; the mod never sends another. Absent (protocol 1) means `["build"]`. */
  modes?: RequestMode[];
  /** Optional capabilities (`MCP_FEATURES`; unknown names are kept and ignored). Absent means none. */
  features?: string[];
}

export interface ModHello {
  type: "hello";
  protocol: number;
  mod: { version: string };
  game: { version: string; dataVersion: number; loader: string; loaderVersion: string };
  singleplayer: boolean;
  host: PlayerRef | null;
  /** Optional capabilities (`MOD_FEATURES`; unknown names are kept and ignored). Absent (protocol 1) means none. */
  features?: string[];
}

export interface ErrorMessage {
  type: "error";
  id: number | null;
  code: ErrorCode;
  message: string;
  /** Only with `protocol_mismatch`: the sender's protocol version. */
  protocol?: number;
}

export type VolumesMessage =
  | {
      type: "volumes";
      link: number;
      dimension: string;
      /** The player's work volume. */
      work: WireBox;
      context: WireBox[];
      /** The MCP-declared extended work volume (whole blocks) in force for this link, if any. */
      extended?: WireBox;
      /** Only on the `volumes` that confirms a `volumes.set`: that request's id. */
      id?: number;
    }
  | { type: "volumes"; link: number; work: null };

/** The MCP declares the work volume extended to whole blocks, for the current link (*Wire format*, `volumes.extend`). */
export interface VolumesExtend {
  type: "volumes.extend";
  id: number;
  link: number;
  /** The extended work volume; must contain the player's work volume. */
  work: WireBox;
}

/** The MCP sets the work and context volumes, as if the player had marked them (*Wire format*, `volumes.set`; `13`, B4). */
export interface VolumesSet {
  type: "volumes.set";
  id: number;
  dimension: string;
  work: WireBox;
  /** Context boxes; absent means the default context (the work volume grown by 3). */
  context?: WireBox[];
}

export interface HashesRequest {
  type: "hashes";
  id: number;
  dimension: string;
  boxes: WireBox[];
}

export interface SectionHash {
  section: Vec3;
  hash: Hash64;
}

export interface HashesResult {
  type: "hashes.result";
  id: number;
  sections: SectionHash[];
}

export type SnapshotRequest = { type: "snapshot"; id: number; dimension: string; boxes: WireBox[] } | { type: "snapshot"; id: number; dimension: string; sections: Vec3[] };

/** A surface snapshot (`snapshot` kind `surface`): per column, the topmost non-air block, and optionally the ceiling above `ceiling`. */
export interface SurfaceRequest {
  type: "snapshot";
  id: number;
  dimension: string;
  kind: "surface";
  columns: WireArea;
  /** When given, each column also reports the lowest non-air block at or above this y. */
  ceiling?: number;
}

/**
 * One value per column of the area, x fastest, then z. `heights[i]` is 0 when the column has no
 * such block (all air, or its chunk is missing), else the block's y is `minY + heights[i] − 1`;
 * `states[i]` is its palette index (0, and not encoded, when `heights[i]` is 0).
 */
export interface SurfaceLayer {
  heights: Uint32Array;
  states: Uint32Array;
}

export interface SurfaceResult {
  type: "snapshot.result";
  id: number;
  dimension: string;
  kind: "surface";
  columns: WireArea;
  /** The dimension's lowest build y. */
  minY: number;
  ceiling?: number;
  /** Chunks `[cx, cz]` of the area that aren't generated, ascending by cz, then cx. */
  missing: [number, number][];
  palette: string[];
  surface: SurfaceLayer;
  /** Present exactly when `ceiling` is. */
  ceilings?: SurfaceLayer;
}

// ── Select (`18`; mod feature `select`, added within protocol 3) ────────────────────────────────

/** The interim margin around a shape's sections for `snapshot` kind `mask` (`18`, piece 5). */
export const MASK_MARGIN = 8;
/** Cell sizes a `snapshot` kind `coarse` takes (`18`, piece 5). */
export const COARSE_CELLS = [2, 4] as const;
export type CoarseCell = (typeof COARSE_CELLS)[number];
/** Interim search defaults (`18`, piece 2; *Measure first* may change them, the mod's config holds them). */
export const SEARCH_GAP = 2;
export const SEARCH_STOP = 1;
/** The interim `selectChunks`: search radius default and cap, and the select-mode read grant's radius, in chunks. */
export const SELECT_CHUNKS = 256;
/** Fill connectivity in the world when the request names none (`18`, piece 3). */
export const FILL_CONNECTIVITY = 26;
/**
 * The match entry that matches every non-air block (`{connected}`'s `solid`). Every other entry is a
 * block id (any state), a canonical state (exactly that state) or a block tag `#ns:path`.
 */
export const MATCH_SOLID = "solid";

/**
 * `snapshot` kind `mask` (`18`, piece 5): every position of the listed sections, plus every position
 * within `margin` blocks of them (the sections' boxes, not the shape's blocks, so the request needs no
 * mask). Answered by a blocks `snapshot.result` whose regions the mod lays out (*Message schemas*).
 */
export interface MaskSnapshotRequest {
  type: "snapshot";
  id: number;
  dimension: string;
  kind: "mask";
  /** The shape's sections, unique; their order is the result's region order. */
  sections: Vec3[];
  /** 0 to 16 blocks; absent means {@link MASK_MARGIN}. */
  margin?: number;
}

/**
 * `snapshot` kind `coarse` (`18`, piece 5): each box, grown outward to whole cells of the world grid
 * (multiples of `cell`), read as one block per cell: its most common non-air block (ties: the one met
 * first in index order), air when the cell is all air.
 */
export interface CoarseSnapshotRequest {
  type: "snapshot";
  id: number;
  dimension: string;
  kind: "coarse";
  cell: CoarseCell;
  boxes: WireBox[];
}

/** A coarse region: `box` aligned to the cell grid, one palette index per cell, x fastest, then z, then y. */
export interface CoarseRegion {
  box: WireBox;
  states: Uint32Array;
}

export interface CoarseResult {
  type: "snapshot.result";
  id: number;
  dimension: string;
  kind: "coarse";
  cell: CoarseCell;
  palette: string[];
  regions: CoarseRegion[];
  /** Chunks `[cx, cz]` the regions touch that aren't generated (they read as air); absent when none. */
  missing?: [number, number][];
}

/**
 * `search` (`18`, piece 2): a material search in rings of chunks outward from the centre, nearest
 * first, stopping once `stop` more clusters are closed or at the radius. The continuing form walks on
 * from where the previous search of this grant stopped, with its materials, centre, radius and gap.
 */
export type SearchRequest =
  | {
      type: "search";
      id: number;
      dimension: string;
      /** Block ids (any state), canonical states, or tags `#ns:path`; the MCP resolves words and families to these. */
      materials: string[];
      /** Chunks around the centre; absent: the mod's `selectChunks`, which also caps it. */
      radius?: number;
      /** A world position whose chunk is the centre; absent: the select request's player. */
      around?: Vec3;
      /** Rings past a cluster's farthest chunk before it counts as closed; absent: {@link SEARCH_GAP}. */
      gap?: number;
      /** Closed clusters to stop at; absent: {@link SEARCH_STOP}. */
      stop?: number;
    }
  | { type: "search"; id: number; dimension: string; continue: true; stop?: number };

/** A cluster of touching (edge or corner) matching chunks; `min`/`max` are chunk coordinates `[cx, cz]`. */
export interface SearchCluster {
  min: [number, number];
  max: [number, number];
  chunks: number;
  /** Matching blocks in its chunks, all materials together. */
  blocks: number;
  /** The walk has gone `gap` rings past its farthest chunk, so it can't grow. */
  closed: boolean;
}

/** One chunk with matches. */
export interface SearchChunk {
  chunk: [number, number];
  /** Matching blocks per material, in `materials` order. */
  counts: number[];
  /** Index into `clusters`. */
  cluster: number;
  /** Section y coordinates with matches, ascending. */
  sections: number[];
}

/** The whole walk so far (a continuing search's answer includes the earlier rings). */
export interface SearchResult {
  type: "search.result";
  id: number;
  dimension: string;
  materials: string[];
  /** The centre chunk `[cx, cz]`. */
  centre: [number, number];
  /** The radius walked to, after clipping to `selectChunks`. */
  radius: number;
  /** The request asked for more than `selectChunks`. */
  clipped?: true;
  /** The last ring walked completely (0: the centre chunk). The walk is complete when it equals `radius`. */
  reached: number;
  /** The dimension's lowest section y. */
  minSection: number;
  /** In walk order of each cluster's first chunk. */
  clusters: SearchCluster[];
  /** Ascending by cz, then cx. */
  chunks: SearchChunk[];
  /** Walked chunks that aren't generated, ascending by cz, then cx. */
  missing: [number, number][];
}

/**
 * `fill` (`18`, piece 3): grows a shape from `seed` through `match`, depth-first as `{connected}`,
 * inside a read area of chunks (initially those within `area` of the seed's chunk) and the select
 * grant. Replaces the grant's current fill.
 */
export interface FillRequest {
  type: "fill";
  id: number;
  dimension: string;
  seed: Vec3;
  /** Non-empty: block ids, canonical states, tags `#ns:path`, or {@link MATCH_SOLID}. */
  match: string[];
  /** 6, 18 or 26; absent: {@link FILL_CONNECTIVITY}. */
  connectivity?: 6 | 18 | 26;
  /** Most blocks this step adds; absent: the mod's `contextCap`. */
  budget?: number;
  /** Radius in chunks of the initial read area around the seed's chunk; absent: 1. */
  area?: number;
}

/** How `expand` grows the read area: the chunks the frontier reaches, chunks in one direction, or the chunks a box touches. */
export type ExpandBy = "frontier" | { direction: Cardinal; chunks: number } | { box: WireBox };

/** `expand` (`18`, piece 4): grows the current fill's read area and resumes the fill from its frontier with a fresh budget. */
export interface ExpandRequest {
  type: "expand";
  id: number;
  dimension: string;
  by: ExpandBy;
  budget?: number;
}

/** One section of a shape: a 4,096-bit set (512 bytes, bit `x + 16·(z + 16·y)`, LSB first) or every position. */
export interface MaskSection {
  section: Vec3;
  mask: Uint8Array | "full";
}

/**
 * Frontier positions of one section: shape positions whose exploration stopped at the read area's
 * edge or the budget, each with a face mask (bit 0 down, 1 up, 2 north, 3 south, 4 west, 5 east) of
 * the sides whose neighbour wasn't explored.
 */
export interface FrontierSection {
  section: Vec3;
  /** Local indices `x + 16·(z + 16·y)`, ascending. */
  index: number[];
  faces: number[];
}

export const FILL_STOPS = ["complete", "edge", "budget"] as const;
export type FillStop = (typeof FILL_STOPS)[number];

/** The answer to `fill` and `expand`. */
export interface FillResult {
  type: "fill.result";
  id: number;
  dimension: string;
  seed: Vec3;
  /** Blocks in the whole shape. */
  count: number;
  /** The whole shape's bounding box; null when the seed doesn't match. */
  box: WireBox | null;
  /** `budget`: the step's budget ran out; `edge`: the shape reaches the read area's edge; `complete`: neither. */
  stopped: FillStop;
  /** An `expand`'s answer: `sections` lists only the sections that changed, each replacing what the MCP holds. */
  delta?: true;
  /** Chunks of the read area that aren't generated (never read, never filled into), ascending by cz, then cx. */
  missing: [number, number][];
  /** Ascending by sy, then sz, then sx. */
  sections: MaskSection[];
  /** The whole current frontier, ascending by sy, then sz, then sx. */
  frontier: FrontierSection[];
}

export interface SnapshotRegion {
  box: WireBox;
  /** Palette index per position of the box, x fastest, then z, then y. */
  states: Uint32Array;
  /** Block entities inside the box (a position in two overlapping regions appears in both). */
  blockEntities: { pos: Vec3; nbt: Compound }[];
}

export interface SnapshotResult {
  type: "snapshot.result";
  id: number;
  dimension: string;
  palette: string[];
  regions: SnapshotRegion[];
  /** Select reads (feature `select`): chunks the regions touch that aren't generated (they read as air); absent when none. */
  missing?: [number, number][];
}

export interface PatchBlock {
  pos: Vec3;
  expected: string;
  expectedNbtHash?: Hash64;
  state: string;
  nbt?: Compound;
}

export interface PatchMessage {
  type: "patch";
  id: number;
  link: number;
  dimension: string;
  force?: boolean;
  blocks: PatchBlock[];
}

export interface PatchAck {
  type: "patch.ack";
  id: number;
  applied: number;
  overwritten: number;
  skipped: WorldBlock[];
  rejected: { pos: Vec3; reason: RejectReason }[];
  /** Applied positions whose block entity, as the game saved it, hashes differently from the patch's NBT. */
  normalized: { pos: Vec3; nbt?: Compound }[];
}

export type DirtyMessage = { type: "dirty"; everything: true } | { type: "dirty"; everything: false; blocks: WorldBlock[] };

export interface GameContext {
  dimension: string;
  position: [number, number, number];
  eye: [number, number, number];
  yaw: number;
  pitch: number;
  facing: Cardinal;
  target?: { pos: Vec3; state: string; face: Face };
  focus?: WireBox;
  focusClipped?: boolean;
}

export interface PromptMessage {
  type: "prompt";
  id: number;
  player: PlayerRef;
  text: string;
  context: GameContext;
  /** The player's subcommand (B6); absent (a mod without the `modes` feature) means `build`. */
  mode?: RequestMode;
}

/**
 * The player ended the open read-only request in game (`/autosketch done`, B6; MCP feature
 * `prompt.close`). Only the player lifts a read-only mode: the MCP ends whichever `ask`, `plan` or
 * `select` request is open and answers on the player's action bar with a `notice`.
 */
export interface PromptClose {
  type: "prompt.close";
  player: PlayerRef;
}

export type PromptResult = { type: "prompt.result"; id: number; delivered: true } | { type: "prompt.result"; id: number; delivered: false; reason: PromptRefusal };

/**
 * The MCP asks for the game's registry report (protocol 3, feature `registry`; `14`, *Version-specific
 * data lives in the mod*). `have` is the hash of the report the MCP already holds: the mod answers
 * `unchanged` without a body when it matches.
 */
export interface RegistryRequest {
  type: "registry";
  id: number;
  have?: Hash64;
}

/**
 * The registry report. `hash` is the first 8 bytes of SHA-256 over the report's uncompressed JSON;
 * `report` is the gzip file exactly as the mod writes it beside its pointer file (absent when
 * `unchanged`).
 */
export type RegistryResult =
  | { type: "registry.result"; id: number; hash: Hash64; dataVersion: number; unchanged: true }
  | { type: "registry.result"; id: number; hash: Hash64; dataVersion: number; report: Uint8Array };

/**
 * What an upgrade carries (`14`, *Schematics from other versions*): a schematic's elements (block
 * states, block-entity and entity NBT), or a whole structure file (`STRUCTURE` fix type).
 */
export type UpgradeData =
  | {
      kind: "elements";
      /** Block states as the file names them: `ns:id[name=value,…]`, not necessarily canonical. */
      states: string[];
      /** Block-entity compounds (`id`, no `x`/`y`/`z`). */
      blockEntities: Compound[];
      /** Entity compounds (`id`, no `Pos`). */
      entities: Compound[];
    }
  | { kind: "structure"; structure: Compound };

/** The MCP asks the mod to run the game's data fixer from `from` to the running version (protocol 3, feature `upgrade`). */
export type UpgradeRequest = { type: "upgrade"; id: number; from: number } & UpgradeData;

/**
 * The upgraded data, in the request's order and counts. `to` is the running game's DataVersion;
 * `failed` counts elements the fixer threw on, returned unchanged (omitted when 0).
 */
export type UpgradeResult = { type: "upgrade.result"; id: number; to: number; failed?: number } & UpgradeData;

export interface NoticeMessage {
  type: "notice";
  text: string;
  player: string | null;
}

export interface ChatMessage {
  type: "chat";
  request: number | null;
  player: string | null;
  kind: "activity" | "reply";
  lines: string[];
  /** Replies only, feature `ui` (`17`, piece 3): makes one line clickable. Absent: plain lines. */
  action?: ChatAction;
}

/**
 * A clickable reply line (`13`, `chat`): clicking `lines[line]` makes the player's client send the
 * `ui.request` `kind` with `args`, as replay's log lines do. The MCP sends it only when both hellos
 * list `ui`; a mod or client without it shows the line as plain text.
 */
export interface ChatAction {
  line: number;
  kind: string;
  args: Record<string, unknown>;
}

// ── In-game UI (feature `ui`, added within protocol 3; `13`, *In-game UI*; `16`) ───────────────

/** The coalescing window for `ui.state`, `ui.flash` and ghost updates (*In-game UI*, "Never slows the build"). */
export const UI_COALESCE_MS = 250;
/** Most boxes one flash record lists; beyond that the MCP merges them into fewer, larger boxes. */
export const UI_FLASH_BOXES = 64;
/**
 * The flash record of a `prefab_save` on a linked document (`17`, piece 8): not a job's edit, so its
 * `job` is this reserved id, which no scope id takes (`"base"`, `"j<n>"`), and its colour is fixed.
 * A client from before draws it like any flash, in the colour the record carries.
 */
export const SAVE_FLASH_JOB = "save";
/** The save flash's fixed colour: white, which no job colour is (`jobColour` is saturated). */
export const SAVE_FLASH_COLOUR = "#ffffff";
/** Largest piece of a frame in one relay packet to a client (*Relay to the client*). */
export const UI_PART_BYTES = 1_000_000;

/** A job as the overlays draw it: its scope id, colour (`#rrggbb`), brief and volumes in world coordinates. */
export interface UiJob {
  id: string;
  colour: string;
  brief: string;
  dimension: string;
  work: WireBox;
  context: WireBox[];
}

/**
 * Boxes one job just changed, or a save's box (`job` {@link SAVE_FLASH_JOB}, colour
 * {@link SAVE_FLASH_COLOUR}; `17`, piece 8).
 */
export interface UiFlash {
  job: string;
  colour: string;
  dimension: string;
  boxes: WireBox[];
}

/** The open in-game request: the prompt's id, its mode and its text. */
export interface UiRequestInfo {
  id: number;
  mode: RequestMode;
  text: string;
}

/** Token totals of the current prompt (`13`, B3); `cost` in US dollars, absent when none was reported. */
export interface UiTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  cost?: number;
}

export interface UiRefusal {
  code: string;
  text: string;
}

/**
 * A rectangle or a line on block boundaries, in world corner coordinates `[x1, y1, z1, x2, y2, z2]`
 * (a block at x spans x to x + 1), each min ≤ max. A face has exactly one axis with min = max (its
 * plane); an edge has exactly two.
 */
export type UiSpan = [number, number, number, number, number, number];

/**
 * A steady fill (`18`, piece 8; `13`, *In-game UI*, Fill): faces drawn through blocks at a constant
 * alpha, beside job outlines and flash pulses, and edges drawn as lines. For the select candidate
 * (`id` {@link CANDIDATE_FILL}): `faces` the tinted shell of the sections the shape occupies, merged
 * into rectangles, and `edges` the boundary edges of each touched section's mask, merged into
 * segments. Which the client draws at which distance is the client's.
 */
export interface UiFill {
  /** {@link CANDIDATE_FILL} or a job's scope id; keyed like jobs (replace by id). */
  id: string;
  colour: string;
  /** Constant alpha of the faces, 1 to 255. */
  alpha: number;
  dimension: string;
  faces: UiSpan[];
  edges: UiSpan[];
}

/** The fill id of the select candidate (`18`, piece 8). Also the `job` of proposed hits' flash records. */
export const CANDIDATE_FILL = "candidate";
/** Most faces plus edges one fill record carries, so a `ui.state` stays far under `MAX_HEADER`; the MCP leaves edges out first. */
export const UI_FILL_SPANS = 16_384;

/**
 * Overlay and HUD state. Full: `jobs`, `request`, `tokens` and `refusal` are all given and replace
 * the client's state (`fills` too, absent meaning none). Changes: `jobs` and `fills` list added or
 * changed records whole (replace by id), `removed` and `fillsRemoved` the ended ones, and `request`,
 * `tokens`, `refusal` appear only when they changed (`null`: cleared).
 */
export interface UiState {
  type: "ui.state";
  players: string[];
  seq: number;
  full: boolean;
  jobs?: UiJob[];
  removed?: string[];
  request?: UiRequestInfo | null;
  tokens?: UiTokens | null;
  refusal?: UiRefusal | null;
  /** `18`, piece 8. Full: every fill, omitted when none. Changes: fills added or changed, whole (replace by id). */
  fills?: UiFill[];
  /** Changes only: ids of fills that ended. */
  fillsRemoved?: string[];
}

export interface UiFlashMessage {
  type: "ui.flash";
  players: string[];
  flashes: UiFlash[];
}

/** One whole 16³ section of a ghost's local grid: a palette index per position, x fastest, then z, then y. */
export interface UiGhostSection {
  /** Section coordinates in the ghost's local grid (local position >> 4). */
  section: Vec3;
  states: Uint32Array;
}

export interface UiGhost {
  type: "ui.ghost";
  players: string[];
  ghost: string;
  dimension: string;
  /** World position of the ghost's local [0, 0, 0]. */
  origin: Vec3;
  tint: string;
  /** True: these sections are the whole ghost. False: they replace those sections only. */
  full: boolean;
  palette: string[];
  /** Ascending by sy, then sz, then sx. */
  sections: UiGhostSection[];
}

export interface UiGhostClear {
  type: "ui.ghost.clear";
  players: string[];
  ghost: string;
}

export const REPLAY_MARKERS = ["fork", "merge", "refusal", "checkpoint"] as const;
export type ReplayMarkerKind = (typeof REPLAY_MARKERS)[number];

export interface ReplayMarker {
  step: number;
  kind: ReplayMarkerKind;
  label: string;
}

export interface ReplayHud {
  call: string;
  brief: string | null;
  note?: string;
}

interface ReplayFrameBase {
  type: "replay.frame";
  players: string[];
  replay: string;
  step: number;
  steps: number;
  dimension: string;
  /** ISO-8601 UTC. */
  time: string;
  hud: ReplayHud;
  jobs: UiJob[];
  flashes: UiFlash[];
}

/** A keyframe: every position of the replayed volume's boxes at `step`, states only. */
export interface ReplayKeyframe extends ReplayFrameBase {
  keyframe: true;
  palette: string[];
  regions: { box: WireBox; states: Uint32Array }[];
  markers: ReplayMarker[];
}

/** A forward delta: the positions that differ between `from` and `step`, with their state at `step`. */
export interface ReplayDelta extends ReplayFrameBase {
  keyframe: false;
  from: number;
  blocks: { pos: Vec3; state: string }[];
}

export type ReplayFrame = ReplayKeyframe | ReplayDelta;

/** `ui.request` kinds (*In-game UI*, *Request kinds*). The MCP answers any other kind with `bad_request`. */
export const UI_REQUEST_KINDS = [
  "resync",
  "settings.list",
  "settings.set",
  "settings.unset",
  "library.list",
  "library.entry",
  "library.thumbnail",
  "library.preview",
  "library.rename",
  "library.duplicate",
  "library.delete",
  "library.trash",
  "library.restore",
  "library.hide",
  "library.copy",
  "library.empty_trash",
  "logs.list",
  "replay.open",
  "replay.seek",
  "replay.close",
  "ghost.anchor",
  "ghost.clear",
  "candidates.open",
  "candidates.ghost",
  "candidates.ghost.clear",
  "candidates.submit",
  "library.write.prefab",
  "library.write.palette",
  "library.write.procedure",
  "library.write.knowledge",
  "choices.pick",
] as const;
export type UiRequestKind = (typeof UI_REQUEST_KINDS)[number];

/** A request from a player's client, numbered from the mod's UI counter (`request`), never by `id`. */
export interface UiRequest {
  type: "ui.request";
  request: number;
  player: PlayerRef;
  /** Kept as sent, so an unknown kind can be answered with `bad_request`. */
  kind: string;
  args: Record<string, unknown>;
}

export const UI_ERRORS = ["not_allowed", "conflict", "not_found", "bad_request", "busy", "internal", "answered"] as const;
export type UiError = (typeof UI_ERRORS)[number];

// ── Candidates (`17`, piece 3; `13`, *Request kinds*) ──────────────────────────────────────────

/** Most entries one `world_reply` offers as candidates (one sheet page, 6×4). */
export const CANDIDATES_MAX = 24;
/** The id of the session's one candidate ghost, the `ghost` a `candidates.ghost` answers. */
export const CANDIDATE_GHOST = "candidate";

/** One candidate in `candidates.open`'s result. `root` and `prefab` address it for `library.thumbnail` and `library.preview`. */
export interface CandidateEntry {
  cell: string;
  prefab: string;
  root: string;
  size: Vec3;
  tags: string[];
  notes: string | null;
}

/** `candidates.open`'s result: the list, the in-game request it answers (`null` once closed) and its question. */
export interface CandidatesOpenResult {
  id: string;
  request: number | null;
  question: string;
  entries: CandidateEntry[];
}

/** `candidates.ghost`'s arguments: `at` is the world position of the prefab's anchor (or its local origin). */
export interface CandidatesGhostArgs {
  id: string;
  prefab: string;
  dimension: string;
  at: Vec3;
  rotate?: 0 | 90 | 180 | 270;
}

/** One pick in `candidates.submit`. */
export interface CandidatePick {
  prefab: string;
  cell: string;
  label?: string;
}

export interface CandidatesSubmitArgs {
  id: string;
  picks: CandidatePick[];
  note?: string;
}

// ── Choices (`18`, piece 7; `13`, *Request kinds*) ─────────────────────────────────────────────

/** Most choices one question offers: a player without the client half answers by typing one digit. */
export const CHOICES_MAX = 9;

/**
 * `choices.pick`'s arguments: `id` the question's choices id (from the clicked line's `action`),
 * `index` the choice, 0-based. Answered `{request}` ({@link ChoicesPickResult}), `not_found` for an
 * unknown id or index, `answered` once a choice for that question was taken.
 */
export interface ChoicesPickArgs {
  id: string;
  index: number;
}

/** `choices.pick`'s result: the in-game request the answer went to as text, `null` when none. */
export interface ChoicesPickResult {
  request: number | null;
}

// ── Library editors (`17`, piece 6; `13`, *Request kinds*) ─────────────────────────────────────

/**
 * The editor write kinds, one per editable entry kind. Each carries the `hash` of the version the
 * editor started from (`library.entry`'s `hash`: sha256 of the editable file, or `"absent"` for a
 * prefab folder with no `prefab.json` yet) and is answered with the file's new `hash`, or `conflict`
 * when the file changed since.
 */
export const LIBRARY_WRITE_KINDS = ["library.write.prefab", "library.write.palette", "library.write.procedure", "library.write.knowledge"] as const;

/** `prefab.json` fields a prefab write may set; absent keys are left as they are, other fields of the file kept. */
export interface PrefabMetaEdit {
  name?: string;
  tags?: string[];
  /** `null` or `""` removes it. */
  front?: "north" | "south" | "east" | "west" | "" | null;
  /** `""` removes them. */
  notes?: string;
  anchors?: Record<string, Vec3>;
  /** Role name → block ids. */
  roles?: Record<string, string[]>;
}

export interface LibraryWritePrefabArgs {
  root: string;
  name: string;
  hash: string;
  meta: PrefabMetaEdit;
}

/** The `palette_edit` operations the in-game editor offers (`03`): no cell refs, since there is no sheet in game. */
export interface PaletteMemberEdit {
  /** Role → block or family id → new relative weight. */
  weights?: Record<string, Record<string, number>>;
  /** Role → block or family ids to remove. */
  remove?: Record<string, string[]>;
  /** Roles to delete. */
  drop?: string[];
  /** Role renames, old → new. */
  rename?: Record<string, string>;
}

export interface LibraryWritePaletteArgs {
  root: string;
  name: string;
  hash: string;
  tags?: string[];
  /** `""` removes them. */
  notes?: string;
  edit?: PaletteMemberEdit;
  /** Role → block ids added at an even share (the role is created when new). */
  addBlocks?: Record<string, string[]>;
}

/** A procedure's or knowledge pack's (kits included) whole new text. */
export interface LibraryWriteTextArgs {
  root: string;
  name: string;
  hash: string;
  text: string;
}

/** What every write answers; `warnings` only for palettes (members not added, unknown ids). */
export interface LibraryWriteResult {
  hash: string;
  warnings?: string[];
}

/** The answer to a `ui.request`. `body` only for `library.thumbnail` (PNG) and `library.preview` (a region body). */
export type UiResult =
  | { type: "ui.result"; request: number; player: string; ok: true; result: Record<string, unknown>; body?: Uint8Array }
  | { type: "ui.result"; request: number; player: string; ok: false; error: UiError; message: string };

/** Every message the MCP sends only when both hellos list `ui`. */
export type UiMcpMessage = UiState | UiFlashMessage | UiGhost | UiGhostClear | ReplayFrame | UiResult;
export const UI_MCP_TYPES: readonly UiMcpMessage["type"][] = ["ui.state", "ui.flash", "ui.ghost", "ui.ghost.clear", "replay.frame", "ui.result"];

/** Whether both hellos list `ui`: the only case in which either side sends a `ui` message. */
export function uiEnabled(mcp: Pick<ClientHello, "features"> | undefined, mod: ModHello | undefined): boolean {
  return mcpHas(mcp, "ui") && modHas(mod, "ui");
}

/** Messages the MCP sends. */
export type McpMessage =
  | ClientHello
  | ErrorMessage
  | VolumesExtend
  | VolumesSet
  | HashesRequest
  | SnapshotRequest
  | SurfaceRequest
  | MaskSnapshotRequest
  | CoarseSnapshotRequest
  | SearchRequest
  | FillRequest
  | ExpandRequest
  | PatchMessage
  | RegistryRequest
  | UpgradeRequest
  | PromptResult
  | NoticeMessage
  | ChatMessage
  | UiMcpMessage;
/** Messages the mod sends. */
export type ModMessage =
  | ModHello
  | ErrorMessage
  | VolumesMessage
  | HashesResult
  | SnapshotResult
  | SurfaceResult
  | CoarseResult
  | SearchResult
  | FillResult
  | PatchAck
  | DirtyMessage
  | PromptMessage
  | PromptClose
  | RegistryResult
  | UpgradeResult
  | UiRequest;

export type Message = McpMessage | ModMessage;
export type Sender = "mcp" | "mod";

/** Whether the mod's hello lists a feature (*Versions and features*: features gate on hellos, never on protocol numbers). */
export function modHas(hello: ModHello | undefined, feature: ModFeature): boolean {
  return hello?.features?.includes(feature) ?? false;
}

/** Whether the MCP's hello lists a feature (the mod's side of the same rule). */
export function mcpHas(hello: Pick<ClientHello, "features"> | undefined, feature: McpFeature): boolean {
  return hello?.features?.includes(feature) ?? false;
}

/** The modes an MCP hello lists; absent means `build` only. */
export function helloModes(hello: Pick<ClientHello, "modes">): readonly RequestMode[] {
  return hello.modes ?? ["build"];
}
