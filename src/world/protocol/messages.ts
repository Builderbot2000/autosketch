import type { Compound } from "prismarine-nbt";
import type { Vec3 } from "../../core/region.js";

/**
 * Message shapes of the bridge protocol (docs/design/13-live-world.md, *Wire format*, *Messages*).
 * Positions and boxes are world coordinates; boxes are inclusive (`01`). Body-bearing messages
 * (patch, snapshot.result, patch.ack, dirty) carry their decoded body here; the header fields that
 * only describe the encoding (origin, size, counts) are produced and checked by the codec.
 */

/** The protocol version this side speaks natively (`N`). */
export const PROTOCOL_VERSION = 3;
/**
 * Every version the MCP speaks: its own and the one before (`N`, `N−1`; `14`, *Version skew between
 * mod and MCP*). Everything version 3 adds is optional on the wire, so one codec reads both.
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

/** Inclusive area of block columns, `[x, z]` world coordinates (`snapshot` kind `surface`, the scan grant). */
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

export const ERROR_CODES = ["protocol_mismatch", "bad_token", "not_ready", "bad_request", "unknown_type", "no_volumes", "wrong_dimension", "outside_volumes", "too_large", "replaced", "stale_link", "bad_extension", "bad_volumes", "internal"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const PROMPT_REFUSALS = ["no_link", "not_allowed", "no_listener", "unsupported_mode"] as const;
export type PromptRefusal = (typeof PROMPT_REFUSALS)[number];

/** Request modes, named by the player's subcommand (`13`, B6). */
export const REQUEST_MODES = ["ask", "scan", "plan", "build"] as const;
export type RequestMode = (typeof REQUEST_MODES)[number];

/**
 * Optional capabilities a mod's `hello` lists in `features` (*Versions and features*). The MCP uses
 * an addition only when the mod lists it, never because of the protocol number.
 */
export const MOD_FEATURES = ["modes", "scan", "volumes.set", "registry", "upgrade"] as const;
export type ModFeature = (typeof MOD_FEATURES)[number];

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

/** What a `scan` request lets the MCP read (`13`, B4): the mod sizes it from its config. */
export interface ScanGrant {
  /** Radius in chunks around the player's chunk, after clipping to the mod's maximum. */
  radius: number;
  /** The player asked for a larger radius. */
  clipped?: boolean;
  /** Block columns of the chunks within the radius: readable as a surface snapshot. */
  columns: WireArea;
  /** The full-block box around the player: readable as a blocks snapshot. */
  box: WireBox;
}

export interface PromptMessage {
  type: "prompt";
  id: number;
  player: PlayerRef;
  text: string;
  context: GameContext;
  /** The player's subcommand (B6); absent (a mod without the `modes` feature) means `build`. */
  mode?: RequestMode;
  /** Only with mode `scan`. */
  scan?: ScanGrant;
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
}

/** Messages the MCP sends. */
export type McpMessage = ClientHello | ErrorMessage | VolumesExtend | VolumesSet | HashesRequest | SnapshotRequest | SurfaceRequest | PatchMessage | RegistryRequest | UpgradeRequest | PromptResult | NoticeMessage | ChatMessage;
/** Messages the mod sends. */
export type ModMessage = ModHello | ErrorMessage | VolumesMessage | HashesResult | SnapshotResult | SurfaceResult | PatchAck | DirtyMessage | PromptMessage | RegistryResult | UpgradeResult;
export type Message = McpMessage | ModMessage;
export type Sender = "mcp" | "mod";

/** Whether the mod's hello lists a feature (*Versions and features*: features gate on hellos, never on protocol numbers). */
export function modHas(hello: ModHello | undefined, feature: ModFeature): boolean {
  return hello?.features?.includes(feature) ?? false;
}

/** The modes an MCP hello lists; absent means `build` only. */
export function helloModes(hello: Pick<ClientHello, "modes">): readonly RequestMode[] {
  return hello.modes ?? ["build"];
}
