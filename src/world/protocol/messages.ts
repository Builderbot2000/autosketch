import type { Compound } from "prismarine-nbt";
import type { Vec3 } from "../../core/region.js";

/**
 * Message shapes of the bridge protocol (docs/design/13-live-world.md, *Wire format*, *Messages*).
 * Positions and boxes are world coordinates; boxes are inclusive (`01`). Body-bearing messages
 * (patch, snapshot.result, patch.ack, dirty) carry their decoded body here; the header fields that
 * only describe the encoding (origin, size, counts) are produced and checked by the codec.
 */

export const PROTOCOL_VERSION = 1;
/** Largest frame length value (bytes after the 4-byte length prefix). */
export const MAX_FRAME = 256 * 1024 * 1024;
/** Largest JSON header. */
export const MAX_HEADER = 1024 * 1024;
/** Most positions one `dirty` notice lists; more changes in one tick send `everything`. */
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

export const ERROR_CODES = ["protocol_mismatch", "bad_token", "not_ready", "bad_request", "unknown_type", "no_volumes", "wrong_dimension", "outside_volumes", "too_large", "replaced"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const PROMPT_REFUSALS = ["no_link", "not_allowed", "no_listener"] as const;
export type PromptRefusal = (typeof PROMPT_REFUSALS)[number];

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
}

export interface ModHello {
  type: "hello";
  protocol: number;
  mod: { version: string };
  game: { version: string; dataVersion: number; loader: string; loaderVersion: string };
  singleplayer: boolean;
  host: PlayerRef | null;
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
  | { type: "volumes"; link: number; dimension: string; work: WireBox; context: WireBox[] }
  | { type: "volumes"; link: number; work: null };

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

export interface PromptMessage {
  type: "prompt";
  id: number;
  player: PlayerRef;
  text: string;
  context: GameContext;
}

export type PromptResult = { type: "prompt.result"; id: number; delivered: true } | { type: "prompt.result"; id: number; delivered: false; reason: PromptRefusal };

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
export type McpMessage = ClientHello | ErrorMessage | HashesRequest | SnapshotRequest | PatchMessage | PromptResult | NoticeMessage | ChatMessage;
/** Messages the mod sends. */
export type ModMessage = ModHello | ErrorMessage | VolumesMessage | HashesResult | SnapshotResult | PatchAck | DirtyMessage | PromptMessage;
export type Message = McpMessage | ModMessage;
export type Sender = "mcp" | "mod";
