import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Compound } from "prismarine-nbt";
import type { Vec3 } from "../../src/core/region.js";
import { decodeMessage, encodeMessage, ProtocolError, splitFrame } from "../../src/world/protocol/codec.js";
import { FrameReader } from "../../src/world/protocol/frame.js";
import { isStateOnly, nbtHash, sectionHashes } from "../../src/world/protocol/hash.js";
import {
  DIRTY_CAP,
  HELLO_TIMEOUT_MS,
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
  type SnapshotRequest,
  type VolatileList,
  type WireBox,
  type WorldBlock,
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
  /** Protocol version the host speaks (to test mismatches). */
  protocol?: number;
  /** Positions one dirty notice may list (default `DIRTY_CAP`). */
  dirtyCap?: number;
  /** Handshake timeout in ms (default `HELLO_TIMEOUT_MS`). */
  helloTimeoutMs?: number;
  /** How the game rewrites block-entity NBT when loading it (default: unchanged). */
  normalizeNbt?: (pos: Vec3, state: string, nbt: Compound | undefined) => Compound | undefined;
  /** Whether a block accepts the given NBT (default: any compound with a string `id`). */
  acceptsNbt?: (state: string, nbt: Compound) => boolean;
}

export interface PatchLogEntry {
  patch: PatchMessage;
  ack: PatchAck;
}

interface Cell {
  state: string;
  nbt?: Compound;
}

const AIR = "minecraft:air";
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
  readonly notices: NoticeMessage[] = [];
  /** Called before a patch is applied; may return a promise to hold it (later requests wait, as in the mod). */
  beforePatch?: (patch: PatchMessage) => void | Promise<void>;
  port = 0;
  token = "";
  link = 1;
  connections = 0;

  private server?: Server;
  private socket?: Socket;
  private volumes: (Volumes & { context: WireBox[]; dimension: string }) | null = null;
  private queue: Promise<void> = Promise.resolve();
  private promptId = 0;
  private readonly prompts = new Map<number, (r: PromptResult) => void>();
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

  // ── world access ───────────────────────────────────────────────────────────────────────────

  get(pos: Vec3): WorldBlock {
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
    if (!next || !prev || next.dimension !== prev.dimension || !sameBox(next.work, prev.work)) this.link++;
    this.volumes = next;
    if (this.connected) this.sendVolumes();
  }

  /** A player asks the agent from the game. Resolves with the MCP's `prompt.result` (or `no_link` when nobody is connected). */
  playerAsk(player: PlayerRef, text: string, context: Partial<GameContext> = {}): Promise<PromptResult> {
    const id = ++this.promptId;
    if (!this.connected) return Promise.resolve({ type: "prompt.result", id, delivered: false, reason: "no_link" });
    const ctx: GameContext = { dimension: this.volumes?.dimension ?? "minecraft:overworld", position: [0.5, 64, 0.5], eye: [0.5, 65.62, 0.5], yaw: 0, pitch: 0, facing: "south", ...context };
    return new Promise((resolve) => {
      this.prompts.set(id, resolve);
      this.send({ type: "prompt", id, player, text, context: ctx });
    });
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

  private inVolumes(p: Vec3): boolean {
    const v = this.volumes;
    return !!v && (inBox(v.work, p) || v.context.some((b) => inBox(b, p)));
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
      if (this.socket === s) this.socket = undefined;
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
          const mine = this.opts.protocol ?? PROTOCOL_VERSION;
          if (m.protocol !== mine) return refuse("protocol_mismatch", `mod speaks protocol ${mine}, MCP sent ${m.protocol}`, { protocol: mine });
          const a = Buffer.from(m.token), b = Buffer.from(this.token);
          if (a.length !== b.length || !timingSafeEqual(a, b)) return refuse("bad_token", "wrong pairing token");
          authed = true;
          clearTimeout(timer);
          this.volatile = m.volatile;
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
          });
          this.sendVolumes();
          continue;
        }
        let m: McpMessage;
        try {
          m = decodeMessage(f, "mcp");
        } catch (e) {
          const id = splitId(f);
          if (id === undefined) return refuse("bad_request", (e as Error).message);
          this.send({ type: "error", id, code: splitType(f) && !KNOWN.has(splitType(f)!) ? "unknown_type" : "bad_request", message: (e as Error).message });
          continue;
        }
        this.received.push(m);
        if (this.socket !== s) continue;
        this.queue = this.queue.then(() => this.handle(m, s)).catch(() => {});
      }
    });
  }

  private send(m: ModMessage, s = this.socket): void {
    if (!s || s.destroyed) return;
    this.sent.push(m);
    s.write(encodeMessage(m));
  }

  private sendVolumes(): void {
    const v = this.volumes;
    this.send(v ? { type: "volumes", link: this.link, dimension: v.dimension, work: v.work, context: v.context } : { type: "volumes", link: this.link, work: null });
  }

  private async handle(m: McpMessage, s: Socket): Promise<void> {
    switch (m.type) {
      case "hashes":
      case "snapshot": {
        const err = this.checkRead(m.dimension, "boxes" in m ? m.boxes : m.sections.map(sectionBox));
        if (err) return this.send({ type: "error", id: m.id, code: err, message: `can't serve ${m.type}: ${err}` }, s);
        if (m.type === "hashes") return this.send({ type: "hashes.result", id: m.id, sections: sectionHashes(m.boxes, (x, y, z) => this.get([x, y, z]), this.volatile) }, s);
        return this.snapshot(m, s);
      }
      case "patch":
        await this.beforePatch?.(m);
        return this.applyPatch(m, s);
      case "prompt.result": {
        const resolve = this.prompts.get(m.id);
        this.prompts.delete(m.id);
        resolve?.(m);
        return;
      }
      case "notice":
        this.notices.push(m);
        return;
      case "chat":
        this.chats.push(m);
        return;
      case "hello":
        return this.send({ type: "error", id: null, code: "bad_request", message: "hello after the handshake" }, s);
      case "error":
        return;
    }
  }

  private checkRead(dimension: string, boxes: WireBox[]): ErrorCode | undefined {
    const v = this.volumes;
    if (!v) return "no_volumes";
    if (dimension !== v.dimension) return "wrong_dimension";
    const chunks = new Set<string>();
    for (const b of [v.work, ...v.context]) for (let cx = b.min[0] >> 4; cx <= b.max[0] >> 4; cx++) for (let cz = b.min[2] >> 4; cz <= b.max[2] >> 4; cz++) chunks.add(`${cx},${cz}`);
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
        if (!this.inVolumes(b.pos)) {
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

const KNOWN = new Set(["hello", "error", "hashes", "snapshot", "patch", "prompt.result", "notice", "chat"]);

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
