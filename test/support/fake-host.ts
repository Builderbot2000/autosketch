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
  type RequestMode,
  type ScanGrant,
  type UpgradeData,
  type UpgradeRequest,
  type SnapshotRequest,
  type SurfaceLayer,
  type SurfaceRequest,
  type VolatileList,
  type VolumesSet,
  type WireArea,
  type WireBox,
  type WorldBlock,
  type UiMcpMessage,
  type UiResult,
  UI_MCP_TYPES,
} from "../../src/world/protocol/messages.js";
import { removePairing, writePairing } from "../../src/world/protocol/pairing.js";
import { isCanonicalForm } from "../../src/world/protocol/state.js";

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
 * In-game UI (`ui`, `13`, *In-game UI*): the host stands for the mod's relay and every player's
 * client at once. It records each `ui.*` and `replay.*` message in `ui` (`uiFor` filters by player),
 * and `playerUiRequest` sends a player's `ui.request` and resolves with its `ui.result`. Like the mod,
 * it does neither unless both hellos list `ui`, and keeps what arrives regardless in `uiUngated`.
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
  /** Scan sizing (`13`, B4): default radius, maximum radius, blocks below and above the feet, full-block cap. */
  scan?: { chunks?: number; chunksMax?: number; below?: number; above?: number; cap?: number };
  /** Chunks `"cx,cz"` that aren't generated: surface snapshots list them as missing. */
  missingChunks?: Set<string>;
  /** False makes the host a misbehaving mod that sends modes the MCP's hello didn't list (to test the MCP-side gate). Default true. */
  enforceModes?: boolean;
  /** Positions one dirty notice may list (default `DIRTY_CAP`). */
  dirtyCap?: number;
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
  /** The modes the MCP's last hello listed. */
  mcpModes: readonly RequestMode[] = [];
  /** The features the MCP's last hello listed (absent: none). */
  mcpFeatures: readonly string[] = [];
  /** The scan grant of the last scan request, while it lasts (*Wire format*, `prompt`, `scan`). */
  scanGrant: (ScanGrant & { dimension: string }) | null = null;
  /** Called before a patch is applied; may return a promise to hold it (later requests wait, as in the mod). */
  beforePatch?: (patch: PatchMessage) => void | Promise<void>;
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
   * when the MCP's hello didn't list the mode (B6). `mode` (default `build`) and `radius` (scan
   * only, in chunks) are the subcommand's; a host without the `modes` feature sends no mode.
   */
  playerAsk(player: PlayerRef, text: string, context: Partial<GameContext> = {}, opts: { mode?: RequestMode; radius?: number } = {}): Promise<AskResult> {
    const id = ++this.promptId;
    if (!this.connected) return Promise.resolve({ type: "prompt.result", id, delivered: false, reason: "no_link", local: true });
    const ctx: GameContext = { dimension: this.volumes?.dimension ?? "minecraft:overworld", position: [0.5, 64, 0.5], eye: [0.5, 65.62, 0.5], yaw: 0, pitch: 0, facing: "south", ...context };
    const modes = this.has("modes");
    const mode = opts.mode ?? "build";
    if (modes && this.opts.enforceModes !== false && !this.mcpModes.includes(mode)) return Promise.resolve({ type: "prompt.result", id, delivered: false, reason: "unsupported_mode", local: true });
    let scan: ScanGrant | undefined;
    if (modes && mode === "scan" && this.has("scan")) {
      scan = this.grant(ctx, opts.radius);
      this.scanGrant = { ...scan, dimension: ctx.dimension };
    }
    return new Promise((resolve) => {
      this.prompts.set(id, resolve);
      this.send({ type: "prompt", id, player, text, context: ctx, ...(modes ? { mode } : {}), ...(scan ? { scan } : {}) });
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
        this.scanGrant = null; // a grant lasts until the connection closes
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
        if (this.socket !== s) continue;
        // Requests (messages with an id) run strictly in order; id-less messages don't wait behind a held patch.
        if ("id" in m && m.type !== "prompt.result" && m.type !== "error") {
          this.queue = this.queue.then(() => this.handle(m, s)).catch((e: unknown) => this.send({ type: "error", id: m.id as number, code: "internal", message: String(e) }, s));
        } else void this.handle(m, s);
      }
    });
  }

  /** The scan grant for a request at `ctx` (B4): chunks within the radius, and the full-block box within the cap. */
  private grant(ctx: GameContext, radius?: number): ScanGrant {
    const o = this.opts.scan ?? {};
    const max = o.chunksMax ?? 12, asked = radius ?? o.chunks ?? 4;
    const r = Math.min(asked, max);
    const cx = Math.floor(ctx.position[0]) >> 4, cz = Math.floor(ctx.position[2]) >> 4;
    const columns: WireArea = { min: [16 * (cx - r), 16 * (cz - r)], max: [16 * (cx + r) + 15, 16 * (cz + r) + 15] };
    const fy = Math.floor(ctx.position[1]);
    const y0 = Math.max(BUILD_MIN_Y, fy - (o.below ?? 32)), y1 = Math.min(BUILD_MAX_Y, fy + (o.above ?? 64));
    const side = Math.min(columns.max[0] - columns.min[0] + 1, Math.floor(Math.sqrt((o.cap ?? 4_194_304) / (y1 - y0 + 1))));
    const px = Math.floor(ctx.position[0]), pz = Math.floor(ctx.position[2]);
    const lo = (p: number, a: number, b: number) => Math.min(Math.max(p - (side >> 1), a), b - side + 1);
    const bx = lo(px, columns.min[0], columns.max[0]), bz = lo(pz, columns.min[1], columns.max[1]);
    return { radius: r, ...(asked > max ? { clipped: true } : {}), columns, box: { min: [bx, y0, bz], max: [bx + side - 1, y1, bz + side - 1] } };
  }

  private send(m: ModMessage, s = this.socket): void {
    if (!s || s.destroyed) return;
    this.sent.push(m);
    s.write(encodeMessage(m));
  }

  private sendVolumes(): void {
    const v = this.volumes;
    this.send(v ? { type: "volumes", link: this.link, dimension: v.dimension, work: v.work, context: v.context, ...(this.extended ? { extended: this.extended } : {}) } : { type: "volumes", link: this.link, work: null });
  }

  private async handle(m: McpMessage, s: Socket): Promise<void> {
    switch (m.type) {
      case "snapshot":
        if ("kind" in m) {
          // A version-1 mod reads neither kind nor columns: to it this snapshot has no boxes or sections.
          if (!this.has("scan")) return this.send({ type: "error", id: m.id, code: "bad_request", message: "snapshot takes exactly one of boxes or sections" }, s);
          return this.surface(m, s);
        }
      // falls through
      case "hashes": {
        const err = this.checkRead(m.dimension, "boxes" in m ? m.boxes : m.sections.map(sectionBox), m.type === "snapshot");
        if (err) return this.send({ type: "error", id: m.id, code: err, message: `can't serve ${m.type}: ${err}` }, s);
        if (m.type === "hashes") return this.send({ type: "hashes.result", id: m.id, sections: sectionHashes(m.boxes, (x, y, z) => this.get([x, y, z]), this.volatile) }, s);
        return this.snapshot(m, s);
      }
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
        await this.beforePatch?.(m);
        return this.applyPatch(m, s);
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
        return;
      }
      case "chat":
        this.chats.push(m);
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
    const g = this.scanGrant;
    const a = m.columns;
    const inGrant = !!g && g.dimension === m.dimension && a.min[0] >= g.columns.min[0] && a.min[1] >= g.columns.min[1] && a.max[0] <= g.columns.max[0] && a.max[1] <= g.columns.max[1];
    if (!inGrant) {
      const box: WireBox = { min: [a.min[0], 0, a.min[1]], max: [a.max[0], 0, a.max[1]] };
      const err = this.checkRead(m.dimension, [box], false);
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

  /** Read checks; a blocks snapshot inside the scan grant's box is served with or without volumes. */
  private checkRead(dimension: string, boxes: WireBox[], blocks: boolean): ErrorCode | undefined {
    const g = this.scanGrant;
    if (blocks && g && g.dimension === dimension && boxes.every((b) => containsBox(g.box, b))) return undefined;
    const v = this.volumes;
    if (!v) return "no_volumes";
    if (dimension !== v.dimension) return "wrong_dimension";
    const chunks = new Set<string>();
    for (const b of [v.work, ...(this.extended ? [this.extended] : []), ...v.context]) for (let cx = b.min[0] >> 4; cx <= b.max[0] >> 4; cx++) for (let cz = b.min[2] >> 4; cz <= b.max[2] >> 4; cz++) chunks.add(`${cx},${cz}`);
    for (const b of boxes) for (let cx = b.min[0] >> 4; cx <= b.max[0] >> 4; cx++) for (let cz = b.min[2] >> 4; cz <= b.max[2] >> 4; cz++) if (!chunks.has(`${cx},${cz}`)) return "outside_volumes";
    return undefined;
  }

  private snapshot(m: SnapshotRequest, s: Socket): void {
    const boxes = "boxes" in m ? m.boxes : m.sections.map(sectionBox);
    const palette: string[] = [];
    const index = new Map<string, number>();
    const regions = boxes.map((box) => {
      const blockEntities: { pos: Vec3; nbt: Compound }[] = [];
      const states = new Uint32Array((box.max[0] - box.min[0] + 1) * (box.max[1] - box.min[1] + 1) * (box.max[2] - box.min[2] + 1));
      let i = 0;
      for (let y = box.min[1]; y <= box.max[1]; y++)
        for (let z = box.min[2]; z <= box.max[2]; z++)
          for (let x = box.min[0]; x <= box.max[0]; x++) {
            const b = this.get([x, y, z]);
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
    try {
      s.write(encodeMessage({ type: "snapshot.result", id: m.id, dimension: m.dimension, palette, regions }));
      this.sent.push({ type: "snapshot.result", id: m.id, dimension: m.dimension, palette, regions });
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

const DIMENSIONS = new Set(["minecraft:overworld", "minecraft:the_nether", "minecraft:the_end"]);
const KNOWN = new Set(["hello", "error", "volumes.extend", "volumes.set", "hashes", "snapshot", "patch", "registry", "upgrade", "prompt.result", "notice", "chat", ...UI_MCP_TYPES]);

/** The features each protocol version's mod lists (*Versions and features*). */
const FEATURES_BY_VERSION: Record<number, string[] | undefined> = { 1: undefined, 2: ["modes", "scan", "volumes.set"], 3: [...MOD_FEATURES] };

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
