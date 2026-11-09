import { connect as netConnect, type Socket } from "node:net";
import { decodeMessage, encodeMessage } from "./protocol/codec.js";
import { FrameReader } from "./protocol/frame.js";
import {
  PROTOCOL_VERSION,
  type ChatMessage,
  type ErrorMessage,
  type HashesRequest,
  type HashesResult,
  type McpMessage,
  type ModHello,
  type ModMessage,
  type NoticeMessage,
  type PatchAck,
  type PatchMessage,
  type PromptResult,
  type SnapshotRequest,
  type SnapshotResult,
  type VolatileList,
  type VolumesExtend,
  type VolumesMessage,
} from "./protocol/messages.js";
import { pairingPath, readPairing, type Pairing } from "./protocol/pairing.js";

/**
 * Bridge client (docs/design/13-live-world.md, W1, *Connection*, *Wire format*): reads the pairing
 * file in the instance folder, connects to the mod's loopback socket, does the handshake with the
 * token and the volatile-key list, matches requests to responses by id, and reconnects with backoff
 * when the game restarts (re-reading the pairing file, since the port and token change).
 *
 * Nothing is queued across a disconnect (`13`, *Lifecycle*): requests in flight reject with
 * `world_disconnected`, and sending while down rejects at once. The link decides what a reconnect
 * means (a section-hash sync).
 */

/** An error with a refusal code (main briefs README): `world_disconnected`, or the mod's error code. */
export class BridgeError extends Error {
  constructor(
    readonly refusal: string,
    message: string,
  ) {
    super(message);
  }
}

type Req<T> = T extends unknown ? Omit<T, "id"> : never;
type ModType = ModMessage["type"];
type ModOf<T extends ModType> = Extract<ModMessage, { type: T }>;

/** What the link and the sync code use of the bridge (silo Q codes against this). */
export interface BridgeConnection {
  readonly connected: boolean;
  /** The mod's hello on the current connection. */
  readonly hello: ModHello | undefined;
  /** The latest `volumes` the mod sent on the current connection (it sends one right after hello). */
  readonly volumes: VolumesMessage | undefined;
  /** Sends a request with a fresh id and resolves with its response; rejects with a `BridgeError`. */
  request(m: Req<HashesRequest>): Promise<HashesResult>;
  request(m: Req<SnapshotRequest>): Promise<SnapshotResult>;
  request(m: Req<PatchMessage>): Promise<PatchAck>;
  /** Resolves with the `volumes` message that confirms the extension. */
  request(m: Req<VolumesExtend>): Promise<VolumesMessage>;
  /** Fire-and-forget messages; dropped while disconnected. */
  send(m: NoticeMessage | ChatMessage | PromptResult): void;
  /** Listens to one message type from the mod. Returns the unsubscribe function. */
  on<T extends ModType>(type: T, fn: (m: ModOf<T>) => void): () => void;
  /** Listens to connection changes: `up` after each completed handshake, `down` on each loss. */
  onConnection(fn: (state: "up" | "down", why?: string) => void): () => void;
}

export interface BridgeOptions {
  /** The game instance folder holding `config/autosketch-bridge.toml` (`02` locates it). */
  instanceDir: string;
  volatile: VolatileList;
  client?: { name: string; version: string };
  /** Reconnect after a lost connection (default true), with backoff from `minMs` to `maxMs`. */
  reconnect?: boolean;
  backoff?: { minMs: number; maxMs: number };
  /** Gives up a connection attempt after this long (default 5 s). */
  connectTimeoutMs?: number;
  log?: (msg: string) => void;
}

interface Pending {
  resolve: (m: ModMessage) => void;
  reject: (e: Error) => void;
  expect: ModType;
}

const DOWN = "world_disconnected";

export class Bridge implements BridgeConnection {
  hello: ModHello | undefined;
  volumes: VolumesMessage | undefined;
  private socket?: Socket;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** `volumes.extend` ids awaiting their `volumes`, oldest first (a success carries no id). */
  private readonly extending: number[] = [];
  private readonly listeners = new Map<ModType, Set<(m: ModMessage) => void>>();
  private readonly connListeners = new Set<(state: "up" | "down", why?: string) => void>();
  private closed = false;
  private retryMs: number;
  private retryTimer?: NodeJS.Timeout;

  constructor(private readonly opts: BridgeOptions) {
    this.retryMs = opts.backoff?.minMs ?? 500;
  }

  get connected(): boolean {
    return this.hello !== undefined && this.socket !== undefined && !this.socket.destroyed;
  }

  /**
   * Connects once and resolves with the mod's hello, or rejects with a message the agent can act
   * on (no pairing file, port unreachable with the WSL hint, version mismatch, wrong token). After
   * a first success, lost connections are retried in the background unless `reconnect` is false.
   */
  async connect(): Promise<ModHello> {
    if (this.connected) return this.hello!;
    this.closed = false;
    clearTimeout(this.retryTimer);
    let pairing: Pairing;
    try {
      pairing = await readPairing(this.opts.instanceDir);
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      throw new BridgeError(
        DOWN,
        missing
          ? `No pairing file at ${pairingPath(this.opts.instanceDir)}: start the game with the Autosketch mod and open a world (the mod writes the file when the server starts).`
          : `Can't read the pairing file ${pairingPath(this.opts.instanceDir)}: ${(e as Error).message}`,
      );
    }
    if (pairing.protocol !== PROTOCOL_VERSION)
      throw new BridgeError(DOWN, `The mod speaks bridge protocol ${pairing.protocol} and this Autosketch speaks ${PROTOCOL_VERSION}: update the ${pairing.protocol > PROTOCOL_VERSION ? "Autosketch MCP server" : "Autosketch mod"}.`);
    const socket = await this.open(pairing);
    return this.handshake(socket, pairing);
  }

  /** The volatile-key list the next hello sends (the mod hashes with the list of its current connection). */
  setVolatile(v: VolatileList): void {
    this.opts.volatile = v;
  }

  /** The game folder the next connection reads the pairing file from. */
  setInstanceDir(dir: string): void {
    this.opts.instanceDir = dir;
  }

  get instanceDir(): string {
    return this.opts.instanceDir;
  }

  /** Closes the connection and stops reconnecting. */
  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.socket?.destroy();
  }

  request(m: Req<HashesRequest>): Promise<HashesResult>;
  request(m: Req<SnapshotRequest>): Promise<SnapshotResult>;
  request(m: Req<PatchMessage>): Promise<PatchAck>;
  request(m: Req<VolumesExtend>): Promise<VolumesMessage>;
  request(m: Req<HashesRequest | SnapshotRequest | PatchMessage | VolumesExtend>): Promise<ModMessage> {
    if (!this.connected) return Promise.reject(new BridgeError(DOWN, "The game isn't connected (the world link is down); nothing was sent."));
    const id = this.nextId++;
    const expect: ModType = m.type === "hashes" ? "hashes.result" : m.type === "snapshot" ? "snapshot.result" : m.type === "patch" ? "patch.ack" : "volumes";
    return new Promise<ModMessage>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, expect });
      if (m.type === "volumes.extend") this.extending.push(id);
      this.write({ ...m, id } as McpMessage);
    });
  }

  send(m: NoticeMessage | ChatMessage | PromptResult): void {
    if (this.connected) this.write(m);
  }

  on<T extends ModType>(type: T, fn: (m: ModOf<T>) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    const f = fn as (m: ModMessage) => void;
    set.add(f);
    return () => void set.delete(f);
  }

  onConnection(fn: (state: "up" | "down", why?: string) => void): () => void {
    this.connListeners.add(fn);
    return () => void this.connListeners.delete(fn);
  }

  // -- internals ------------------------------------------------------------------------------

  private open(p: Pairing): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const s = netConnect({ host: p.host, port: p.port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(unreachable(p, this.opts.instanceDir, "timed out"));
      }, this.opts.connectTimeoutMs ?? 5000);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve(s);
      });
      s.once("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(unreachable(p, this.opts.instanceDir, e.code ?? e.message));
      });
    });
  }

  private handshake(s: Socket, p: Pairing): Promise<ModHello> {
    const reader = new FrameReader();
    return new Promise<ModHello>((resolve, reject) => {
      let done = false;
      const fail = (e: Error) => {
        if (done) return;
        done = true;
        s.destroy();
        reject(e);
      };
      s.on("data", (chunk: Buffer) => {
        let frames: Uint8Array[];
        try {
          frames = reader.push(chunk);
        } catch (e) {
          // A frame length out of range: the stream can't be resynchronised (Framing), so close.
          this.opts.log?.(`world: the mod sent a malformed frame: ${(e as Error).message}`);
          if (done) s.destroy();
          return fail(new BridgeError(DOWN, `The mod sent a malformed frame: ${(e as Error).message}`));
        }
        for (const f of frames) {
          let m: ModMessage;
          try {
            m = decodeMessage(f, "mod");
          } catch (e) {
            this.opts.log?.(`world: dropped a malformed message from the mod: ${(e as Error).message}`);
            continue;
          }
          if (!done) {
            if (m.type === "error") return fail(new BridgeError(m.code === "protocol_mismatch" ? "protocol_mismatch" : DOWN, handshakeError(m)));
            if (m.type !== "hello") return fail(new BridgeError(DOWN, `The mod answered the hello with ${m.type}.`));
            if (m.protocol !== PROTOCOL_VERSION) return fail(new BridgeError("protocol_mismatch", `The mod speaks bridge protocol ${m.protocol} and this Autosketch speaks ${PROTOCOL_VERSION}: update the ${m.protocol > PROTOCOL_VERSION ? "Autosketch MCP server" : "Autosketch mod"}.`));
            done = true;
            this.socket = s;
            this.hello = m;
            this.retryMs = this.opts.backoff?.minMs ?? 500;
            for (const fn of this.connListeners) safe(() => fn("up"), this.opts.log);
            resolve(m);
            continue;
          }
          this.dispatch(m);
        }
      });
      s.on("error", (e) => fail(unreachable(p, this.opts.instanceDir, (e as NodeJS.ErrnoException).code ?? e.message)));
      s.on("close", () => {
        if (!done) return fail(new BridgeError(DOWN, "The mod closed the connection during the handshake."));
        if (this.socket === s) this.lost("connection closed");
      });
      this.writeTo(s, { type: "hello", protocol: PROTOCOL_VERSION, token: p.token, client: this.opts.client ?? { name: "autosketch", version: "1.0.0" }, volatile: this.opts.volatile });
    });
  }

  private dispatch(m: ModMessage): void {
    if (m.type === "volumes") this.volumes = m;
    if (m.type === "error") {
      if (m.id !== null) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          const i = this.extending.indexOf(m.id);
          if (i >= 0) this.extending.splice(i, 1);
          p.reject(new BridgeError(m.code, m.message));
        }
      } else {
        this.opts.log?.(`world: the mod reported ${m.code}: ${m.message}`);
        // Another Autosketch took the connection over: don't fight it for the socket.
        if (m.code === "replaced") this.closed = true;
      }
    } else if (m.type === "volumes" && m.work !== null && m.extended && this.extending.length) {
      const id = this.extending.shift()!;
      const p = this.pending.get(id);
      this.pending.delete(id);
      p?.resolve(m);
    } else if ("id" in m && m.type !== "prompt") {
      const p = this.pending.get(m.id);
      if (p && p.expect === m.type) {
        this.pending.delete(m.id);
        p.resolve(m);
      }
    }
    for (const fn of this.listeners.get(m.type) ?? []) safe(() => fn(m), this.opts.log);
  }

  private lost(why: string): void {
    this.socket = undefined;
    this.hello = undefined;
    this.volumes = undefined;
    for (const [, p] of this.pending) p.reject(new BridgeError(DOWN, `The game disconnected (${why}); the request was dropped.`));
    this.pending.clear();
    this.extending.length = 0;
    for (const fn of this.connListeners) safe(() => fn("down", why), this.opts.log);
    if (!this.closed && this.opts.reconnect !== false) this.scheduleRetry();
  }

  private scheduleRetry(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.closed) return;
      this.connect().catch(() => {
        this.retryMs = Math.min(this.retryMs * 2, this.opts.backoff?.maxMs ?? 10_000);
        this.scheduleRetry();
      });
    }, this.retryMs);
    this.retryTimer.unref?.();
  }

  private write(m: McpMessage): void {
    if (this.socket) this.writeTo(this.socket, m);
  }

  private writeTo(s: Socket, m: McpMessage): void {
    if (!s.destroyed) s.write(encodeMessage(m));
  }
}

function unreachable(p: Pairing, instanceDir: string, why: string): BridgeError {
  return new BridgeError(
    DOWN,
    `Can't reach the game at ${p.host}:${p.port} (port from ${pairingPath(instanceDir)}; ${why}). Is the world still open? ` +
      `If the game runs on Windows and Autosketch in WSL2, WSL needs mirrored networking to reach the game's loopback port: set networkingMode=mirrored under [wsl2] in %UserProfile%\\.wslconfig, then run wsl --shutdown.`,
  );
}

function handshakeError(m: ErrorMessage): string {
  if (m.code === "bad_token") return "The mod refused the pairing token: the pairing file is stale (the game restarted?). Try again.";
  if (m.code === "protocol_mismatch") return `The mod speaks bridge protocol ${m.protocol ?? "?"} and this Autosketch speaks ${PROTOCOL_VERSION}: update the older side.`;
  return `The mod refused the connection (${m.code}): ${m.message}`;
}

function safe(fn: () => void, log?: (msg: string) => void): void {
  try {
    fn();
  } catch (e) {
    log?.(`world: listener failed: ${(e as Error).message}`);
  }
}
