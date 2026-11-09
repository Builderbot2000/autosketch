import type { Vec3 } from "../core/region.js";
import type { Document, EditResult } from "../document/document.js";
import type { PaletteBook } from "../palette/pick.js";
import type { AutosketchPlugin } from "../plugins/types.js";
import type { BridgeConnection } from "./bridge.js";
import type { VolatileList, WireBox, WorldBlock } from "./protocol/messages.js";

/**
 * The world link (docs/design/13-live-world.md, *Model*; briefs/world, *Link object*): the session's
 * connection between its base document, the root scope, and the player's work and context volumes
 * in the loaded world. One per session, on `Session.world`.
 *
 * Coordinates: `volumes` are world coordinates (inclusive boxes, as on the wire); the document is
 * re-origined so the player's work volume's minimum corner is local (0,0,0), and
 * world = local + `volumes.origin` (`toWorld`, `toLocal`).
 */

/**
 * - `disconnected`: no bridge connection (the game isn't running, or the link is reconnecting).
 * - `connecting`: connecting or in the handshake.
 * - `connected`: the bridge is up but no document is linked (no work volume set in-game, or the
 *   base document hasn't been opened with `world: true`).
 * - `linked`: the base document holds the player's volumes and its journal entries become patches.
 */
export type LinkState = "disconnected" | "connecting" | "connected" | "linked";

/** The volumes a linked document holds, in world coordinates. */
export interface LinkVolumes {
  /** The mod's link generation (`volumes.link`); every patch carries it. */
  link: number;
  dimension: string;
  /** The player's work volume. */
  work: WireBox;
  /**
   * The work volume the agent may write: `work` extended to whole blocks (`13`, *Model*), declared
   * to the mod with `volumes.extend`. Equals `work` when the box cuts no multi-block.
   */
  extended: WireBox;
  /** The effective context boxes (default: the work volume grown by 3). */
  context: WireBox[];
  /** World position of document-local (0,0,0): `work.min`. */
  origin: Vec3;
}

/** Changes the mod reported (`dirty`) since the cache last synced, in world coordinates. */
export interface DirtyState {
  /** True after a `dirty` with `everything`: compare section hashes. */
  everything: boolean;
  /** Listed positions with the state and NBT the world held, latest notice last; empty when `everything`. */
  blocks: WorldBlock[];
}

/** Why a sync runs, for the sync implementation to pick its form (silo Q). */
export type SyncReason = "dirty" | "reconnect" | "manual";

/**
 * Brings the cache up to date with the world (silo Q's `src/world/sync.ts`): partial from
 * `takeDirty()` blocks when they are listed, section-hash comparison otherwise. Returns the
 * `world_sync` entry's result, or undefined when nothing changed.
 */
export type SyncFn = (link: WorldLink, reason: SyncReason) => Promise<EditResult | undefined>;

export interface WorldLink {
  readonly state: LinkState;
  /** The linked base document, while `state` is `linked`. */
  readonly doc: Document | undefined;
  /** The volumes the document holds, while `state` is `linked`. */
  readonly volumes: LinkVolumes | undefined;
  /** The connection to the mod; requests reject with `world_disconnected` while it is down. */
  readonly bridge: BridgeConnection;
  /** The volatile-key list sent in `hello` (L's default plus plugin entries); hash with it. */
  readonly volatile: VolatileList;
  /** Whether the mod reported changes since the last sync. */
  isDirty(): boolean;
  /** Returns the accumulated dirty notices and clears them (a sync calls it as it starts). */
  takeDirty(): DirtyState | undefined;
  /** Runs the installed `SyncFn`; resolves undefined when none is installed or nothing is linked. */
  syncNow(reason?: SyncReason): Promise<EditResult | undefined>;
  /** Installs the sync implementation (silo Q). */
  setSync(fn: SyncFn): void;
  /** World position of a document-local position (linked only). */
  toWorld(p: Vec3): Vec3;
  /** Document-local position of a world position (linked only). */
  toLocal(p: Vec3): Vec3;
  /**
   * Links the session's base document to the player's volumes (`doc_open({ world: true })`, W2):
   * connects if needed, snapshots the volumes into a new document and makes it current. Resolves
   * with the document and a short report for the tool result. Optional so test doubles needn't
   * implement it.
   */
  open?(opts: LinkOpenOptions): Promise<{ doc: Document; report: string }>;
}

export interface LinkOpenOptions {
  /** Workspace document name (default "world"). */
  name?: string;
  /** Replace an existing workspace document of that name that isn't a linked one. */
  overwrite?: boolean;
  /** The located instance folder (`02`); the pairing file is in it or its game subfolder. */
  instanceDir: string;
  plugins: readonly AutosketchPlugin[];
  palettes: PaletteBook;
}
