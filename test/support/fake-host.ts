import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Compound } from "prismarine-nbt";
import type { Vec3 } from "../../src/core/region.js";
import { renameState } from "../../src/formats/renames.js";
import { decodeMessage, encodeMessage, ProtocolError, splitFrame } from "../../src/world/protocol/codec.js";
import { FrameReader } from "../../src/world/protocol/frame.js";
import { isStateOnly, nbtHash, sectionHashes } from "../../src/world/protocol/hash.js";
import {
  DIRTY_CAP,
  helloModes,
  HELLO_TIMEOUT_MS,
  MOD_FEATURES,
  PROTOCOL_VERSION,
  CANVAS_CHUNKS,
  type CanvasSet,
  type ChatMessage,
  type ErrorCode,
  type GameContext,
  type McpMessage,
  type ModHello,
  type ModMessage,
  type NoticeMessage,
  type PatchAck,
  type PatchMessage,
  type PlayerRef,
  type PromptResult,
  type RequestControl,
  type RequestControlAction,
  type RequestMode,
  type StatusMessage,
  type UpgradeData,
  type UpgradeRequest,
  type SnapshotRequest,
  type SurfaceLayer,
  type SurfaceRequest,
  type VolatileList,
  type VolumesSet,
  type WireBox,
  type WorldBlock,
  type UiMcpMessage,
  type UiResult,
  UI_MCP_TYPES,
} from "../../src/world/protocol/messages.js";
import { removePairing, writePairing } from "../../src/world/protocol/pairing.js";
import { isCanonicalForm } from "../../src/world/protocol/state.js";
import { boxVolume, maskRegions } from "../../src/world/protocol/body.js";
import { MASK_MARGIN, SEARCH_STOP, SELECT_CHUNKS, type CoarseSnapshotRequest, type ExpandRequest, type FillRequest, type MaskSnapshotRequest, type SearchRequest } from "../../src/world/protocol/messages.js";
import { coarseRegion, grantHasBox, grantHasChunk, missingIn, newSearch, WorldFill, type SearchWalk, type SelectGrant } from "./fake-select.js";

/**
 * A fake in-game host (docs/design/13-live-world.md, W9): an in-memory world plus the mod's side
 * of the bridge protocol (*Wire format*), so the MCP's link, sync, barrier, merge and reconnect
 * paths can be unit-tested without a running game. It follows the mod's rules exactly: handshake
 * checks, per-block compare-and-set with NBT hashes, skip and report, unknown-state rejection,
 * the normalized list, `dirty` notices for tracked changes inside the volumes, section hashes and
 * snapshots. What it doesn't model: the tick budget (patches apply at once, in order), chunk
 * loading, and side effects of writes.
 *
 * It speaks any protocol version (`protocol`, default the current one), listing the features of
 * that version unless `features` says otherwise (*Versions and features*): a version-1 host lists
 * none and sends no `mode`, a version-2 host lacks `registry` and `upgrade`, and each answers later
 * requests as that version's mod would. Its registry report is `registryReport`; its data fixer is
 * the MCP's own rename table over states (NBT passes through), or `upgrade`.
 *
 * Select (`18`; feature `select`): a `select` prompt grants block reads within `selectChunks` of the
 * player's chunk (`selectGrant`); `search`, `fill`, `expand` and the `mask` and `coarse` snapshots are
 * answered from the in-memory world by `fake-select.ts` (the fill as `{connected}` does it; the search
 * treats every non-empty section as a `maybeHas` yes). `missingChunks` are ungenerated there too.
 *
 * In-game UI (`ui`, `13`, *In-game UI*): the host stands for the mod's relay and every player's
 * client at once. It records each `ui.*` and `replay.*` message in `ui` (`uiFor` filters by player),
 * and `playerUiRequest` sends a player's `ui.request` and resolves with its `ui.result`. Like the mod,
 * it does neither unless both hellos list `ui`, and keeps what arrives regardless in `uiUngated`.
 *
 * Request control (`requests`, `19` Part A): status lines are recorded in `statuses` (`statusOf`
 * gives a request's latest), `playerControl` runs `/autosketch stop`, `queue` or `queue cancel <n>`
 * as `request.control` and resolves with the MCP's answer, and `playerClickStatus` clicks a status
 * line's button (its `ui.request`). Neither is sent unless both hellos list `requests`; status lines
 * that arrive regardless go to `requestsUngated`.
 *
 * Canvas (`canvas`, `19` Part B): the host holds one canvas (`canvas`, set by `setCanvas` as the
 * player would, or by the MCP's `canvas.set`), widened to whole chunk columns and the build height,
 * at most `canvasChunks` across. It sends `canvas` after the hello and on every change when both
 * hellos list `canvas`, and serves inside the canvas, in every mode, what it serves inside the
 * select grant: blocks, mask, coarse and surface snapshots, `search`, `fill` and `expand`.
 */

export interface Volumes {
  work: WireBox;
  /** Effective context boxes; default: the work volume grown by 3. */
  context?: WireBox[];
  dimension?: string;
}

export interface FakeHostOptions {
  /** Instance folder for the pairing file; a temporary folder (removed by `close`) by default. */
  instanceDir?: string;
  /** Initial volumes; none by default. */
  volumes?: Volumes | null;
  /** States the game knows; `null` (default) knows every canonical state. */
  knownStates?: Set<string> | null;
  singleplayer?: boolean;
  host?: PlayerRef | null;
  game?: Partial<ModHello["game"]>;
  /** Protocol version the host speaks (to test mismatches and `N−1`). */
  protocol?: number;
  /** Features the hello lists; default those of the host's protocol version (none, omitted, for version 1). */
  features?: string[];
  /** The registry report (format 1 JSON) the host serves for `registry`; default a small vanilla one. */
  registryReport?: object;
  /** The data fixer for `upgrade`; default the rename table over states and structure palettes, NBT unchanged. */
  upgrade?: (m: UpgradeRequest, to: number) => UpgradeData & { failed?: number };
  /** The mod's `contextCap` (blocks), for `volumes.set`; default 4,194,304. */
  contextCap?: number;
  /** `selectChunks` (`18`): the select grant's radius and the search radius cap; default 256. */
  selectChunks?: number;
  /** Block tags (`ns:path` → block ids) for `#tag` materials in search and fill; unknown tags match nothing. */
  tags?: Record<string, string[]>;
  /** Chunks `"cx,cz"` that aren't generated: surface snapshots, searches, fills and select reads list them as missing. */
  missingChunks?: Set<string>;
  /** False makes the host a misbehaving mod that sends modes the MCP's hello didn't list (to test the MCP-side gate). Default true. */
  enforceModes?: boolean;
  /** Positions one dirty notice may list (default `DIRTY_CAP`). */
  dirtyCap?: number;
  /** `canvasChunks` (`19`): the most chunks a canvas spans on either horizontal axis; default 256. */
  canvasChunks?: number;
  /** The initial canvas (any box: widened to whole chunk columns and the build height); none by default. */
  canvas?: { box: WireBox; dimension?: string } | null;
  /** Handshake timeout in ms (default `HELLO_TIMEOUT_MS`). */
  helloTimeoutMs?: number;
  /** How the game rewrites block-entity NBT when loading it (default: unchanged). */
  normalizeNbt?: (pos: Vec3, state: string, nbt: Compound | undefined) => Compound | undefined;
  /** Whether a block accepts the given NBT (default: any compound with a string `id`). */
  acceptsNbt?: (state: string, nbt: Compound) => boolean;
}

/** What `playerAsk` resolves with: the MCP's `prompt.result`, or the mod's own refusal (`no_link`, `unsupported_mode`) when nothing was sent. */
export type AskResult = PromptResult & { local?: true };

export interface PatchLogEntry {
  patch: PatchMessage;
  ack: PatchAck;
}

interface Cell {
  state: string;
  nbt?: Compound;
}

const AIR = "minecraft:air";
/** The overworld's build height in 1.21.1. */
const BUILD_MIN_Y = -64;
const BUILD_MAX_Y = 319;
const key = (p: Vec3) => `${p[0]},${p[1]},${p[2]}`;

function inBox(b: WireBox, p: Vec3): boolean {
  return p[0] >= b.min[0] && p[0] <= b.max[0] && p[1] >= b.min[1] && p[1] <= b.max[1] && p[2] >= b.min[2] && p[2] <= b.max[2];
}

function grow(b: WireBox, n: number): WireBox {
  return { min: [b.min[0] - n, b.min[1] - n, b.min[2] - n], max: [b.max[0] + n, b.max[1] + n, b.max[2] + n] };
}

const sameBox = (a: WireBox, b: WireBox) => key(a.min) === key(b.min) && key(a.max) === key(b.max);

export class FakeHost {
  readonly world = new Map<string, Cell>();
  knownStates: Set<string> | null;
  /** The volatile-key list from the MCP's last hello. */
  volatile: VolatileList = {};
  /** Every patch with the ack the host sent for it. */
  readonly patchLog: PatchLogEntry[] = [];
  /** Every message received from the MCP after a successful handshake, and every hello. */
  readonly received: McpMessage[] = [];
  /** Every message sent to the MCP. */
  readonly sent: ModMessage[] = [];
  readonly chats: ChatMessage[] = [];
  /** Every `ui.*` and `replay.*` message received (`13`, *In-game UI*), in order. */
  readonly ui: UiMcpMessage[] = [];
  /** `ui` messages that arrived although the two hellos don't both list `ui` (an MCP breaking the gate). */
  readonly uiUngated: UiMcpMessage[] = [];
  readonly notices: NoticeMessage[] = [];
  /** Every `chat` kind `status` received while both hellos list `requests`, in order (`19`, *Status line*). */
  readonly statuses: StatusMessage[] = [];
  /** Status lines that arrived although the two hellos don't both list `requests`. */
  readonly requestsUngated: StatusMessage[] = [];
  /** The canvas (`19`), whole chunk columns and the build height; null when none is set. */
  canvas: { box: WireBox; dimension: string } | null = null;
  /** The modes the MCP's last hello listed. */
  mcpModes: readonly RequestMode[] = [];
  /** The features the MCP's last hello listed (absent: none). */
  mcpFeatures: readonly string[] = [];
  /** The read grant of the last select request, while it lasts (`13`, *Read grants in select mode*). */
  selectGrant: SelectGrant | null = null;
  /** The select grant's search, resumable with `continue`, and its current fill. */
  private searchWalk: SearchWalk | null = null;
  private worldFill: WorldFill | null = null;
  /** Called before a patch is applied; may return a promise to hold it (later requests wait, as in the mod). */
  beforePatch?: (patch: PatchMessage) => void | Promise<void>;
  /** Patch ids answered `dropped` after a `patch.drop` (`19`, *Stop*), in order. */
  readonly droppedPatches: number[] = [];
  /** The newest patch id received, and the newest a `patch.drop` covers (patches up to it not yet started are dropped). */
  private lastPatchId = 0;
  private dropUpTo = 0;
  port = 0;
  token = "";
  link = 1;
  connections = 0;

  private server?: Server;
  private socket?: Socket;
  private volumes: (Volumes & { context: WireBox[]; dimension: string }) | null = null;
  /** The MCP-declared extended work volume for the current link (`volumes.extend`). */
  extended: WireBox | null = null;
  private queue: Promise<void> = Promise.resolve();
  private promptId = 0;
  private readonly noticeWaiters: { player: string; resolve: (n: NoticeMessage) => void }[] = [];
  private readonly controlWaiters: { player: string; resolve: (m: NoticeMessage | ChatMessage) => void }[] = [];
  private readonly prompts = new Map<number, (r: PromptResult) => void>();
  private uiRequestId = 0;
  private readonly uiRequests = new Map<number, (r: UiResult) => void>();
  private ownsDir = false;

  private constructor(
    readonly instanceDir: string,
    private readonly opts: FakeHostOptions,
  ) {
    this.knownStates = opts.knownStates ?? null;
    if (opts.volumes) this.volumes = this.normalize(opts.volumes);
    if (opts.canvas) this.canvas = { box: widenToColumns(opts.canvas.box), dimension: opts.canvas.dimension ?? "minecraft:overworld" };
  }

  static async start(opts: FakeHostOptions = {}): Promise<FakeHost> {
    const dir = opts.instanceDir ?? (await mkdtemp(join(tmpdir(), "autosketch-fake-host-")));
    const host = new FakeHost(dir, opts);
    host.ownsDir = !opts.instanceDir;
    await host.listen();
    return host;
  }

  get connected(): boolean {
    return this.socket !== undefined;
  }

  get dimension(): string | undefined {
    return this.volumes?.dimension;
  }

  get protocol(): number {
    return this.opts.protocol ?? PROTOCOL_VERSION;
  }

  /** The features the hello lists (undefined: the key is omitted, as a version-1 mod does). */
  get features(): string[] | undefined {
    return this.opts.features ?? FEATURES_BY_VERSION[Math.min(this.protocol, PROTOCOL_VERSION)];
  }

  /** The registry report as the mod writes it: gzip of the JSON, and the hash over the JSON. */
  get registryFile(): { gzip: Uint8Array; hash: string } {
    const json = Buffer.from(JSON.stringify(this.opts.registryReport ?? DEFAULT_REPORT), "utf8");
    return { gzip: new Uint8Array(gzipSync(json)), hash: createHash("sha256").update(json).digest("hex").slice(0, 16) };
  }

  has(feature: string): boolean {
    return this.features?.includes(feature) ?? false;
  }

  /** The current volumes, as the host holds them. */
  get currentVolumes(): { work: WireBox; context: WireBox[]; dimension: string } | null {
    return this.volumes && { work: this.volumes.work, context: this.volumes.context, dimension: this.volumes.dimension };
  }

  // ── world access ───────────────────────────────────────────────────────────────────────────

  get(pos: Vec3): WorldBlock {
    if (pos[1] < BUILD_MIN_Y || pos[1] > BUILD_MAX_Y) return { pos, state: AIR }; // outside build height: air, as in the mod
    const c = this.world.get(key(pos));
    return c ? { pos, state: c.state, ...(c.nbt ? { nbt: c.nbt } : {}) } : { pos, state: AIR };
  }

  /** Sets a block silently (test setup: no dirty notice). */
  set(pos: Vec3, state: string, nbt?: Compound): void {
    if (state === AIR && !nbt) this.world.delete(key(pos));
    else this.world.set(key(pos), nbt ? { state, nbt } : { state });
  }

  /** A player places or breaks a block: the world changes and, inside the volumes, a dirty notice goes out. */
  playerSet(pos: Vec3, state: string, nbt?: Compound): void {
    this.playerSetMany([{ pos, state, ...(nbt ? { nbt } : {}) }]);
  }

  /** Several changes in one tick: one dirty notice, or `everything` past the cap. */
  playerSetMany(blocks: WorldBlock[]): void {
    for (const b of blocks) this.set(b.pos, b.state, b.nbt);
    const tracked = blocks.filter((b) => this.inVolumes(b.pos));
    if (!tracked.length || !this.connected) return;
    const latest = new Map(tracked.map((b) => [key(b.pos), b.pos]));
    if (latest.size > (this.opts.dirtyCap ?? DIRTY_CAP)) this.send({ type: "dirty", everything: true });
    else this.send({ type: "dirty", everything: false, blocks: [...latest.values()].map((p) => this.get(p)) });
  }

  /** A contents-only change (a chest's items): the state is unchanged, so no dirty notice, as in the mod. */
  playerSetNbt(pos: Vec3, nbt: Compound): void {
    this.set(pos, this.get(pos).state, nbt);
  }

  /** A block entity ticks: the given keys (normally volatile ones) are merged into its NBT; no dirty notice. */
  tick(pos: Vec3, changes: Compound): void {
    const cur = this.get(pos);
    this.set(pos, cur.state, { type: "compound", value: { ...(cur.nbt?.value ?? {}), ...changes.value } });
  }

  /** The tracker lost count (an explosion, a big Axiom edit): sends `dirty` with `everything`. */
  markEverythingDirty(): void {
    if (this.connected) this.send({ type: "dirty", everything: true });
  }

  /** Sets the volumes (null clears the work volume) and sends `volumes`. A new work volume or dimension changes the link. */
  setVolumes(v: Volumes | null): void {
    const next = v ? this.normalize(v) : null;
    const prev = this.volumes;
    if (!next || !prev || next.dimension !== prev.dimension || !sameBox(next.work, prev.work)) {
      this.link++;
      this.extended = null;
    }
    this.volumes = next;
    if (this.connected) this.sendVolumes();
  }

  /**
   * A player asks the agent from the game. Resolves with the MCP's `prompt.result`, or with the
   * mod's own refusal when nothing is sent: `no_link` when nobody is connected, `unsupported_mode`
   * when the MCP's hello didn't list the mode (B6). `mode` (default `build`) is the subcommand; a
   * host without the `modes` feature sends no mode.
   */
  playerAsk(player: PlayerRef, text: string, context: Partial<GameContext> = {}, opts: { mode?: RequestMode } = {}): Promise<AskResult> {
    const id = ++this.promptId;
    if (!this.connected) return Promise.resolve({ type: "prompt.result", id, delivered: false, reason: "no_link", local: true });
    const ctx: GameContext = { dimension: this.volumes?.dimension ?? "minecraft:overworld", position: [0.5, 64, 0.5], eye: [0.5, 65.62, 0.5], yaw: 0, pitch: 0, facing: "south", ...context };
    const modes = this.has("modes");
    const mode = opts.mode ?? "build";
    if (modes && this.opts.enforceModes !== false && !this.mcpModes.includes(mode)) return Promise.resolve({ type: "prompt.result", id, delivered: false, reason: "unsupported_mode", local: true });
    if (mode === "select" && !this.has("select")) throw new Error("fake host: a mod without the select feature has no select subcommand");
    if (modes && mode === "select") {
      this.setSelectGrant({ dimension: ctx.dimension, centre: [Math.floor(ctx.position[0]) >> 4, Math.floor(ctx.position[2]) >> 4], radius: this.opts.selectChunks ?? SELECT_CHUNKS });
    }
    return new Promise((resolve) => {
      this.prompts.set(id, resolve);
      this.send({ type: "prompt", id, player, text, context: ctx, ...(modes ? { mode } : {}) });
    });
  }

  /**
   * A player runs `/autosketch done` (B6): ends the open read-only request. Sent as `prompt.close`
   * only when the MCP's hello lists the `prompt.close` feature; otherwise the mod refuses it itself
   * (`mcp_outdated`, on the action bar), and with no connection it says `no_link`. When sent,
   * resolves with the MCP's answer: the next `notice` to that player.
   */
  playerDone(player: PlayerRef): Promise<{ local: "no_link" | "mcp_outdated" } | NoticeMessage> {
    if (!this.connected) return Promise.resolve({ local: "no_link" });
    if (!this.mcpFeatures.includes("prompt.close")) return Promise.resolve({ local: "mcp_outdated" });
    return new Promise((resolve) => {
      this.noticeWaiters.push({ player: player.uuid, resolve });
      this.send({ type: "prompt.close", player });
    });
  }

  /** Whether both hellos list `ui` (*Versions and features*): only then does a mod relay `ui` messages or send `ui.request`. */
  get uiEnabled(): boolean {
    return this.connected && this.has("ui") && this.mcpFeatures.includes("ui");
  }

  /**
   * A player's client sends a `ui.request` (`13`, *In-game UI*); resolves with the MCP's `ui.result`.
   * As in the mod, nothing is sent without a connection (`no_link`) or unless both hellos list `ui`
   * (`mcp_outdated`; the client half locks the UI with the too-old line).
   */
  playerUiRequest(player: PlayerRef, request: { kind: string; args?: Record<string, unknown> }): Promise<UiResult | { local: "no_link" | "mcp_outdated" }> {
    if (!this.connected) return Promise.resolve({ local: "no_link" });
    if (!this.uiEnabled) return Promise.resolve({ local: "mcp_outdated" });
    const id = ++this.uiRequestId;
    return new Promise((resolve) => {
      this.uiRequests.set(id, resolve);
      this.send({ type: "ui.request", request: id, player, kind: request.kind, args: request.args ?? {} });
    });
  }

  /**
   * The player clicks a reply's clickable line (`13`, `chat`, `action`; `17` piece 3): their client
   * sends the action's `ui.request`. Throws when the chat has no action, as a plain line does nothing.
   */
  playerClick(player: PlayerRef, chat: ChatMessage): ReturnType<FakeHost["playerUiRequest"]> {
    if (!chat.action) throw new Error("fake host: this chat has no clickable line");
    return this.playerUiRequest(player, { kind: chat.action.kind, args: chat.action.args });
  }

  // ── request control (`19`, Part A) ─────────────────────────────────────────────────────────

  /** Whether both hellos list `requests`: only then do status lines and `request.control` travel. */
  get requestsEnabled(): boolean {
    return this.connected && this.has("requests") && this.mcpFeatures.includes("requests");
  }

  /** The latest status line of a request, if any arrived. */
  statusOf(request: number): StatusMessage | undefined {
    return this.statuses.findLast((m) => m.request === request);
  }

  /**
   * A player runs `/autosketch stop`, `queue` or `queue cancel <position>` (`19`): sent as
   * `request.control` when both hellos list `requests`, resolving with the MCP's answer (the next
   * `notice`, or for `queue` the next `chat` reply, to that player). Without a connection the mod
   * says `no_link` itself, and to an MCP whose hello doesn't list `requests`, `mcp_outdated`.
   */
  playerControl(player: PlayerRef, action: RequestControlAction, position?: number): Promise<NoticeMessage | ChatMessage | { local: "no_link" | "mcp_outdated" }> {
    if (!this.connected) return Promise.resolve({ local: "no_link" });
    if (!this.mcpFeatures.includes("requests")) return Promise.resolve({ local: "mcp_outdated" });
    const m: RequestControl = { type: "request.control", player, action, ...(position !== undefined ? { position } : {}) };
    return new Promise((resolve) => {
      this.controlWaiters.push({ player: player.uuid, resolve });
      this.send(m);
    });
  }

  /** The player clicks button `index` of a status line: their client sends its `ui.request`. */
  playerClickStatus(player: PlayerRef, status: StatusMessage, index: number): ReturnType<FakeHost["playerUiRequest"]> {
    const a = status.actions[index];
    if (!a) throw new Error(`fake host: this status line has no button ${index}`);
    return this.playerUiRequest(player, { kind: a.kind, args: a.args });
  }

  // ── canvas (`19`, Part B) ──────────────────────────────────────────────────────────────────

  /** Whether both hellos list `canvas`: only then does the host send `canvas`. */
  get canvasEnabled(): boolean {
    return this.connected && this.has("canvas") && this.mcpFeatures.includes("canvas");
  }

  /**
   * The player sets the canvas (wand corners, `canvas here`) or clears it (`canvas clear`, null): the
   * box is widened to whole chunk columns and the build height. Sends `canvas` when both hellos list
   * it. A new canvas ends the search and fill it held, as a new select grant does.
   */
  setCanvas(c: { box: WireBox; dimension?: string } | null): void {
    this.canvas = c && { box: widenToColumns(c.box), dimension: c.dimension ?? "minecraft:overworld" };
    this.searchWalk = null;
    this.worldFill = null;
    if (this.canvasEnabled) this.sendCanvas();
  }

  /** The `ui` messages received since index `from` that are for `player` (by `players`, or `player` on a result). */
  uiFor(player: string, from = 0): UiMcpMessage[] {
    return this.ui.slice(from).filter((m) => ("players" in m ? m.players.includes(player) : m.player === player));
  }

  // ── connection control ─────────────────────────────────────────────────────────────────────

  /** Drops the current connection (the game stays up, same token and port). */
  dropConnection(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  /** The game restarts: connection dropped, new token and port, pairing file rewritten. World and volumes persist. */
  async restart(): Promise<void> {
    await this.stopServer();
    await this.listen();
  }

  /** Stops the host, removes the pairing file (and the temporary instance folder it created). */
  async close(): Promise<void> {
    await this.stopServer();
    await removePairing(this.instanceDir);
    if (this.ownsDir) await rm(this.instanceDir, { recursive: true, force: true });
  }

  /** Waits until `pred` returns something other than undefined/false. */
  async waitFor<T>(pred: () => T | undefined | false, timeoutMs = 2000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = pred();
      if (v !== undefined && v !== false) return v;
      if (Date.now() > end) throw new Error("fake host: timed out waiting");
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  /** Waits for the next message of a type received after this call. */
  waitForMessage<T extends McpMessage["type"]>(type: T, timeoutMs = 2000): Promise<Extract<McpMessage, { type: T }>> {
    const from = this.received.length;
    return this.waitFor(() => this.received.slice(from).find((m) => m.type === type) as Extract<McpMessage, { type: T }> | undefined, timeoutMs);
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────

  private normalize(v: Volumes): Volumes & { context: WireBox[]; dimension: string } {
    return { work: v.work, context: v.context ?? [grow(v.work, 3)], dimension: v.dimension ?? "minecraft:overworld" };
  }

  /** The effective work volume (work, or the declared extension): the only place patches may write. */
  private inWork(p: Vec3): boolean {
    const v = this.volumes;
    return !!v && (inBox(v.work, p) || (this.extended !== null && inBox(this.extended, p)));
  }

  /** Work, extension or context: what the change tracker watches. */
  private inVolumes(p: Vec3): boolean {
    const v = this.volumes;
    return !!v && (inBox(v.work, p) || (this.extended !== null && inBox(this.extended, p)) || v.context.some((b) => inBox(b, p)));
  }

  private async listen(): Promise<void> {
    this.token = randomBytes(32).toString("hex");
    const server = createServer((s) => this.accept(s));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    await writePairing(this.instanceDir, { protocol: this.opts.protocol ?? PROTOCOL_VERSION, host: "127.0.0.1", port: this.port, token: this.token, pid: process.pid, started: new Date().toISOString() });
  }

  private async stopServer(): Promise<void> {
    this.dropConnection();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private accept(s: Socket): void {
    const reader = new FrameReader();
    let authed = false;
    const timer = setTimeout(() => s.destroy(), this.opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    const raw = (m: ModMessage) => {
      if (!s.destroyed) s.write(encodeMessage(m));
    };
    const refuse = (code: ErrorCode, message: string, extra: { protocol?: number } = {}) => {
      raw({ type: "error", id: null, code, message, ...extra });
      s.end();
      s.destroySoon?.();
    };
    s.on("error", () => {});
    s.on("close", () => {
      clearTimeout(timer);
      if (this.socket === s) {
        this.socket = undefined;
        this.setSelectGrant(null); // a grant lasts until the connection closes
      }
    });
    s.on("data", (chunk) => {
      let frames: Uint8Array[];
      try {
        frames = reader.push(chunk);
      } catch (e) {
        return refuse("bad_request", (e as Error).message);
      }
      for (const f of frames) {
        if (s.destroyed) return;
        if (!authed) {
          let m: McpMessage;
          try {
            m = decodeMessage(f, "mcp");
          } catch (e) {
            return refuse(splitType(f) === "hello" ? "bad_request" : "not_ready", (e as Error).message);
          }
          if (m.type !== "hello") return refuse("not_ready", `expected hello, got ${m.type}`);
          this.received.push(m);
          const mine = this.protocol;
          if (m.protocol !== mine) return refuse("protocol_mismatch", `mod speaks protocol ${mine}, MCP sent ${m.protocol}`, { protocol: mine });
          const a = Buffer.from(m.token), b = Buffer.from(this.token);
          if (a.length !== b.length || !timingSafeEqual(a, b)) return refuse("bad_token", "wrong pairing token");
          authed = true;
          clearTimeout(timer);
          this.volatile = m.volatile;
          this.mcpModes = helloModes(m);
          this.mcpFeatures = m.features ?? [];
          if (this.socket && this.socket !== s) {
            const old = this.socket;
            old.write(encodeMessage({ type: "error", id: null, code: "replaced", message: "a newer connection took over" }));
            old.destroySoon?.();
          }
          this.socket = s;
          this.connections++;
          this.queue = Promise.resolve();
          this.send({
            type: "hello",
            protocol: mine,
            mod: { version: "0.0.0-fake" },
            game: { version: "1.21.1", dataVersion: 3955, loader: "neoforge", loaderVersion: "21.1.249", ...this.opts.game },
            singleplayer: this.opts.singleplayer ?? true,
            host: this.opts.host === undefined ? { name: "Dev", uuid: "00000000-0000-4000-8000-000000000001" } : this.opts.host,
            ...(this.features ? { features: this.features } : {}),
          });
          this.sendVolumes();
          if (this.canvasEnabled) this.sendCanvas();
          continue;
        }
        let m: McpMessage;
        try {
          m = decodeMessage(f, "mcp");
        } catch (e) {
          // Undecodable framing or header: answer with id null and close. Otherwise answer (by id when there is one) and stay open.
          if (!headerDecodes(f)) return refuse("bad_request", (e as Error).message);
          const type = splitType(f);
          const unknown = type !== undefined && !KNOWN.has(type);
          const id = splitId(f);
          if (unknown && id === undefined) continue; // unknown_type is answered only when the message carries an id
          this.send({ type: "error", id: id ?? null, code: unknown ? "unknown_type" : "bad_request", message: (e as Error).message });
          continue;
        }
        this.received.push(m);
        if (m.type === "patch") this.lastPatchId = m.id;
        if (this.socket !== s) continue;
        // Requests (messages with an id) run strictly in order; id-less messages don't wait behind a held patch.
        if ("id" in m && m.type !== "prompt.result" && m.type !== "error") {
          this.queue = this.queue.then(() => this.handle(m, s)).catch((e: unknown) => this.send({ type: "error", id: m.id as number, code: "internal", message: String(e) }, s));
        } else void this.handle(m, s);
      }
    });
  }

  private setSelectGrant(g: SelectGrant | null): void {
    this.selectGrant = g;
    this.searchWalk = null;
    this.worldFill = null;
  }

  private get missingChunks(): ReadonlySet<string> {
    return this.opts.missingChunks ?? new Set<string>();
  }

  private stateAt = (x: number, y: number, z: number): string => (this.missingChunks.has(`${x >> 4},${z >> 4}`) ? AIR : this.get([x, y, z]).state);

  /** The checks every select request makes first: the feature (else, as a mod without it, `unknown_type`), the grant, the dimension. */
  private selectCheck(m: { type: string; id: number; dimension: string }, s: Socket): SelectGrant | undefined {
    if (!this.has("select")) {
      this.send({ type: "error", id: m.id, code: "unknown_type", message: `unknown message type ${m.type}` }, s);
      return undefined;
    }
    const g = this.readArea(m.dimension);
    if (g) return g;
    if (!this.selectGrant && !this.canvasReadable) {
      this.send({ type: "error", id: m.id, code: "no_grant", message: "no select request is open and no canvas is set: the player sends /autosketch select or sets a canvas first" }, s);
      return undefined;
    }
    this.send({ type: "error", id: m.id, code: "wrong_dimension", message: `the select request or canvas is in ${(this.selectGrant ?? this.canvas)!.dimension}` }, s);
    return undefined;
  }

  /** Whether the host serves reads inside its canvas (it has one, and the feature). */
  private get canvasReadable(): boolean {
    return this.canvas !== null && this.has("canvas");
  }

  /**
   * What the host may read in `dimension` beyond the volumes: the select grant, the canvas (`19`,
   * in every mode), or both. Searches walk, and fills grow, inside it. Undefined when neither is there.
   */
  private readArea(dimension: string): SelectGrant | undefined {
    const g = this.selectGrant && this.selectGrant.dimension === dimension ? this.selectGrant : undefined;
    const c = this.canvasReadable && this.canvas!.dimension === dimension ? this.canvas!.box : undefined;
    if (!c) return g;
    const chunks = { min: [c.min[0] >> 4, c.min[2] >> 4] as [number, number], max: [c.max[0] >> 4, c.max[2] >> 4] as [number, number] };
    // Without a select grant a search centres on the canvas's middle chunk; radius -1 makes the square empty.
    return g ? { ...g, canvas: chunks } : { dimension, centre: [(chunks.min[0] + chunks.max[0]) >> 1, (chunks.min[1] + chunks.max[1]) >> 1], radius: -1, canvas: chunks };
  }

  /** `search` (`18`, piece 2): a new walk, or the grant's last walk continued. */
  private search(m: SearchRequest, s: Socket): void {
    const g = this.selectCheck(m, s);
    if (!g) return;
    if ("continue" in m) {
      if (!this.searchWalk) return this.send({ type: "error", id: m.id, code: "bad_request", message: "no search to continue" }, s);
    } else {
      if (m.around && !grantHasChunk(g, m.around[0] >> 4, m.around[2] >> 4)) return this.send({ type: "error", id: m.id, code: "outside_volumes", message: "around lies outside the select grant" }, s);
      this.searchWalk = newSearch(m, g, this.opts.selectChunks ?? SELECT_CHUNKS);
    }
    const walk = this.searchWalk;
    const blocks: [Vec3, string][] = [...this.world].map(([k, c]) => [k.split(",").map(Number) as Vec3, c.state]);
    walk.walk(blocks, this.missingChunks, m.stop ?? SEARCH_STOP, this.opts.tags ?? {});
    this.send(walk.result(m.id, m.dimension), s);
  }

  /** `fill` (`18`, piece 3): replaces the grant's fill. */
  private fill(m: FillRequest, s: Socket): void {
    const g = this.selectCheck(m, s);
    if (!g) return;
    if (!grantHasChunk(g, m.seed[0] >> 4, m.seed[2] >> 4)) return this.send({ type: "error", id: m.id, code: "outside_volumes", message: "the seed lies outside the select grant" }, s);
    const f = new WorldFill(m.seed, m.match, m.connectivity, g, this.missingChunks, m.area ?? 1, this.opts.tags ?? {});
    this.worldFill = f;
    f.run(this.stateAt, m.budget ?? this.opts.contextCap ?? 4_194_304);
    this.send(f.result(m.id, m.dimension), s);
  }

  /** `expand` (`18`, piece 4): grows the fill's read area and resumes it; the answer lists the changed sections. */
  private expand(m: ExpandRequest, s: Socket): void {
    const g = this.selectCheck(m, s);
    if (!g) return;
    const f = this.worldFill;
    if (!f) return this.send({ type: "error", id: m.id, code: "bad_request", message: "no fill to expand" }, s);
    f.expand(m.by);
    const added = f.run(this.stateAt, m.budget ?? this.opts.contextCap ?? 4_194_304);
    this.send(f.result(m.id, m.dimension, added), s);
  }

  /** Whether a blocks read lies inside the select grant; over `contextCap` positions it is `too_large`. */
  private selectRead(dimension: string, boxes: WireBox[], positions: number): ErrorCode | "grant" | undefined {
    const g = this.readArea(dimension);
    if (!g || !boxes.every((b) => grantHasBox(g, b))) return undefined;
    return positions > (this.opts.contextCap ?? 4_194_304) ? "too_large" : "grant";
  }

  private maskSnapshot(m: MaskSnapshotRequest, s: Socket): void {
    const boxes = maskRegions(m.sections, m.margin ?? MASK_MARGIN);
    const sel = this.selectRead(m.dimension, boxes, boxes.reduce((n, b) => n + boxVolume(b), 0));
    if (sel === "too_large") return this.send({ type: "error", id: m.id, code: "too_large", message: "the read is over contextCap" }, s);
    if (sel !== "grant") {
      const err = this.checkRead(m.dimension, boxes);
      if (err) return this.send({ type: "error", id: m.id, code: err, message: `can't serve a mask snapshot: ${err}` }, s);
    }
    this.snapshot({ type: "snapshot", id: m.id, dimension: m.dimension, boxes }, s, sel === "grant");
  }

  private coarseSnapshot(m: CoarseSnapshotRequest, s: Socket): void {
    const palette: string[] = [];
    const index = new Map<string, number>();
    const regions = m.boxes.map((b) => coarseRegion(b, m.cell, this.stateAt, palette, index));
    const aligned = regions.map((r) => r.box);
    const sel = this.selectRead(m.dimension, aligned, regions.reduce((n, r) => n + r.states.length, 0));
    if (sel === "too_large") return this.send({ type: "error", id: m.id, code: "too_large", message: "the read is over contextCap" }, s);
    if (sel !== "grant") {
      const err = this.checkRead(m.dimension, aligned);
      if (err) return this.send({ type: "error", id: m.id, code: err, message: `can't serve a coarse snapshot: ${err}` }, s);
    }
    const missing = sel === "grant" ? missingIn(aligned, this.missingChunks) : [];
    this.send({ type: "snapshot.result", id: m.id, dimension: m.dimension, kind: "coarse", cell: m.cell, palette, regions, ...(missing.length ? { missing } : {}) }, s);
  }

  private send(m: ModMessage, s = this.socket): void {
    if (!s || s.destroyed) return;
    this.sent.push(m);
    s.write(encodeMessage(m));
  }

  private sendCanvas(id?: number, s = this.socket): void {
    const c = this.canvas;
    this.send(c ? { type: "canvas", ...(id !== undefined ? { id } : {}), dimension: c.dimension, box: c.box } : { type: "canvas", box: null }, s);
  }

  /** `canvas.set` (`19`, *Setting the canvas*): widened as the player's canvas, confirmed by a `canvas` carrying the id. */
  private canvasSet(m: CanvasSet, s: Socket): void {
    if (!this.has("canvas")) return this.send({ type: "error", id: m.id, code: "unknown_type", message: "unknown message type canvas.set" }, s);
    if (!DIMENSIONS.has(m.dimension)) return this.send({ type: "error", id: m.id, code: "wrong_dimension", message: `no dimension ${m.dimension} on this server` }, s);
    const box = widenToColumns(m.box);
    const cap = this.opts.canvasChunks ?? CANVAS_CHUNKS;
    const across = Math.max((box.max[0] - box.min[0] + 1) >> 4, (box.max[2] - box.min[2] + 1) >> 4);
    if (across > cap) return this.send({ type: "error", id: m.id, code: "bad_volumes", message: `the canvas would span ${across} chunks, more than canvasChunks (${cap})` }, s);
    this.canvas = { box, dimension: m.dimension };
    this.searchWalk = null;
    this.worldFill = null;
    this.sendCanvas(m.id, s);
  }

  private sendVolumes(): void {
    const v = this.volumes;
    this.send(v ? { type: "volumes", link: this.link, dimension: v.dimension, work: v.work, context: v.context, ...(this.extended ? { extended: this.extended } : {}) } : { type: "volumes", link: this.link, work: null });
  }

  private async handle(m: McpMessage, s: Socket): Promise<void> {
    switch (m.type) {
      case "search":
        return this.search(m, s);
      case "fill":
        return this.fill(m, s);
      case "expand":
        return this.expand(m, s);
      case "snapshot":
        if ("kind" in m && (m.kind === "mask" || m.kind === "coarse")) {
          // A mod without select decodes these as a blocks snapshot and refuses the kind.
          if (!this.has("select")) return this.send({ type: "error", id: m.id, code: "bad_request", message: `not a blocks snapshot (kind ${m.kind})` }, s);
          return m.kind === "mask" ? this.maskSnapshot(m, s) : this.coarseSnapshot(m, s);
        }
        if ("kind" in m && m.kind === "surface") {
          // A version-1 mod reads neither kind nor columns: to it this snapshot has no boxes or sections.
          // Protocols 2 and 3 serve it under the feature `scan`, protocol 4 under `select`.
          if (!this.has("scan") && !this.has("select")) return this.send({ type: "error", id: m.id, code: "bad_request", message: "snapshot takes exactly one of boxes or sections" }, s);
          return this.surface(m, s);
        }
      // falls through
      case "hashes": {
        const boxes = "boxes" in m ? m.boxes : m.sections.map(sectionBox);
        const sel = m.type === "snapshot" ? this.selectRead(m.dimension, boxes, boxes.reduce((n, b) => n + boxVolume(b), 0)) : undefined;
        if (sel === "too_large") return this.send({ type: "error", id: m.id, code: "too_large", message: "the read is over contextCap" }, s);
        const err = sel === "grant" ? undefined : this.checkRead(m.dimension, boxes);
        if (err) return this.send({ type: "error", id: m.id, code: err, message: `can't serve ${m.type}: ${err}` }, s);
        if (m.type === "hashes") return this.send({ type: "hashes.result", id: m.id, sections: sectionHashes(m.boxes, (x, y, z) => this.get([x, y, z]), this.volatile) }, s);
        return this.snapshot({ type: "snapshot", id: m.id, dimension: m.dimension, boxes }, s, sel === "grant");
      }
      case "canvas.set":
        return this.canvasSet(m, s);
      case "volumes.set":
        if (!this.has("volumes.set")) return this.send({ type: "error", id: m.id, code: "unknown_type", message: "unknown message type volumes.set" }, s);
        return this.volumesSet(m, s);
      case "volumes.extend": {
        const v = this.volumes;
        if (!v || m.link !== this.link) return this.send({ type: "error", id: m.id, code: "stale_link", message: `extension for link ${m.link}, current link is ${this.link}` }, s);
        if (!containsBox(m.work, v.work)) return this.send({ type: "error", id: m.id, code: "bad_extension", message: "the extended work volume must contain the player's work volume" }, s);
        this.extended = m.work;
        return this.sendVolumes();
      }
      case "patch":
        if (m.id <= this.dropUpTo) {
          this.droppedPatches.push(m.id);
          return this.send({ type: "error", id: m.id, code: "dropped", message: `patch ${m.id} dropped before it started: the player stopped the request` }, s);
        }
        await this.beforePatch?.(m);
        return this.applyPatch(m, s);
      case "patch.drop":
        // A mod without `requests` doesn't know this id-less type and ignores it. The patch in progress
        // (held in `beforePatch`) has started, so it finishes; the queued ones behind it are dropped.
        if (this.has("requests")) this.dropUpTo = this.lastPatchId;
        return;
      case "registry": {
        if (!this.has("registry")) return this.send({ type: "error", id: m.id, code: "unknown_type", message: "unknown message type registry" }, s);
        const { gzip, hash } = this.registryFile;
        const dataVersion = this.opts.game?.dataVersion ?? 3955;
        return this.send(m.have === hash ? { type: "registry.result", id: m.id, hash, dataVersion, unchanged: true } : { type: "registry.result", id: m.id, hash, dataVersion, report: gzip }, s);
      }
      case "upgrade": {
        if (!this.has("upgrade")) return this.send({ type: "error", id: m.id, code: "unknown_type", message: "unknown message type upgrade" }, s);
        const to = this.opts.game?.dataVersion ?? 3955;
        const data = m.from >= to ? dataOf(m) : (this.opts.upgrade ?? renameUpgrade)(m, to);
        return this.send({ type: "upgrade.result", id: m.id, to, ...data }, s);
      }
      case "prompt.result": {
        const resolve = this.prompts.get(m.id);
        this.prompts.delete(m.id);
        resolve?.(m);
        return;
      }
      case "notice": {
        this.notices.push(m);
        const i = this.noticeWaiters.findIndex((w) => w.player === m.player);
        if (i >= 0) this.noticeWaiters.splice(i, 1)[0]!.resolve(m);
        else this.resolveControl(m.player, m);
        return;
      }
      case "chat":
        if (m.kind === "status") {
          // A mod without `requests` doesn't know the kind and drops it.
          (this.requestsEnabled ? this.statuses : this.requestsUngated).push(m);
          return;
        }
        this.chats.push(m);
        if (m.kind === "reply" && m.request === null) this.resolveControl(m.player, m);
        return;
      case "hello":
        return this.send({ type: "error", id: null, code: "bad_request", message: "hello after the handshake" }, s);
      case "ui.state":
      case "ui.flash":
      case "ui.ghost":
      case "ui.ghost.clear":
      case "replay.frame":
      case "ui.result": {
        if (!this.uiEnabled) {
          // A mod without the feature doesn't know these id-less types and ignores them.
          this.uiUngated.push(m);
          return;
        }
        this.ui.push(m);
        if (m.type === "ui.result") {
          const resolve = this.uiRequests.get(m.request);
          this.uiRequests.delete(m.request);
          resolve?.(m);
        }
        return;
      }
      case "error":
        return;
    }
  }

  /** Hands an answer to the oldest `playerControl` of that player still waiting. */
  private resolveControl(player: string | null, m: NoticeMessage | ChatMessage): void {
    const i = this.controlWaiters.findIndex((w) => w.player === player);
    if (i >= 0) this.controlWaiters.splice(i, 1)[0]!.resolve(m);
  }

  /** `volumes.set` (*Wire format*): the volumes as if the player had marked them, confirmed by a `volumes` carrying the id. */
  private volumesSet(m: VolumesSet, s: Socket): void {
    const refuse = (code: ErrorCode, message: string) => this.send({ type: "error", id: m.id, code, message }, s);
    if (!DIMENSIONS.has(m.dimension)) return refuse("wrong_dimension", `no dimension ${m.dimension} on this server`);
    if (m.work.min[1] < BUILD_MIN_Y || m.work.max[1] > BUILD_MAX_Y) return refuse("bad_volumes", "the work volume lies outside the build height");
    const clip = (b: WireBox): WireBox => ({ min: [b.min[0], Math.max(b.min[1], BUILD_MIN_Y), b.min[2]], max: [b.max[0], Math.min(b.max[1], BUILD_MAX_Y), b.max[2]] });
    let context = (m.context ?? [grow(m.work, 3)]).map(clip);
    const seam = clip(grow(m.work, 1));
    if (!context.some((b) => containsBox(b, seam))) context = [seam, ...context];
    const total = context.reduce((n, b) => n + (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1), 0);
    if (total > (this.opts.contextCap ?? 4_194_304)) return refuse("bad_volumes", `the context holds ${total} blocks, more than the cap of ${this.opts.contextCap ?? 4_194_304}`);
    const prev = this.volumes;
    if (!prev || prev.dimension !== m.dimension || !sameBox(prev.work, m.work)) {
      this.link++;
      this.extended = null;
    }
    this.volumes = { work: m.work, context, dimension: m.dimension };
    this.send({ type: "volumes", id: m.id, link: this.link, dimension: m.dimension, work: m.work, context, ...(this.extended ? { extended: this.extended } : {}) }, s);
  }

  /** `snapshot` kind `surface`: per column the topmost non-air block, and the lowest one at or above `ceiling`. */
  private surface(m: SurfaceRequest, s: Socket): void {
    const a = m.columns;
    const sg = this.readArea(m.dimension);
    const inSelect = !!sg && grantHasChunk(sg, a.min[0] >> 4, a.min[1] >> 4) && grantHasChunk(sg, a.max[0] >> 4, a.max[1] >> 4);
    if (!inSelect) {
      const box: WireBox = { min: [a.min[0], 0, a.min[1]], max: [a.max[0], 0, a.max[1]] };
      const err = this.checkRead(m.dimension, [box]);
      if (err) return this.send({ type: "error", id: m.id, code: err, message: `can't serve a surface snapshot: ${err}` }, s);
    }
    const sx = a.max[0] - a.min[0] + 1, sz = a.max[1] - a.min[1] + 1, n = sx * sz;
    const missing = this.opts.missingChunks ?? new Set<string>();
    const top = new Map<string, number>(), ceil = new Map<string, number>();
    for (const [k, c] of this.world) {
      if (c.state === AIR) continue;
      const [x, y, z] = k.split(",").map(Number) as [number, number, number];
      if (x < a.min[0] || x > a.max[0] || z < a.min[1] || z > a.max[1] || y < BUILD_MIN_Y || y > BUILD_MAX_Y) continue;
      const col = `${x},${z}`;
      if ((top.get(col) ?? -Infinity) < y) top.set(col, y);
      if (m.ceiling !== undefined && y >= m.ceiling && (ceil.get(col) ?? Infinity) > y) ceil.set(col, y);
    }
    const palette: string[] = [];
    const index = new Map<string, number>();
    const layer = (): SurfaceLayer => ({ heights: new Uint32Array(n), states: new Uint32Array(n) });
    const surface = layer(), ceilings = m.ceiling !== undefined ? layer() : undefined;
    const put = (l: SurfaceLayer, i: number, x: number, y: number | undefined, z: number) => {
      if (y === undefined) return;
      const st = this.get([x, y, z]).state;
      let p = index.get(st);
      if (p === undefined) index.set(st, (p = palette.push(st) - 1));
      l.heights[i] = y - BUILD_MIN_Y + 1;
      l.states[i] = p;
    };
    for (let dz = 0; dz < sz; dz++)
      for (let dx = 0; dx < sx; dx++) {
        const x = a.min[0] + dx, z = a.min[1] + dz, i = dx + sx * dz;
        if (missing.has(`${x >> 4},${z >> 4}`)) continue;
        put(surface, i, x, top.get(`${x},${z}`), z);
        if (ceilings) put(ceilings, i, x, ceil.get(`${x},${z}`), z);
      }
    const missingList: [number, number][] = [];
    for (let cz = a.min[1] >> 4; cz <= a.max[1] >> 4; cz++) for (let cx = a.min[0] >> 4; cx <= a.max[0] >> 4; cx++) if (missing.has(`${cx},${cz}`)) missingList.push([cx, cz]);
    this.send({ type: "snapshot.result", id: m.id, dimension: m.dimension, kind: "surface", columns: a, minY: BUILD_MIN_Y, ...(m.ceiling !== undefined ? { ceiling: m.ceiling } : {}), missing: missingList, palette, surface, ...(ceilings ? { ceilings } : {}) }, s);
  }

  /** Read checks: inside the chunks the volumes keep loaded. */
  private checkRead(dimension: string, boxes: WireBox[]): ErrorCode | undefined {
    const v = this.volumes;
    if (!v) return "no_volumes";
    if (dimension !== v.dimension) return "wrong_dimension";
    const chunks = new Set<string>();
    for (const b of [v.work, ...(this.extended ? [this.extended] : []), ...v.context]) for (let cx = b.min[0] >> 4; cx <= b.max[0] >> 4; cx++) for (let cz = b.min[2] >> 4; cz <= b.max[2] >> 4; cz++) chunks.add(`${cx},${cz}`);
    for (const b of boxes) for (let cx = b.min[0] >> 4; cx <= b.max[0] >> 4; cx++) for (let cz = b.min[2] >> 4; cz <= b.max[2] >> 4; cz++) if (!chunks.has(`${cx},${cz}`)) return "outside_volumes";
    return undefined;
  }

  /** A blocks snapshot; under the select grant, ungenerated chunks read as air and are listed in `missing`. */
  private snapshot(m: SnapshotRequest & { boxes: WireBox[] }, s: Socket, select = false): void {
    const boxes = m.boxes;
    const at = select ? (p: Vec3): WorldBlock => (this.missingChunks.has(`${p[0] >> 4},${p[2] >> 4}`) ? { pos: p, state: AIR } : this.get(p)) : (p: Vec3) => this.get(p);
    const palette: string[] = [];
    const index = new Map<string, number>();
    const regions = boxes.map((box) => {
      const blockEntities: { pos: Vec3; nbt: Compound }[] = [];
      const states = new Uint32Array((box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) * (box.max[2] - box.min[2] + 1));
      let i = 0;
      for (let y = box.min[1]; y <= box.max[1]; y++)
        for (let z = box.min[2]; z <= box.max[2]; z++)
          for (let x = box.min[0]; x <= box.max[0]; x++) {
            const b = at([x, y, z]);
            let p = index.get(b.state);
            if (p === undefined) {
              index.set(b.state, (p = palette.length));
              palette.push(b.state);
            }
            states[i++] = p;
            if (b.nbt) blockEntities.push({ pos: [x, y, z], nbt: b.nbt });
          }
      return { box, states, blockEntities };
    });
    const missing = select ? missingIn(boxes, this.missingChunks) : [];
    const result = { type: "snapshot.result" as const, id: m.id, dimension: m.dimension, palette, regions, ...(missing.length ? { missing } : {}) };
    try {
      s.write(encodeMessage(result));
      this.sent.push(result);
    } catch (e) {
      if (!(e instanceof ProtocolError)) throw e;
      this.send({ type: "error", id: m.id, code: "too_large", message: e.message }, s);
    }
  }

  private known(state: string): boolean {
    return isCanonicalForm(state) && (!this.knownStates || this.knownStates.has(state));
  }

  private hashKey(nbt: Compound | undefined): string {
    if (!nbt) return "none";
    if (isStateOnly(nbt, this.volatile)) return "state_only";
    return nbtHash(nbt, this.volatile)!;
  }

  private applyPatch(p: PatchMessage, s: Socket): void {
    const v = this.volumes;
    const ack: PatchAck = { type: "patch.ack", id: p.id, applied: 0, overwritten: 0, skipped: [], rejected: [], normalized: [] };
    const accepts = this.opts.acceptsNbt ?? ((_: string, nbt: Compound) => nbt.value.id?.type === "string");
    if (!v || p.link !== this.link || p.dimension !== v.dimension) {
      ack.rejected = p.blocks.map((b) => ({ pos: b.pos, reason: "stale_link" }));
    } else {
      for (const b of p.blocks) {
        if (!this.inWork(b.pos)) {
          ack.rejected.push({ pos: b.pos, reason: "outside_volumes" });
          continue;
        }
        if (!this.known(b.state)) {
          ack.rejected.push({ pos: b.pos, reason: "unknown_state" });
          continue;
        }
        if (b.nbt && !accepts(b.state, b.nbt)) {
          ack.rejected.push({ pos: b.pos, reason: "bad_nbt" });
          continue;
        }
        const cur = this.get(b.pos);
        const ok = cur.state === b.expected && (b.expectedNbtHash === undefined || (cur.nbt !== undefined && this.hashKey(cur.nbt) === b.expectedNbtHash));
        if (!ok && !p.force) {
          ack.skipped.push(cur);
          continue;
        }
        if (!ok) ack.overwritten++;
        const written = this.opts.normalizeNbt ? this.opts.normalizeNbt(b.pos, b.state, b.nbt) : b.nbt;
        this.set(b.pos, b.state, written);
        ack.applied++;
        const sent = this.hashKey(b.nbt), now = this.hashKey(written);
        if (sent !== now && sent !== "state_only" && now !== "state_only") ack.normalized.push(written ? { pos: b.pos, nbt: written } : { pos: b.pos });
      }
    }
    this.patchLog.push({ patch: p, ack });
    this.send(ack, s);
  }
}

function containsBox(outer: WireBox, inner: WireBox): boolean {
  return [0, 1, 2].every((i) => outer.min[i]! <= inner.min[i]! && outer.max[i]! >= inner.max[i]!);
}

/** A box widened to whole chunk columns and the build height, as the mod widens a canvas (`19`). */
function widenToColumns(b: WireBox): WireBox {
  return { min: [(b.min[0] >> 4) * 16, BUILD_MIN_Y, (b.min[2] >> 4) * 16], max: [(b.max[0] >> 4) * 16 + 15, BUILD_MAX_Y, (b.max[2] >> 4) * 16 + 15] };
}

const DIMENSIONS = new Set(["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"]);
const KNOWN = new Set(["hello", "error", "volumes.extend", "volumes.set", "hashes", "snapshot", "search", "fill", "expand", "patch", "registry", "upgrade", "prompt.result", "notice", "chat", "canvas.set", "patch.drop", ...UI_MCP_TYPES]);

/** The features each protocol version's mod lists (*Versions and features*). */
const FEATURES_BY_VERSION: Record<number, string[] | undefined> = { 1: undefined, 2: ["modes", "scan", "volumes.set"], 3: ["modes", "scan", "volumes.set", "registry", "upgrade", "ui", "select"], 4: [...MOD_FEATURES] };

/** A small vanilla registry report (format 1). */
const DEFAULT_REPORT = {
  format: 1,
  minecraft: "1.21.1",
  dataVersion: 3955,
  loader: "neoforge",
  loaderVersion: "21.1.249",
  blocks: { "minecraft:air": {}, "minecraft:stone": {} },
  tags: {},
};

function dataOf(m: UpgradeRequest): UpgradeData {
  return m.kind === "structure" ? { kind: "structure", structure: m.structure } : { kind: "elements", states: m.states, blockEntities: m.blockEntities, entities: m.entities };
}

/** The fake data fixer: the MCP's rename table over states (and a structure's palette names), NBT unchanged. */
function renameUpgrade(m: UpgradeRequest, to: number): UpgradeData {
  if (m.kind === "elements") return { kind: "elements", states: m.states.map((st) => renameState(st, m.from, to)), blockEntities: m.blockEntities, entities: m.entities };
  const v = { ...m.structure.value } as Record<string, any>;
  const palette = v.palette?.value?.value as { Name?: { value: string } }[] | undefined;
  if (palette)
    v.palette = {
      ...v.palette,
      value: { ...v.palette.value, value: palette.map((e) => (e.Name ? { ...e, Name: { type: "string", value: renameState(e.Name.value, m.from, to) } } : e)) },
    };
  v.DataVersion = { type: "int", value: to };
  return { kind: "structure", structure: { ...m.structure, value: v } };
}

function sectionBox(s: Vec3): WireBox {
  return { min: [s[0] * 16, s[1] * 16, s[2] * 16], max: [s[0] * 16 + 15, s[1] * 16 + 15, s[2] * 16 + 15] };
}

function splitType(f: Uint8Array): string | undefined {
  try {
    const t = splitFrame(f).header.type;
    return typeof t === "string" ? t : undefined;
  } catch {
    return undefined;
  }
}

function splitId(f: Uint8Array): number | undefined {
  try {
    const id = splitFrame(f).header.id;
    return Number.isSafeInteger(id) && (id as number) >= 1 ? (id as number) : undefined;
  } catch {
    return undefined;
  }
}

function headerDecodes(f: Uint8Array): boolean {
  try {
    splitFrame(f);
    return true;
  } catch {
    return false;
  }
}
