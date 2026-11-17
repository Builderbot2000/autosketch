/**
 * A fake MCP (docs/design/16-in-game-ui.md, *Testing*; docs/briefs/ui/C-contracts.md): plays the
 * MCP's side of the bridge (docs/design/13-live-world.md, *Wire format*) against the real mod, or
 * against the fake host. It reads a pairing file, says hello with a chosen feature list (so a test
 * can play an MCP that's too old, without `ui`), sends scripted messages, answers `ui.request`s from
 * a table, and records everything the mod sends.
 *
 * Library: `await FakeMcp.connect({ pairing, script })`, then `send`, `waitFor`, `received`, `close`.
 *
 * CLI, for the client test harness:
 *
 *   tsx test/support/fake-mcp.ts --pairing <autosketch-bridge.toml> --script <json> [--record <jsonl>] [--exit-on-close]
 *
 * It waits for the pairing file, connects, and keeps the connection until SIGTERM or SIGINT. When
 * the mod closes the connection it reconnects (the pairing file may have changed), unless
 * `--exit-on-close`. `--record` writes one JSON line per message received: `{"t": ms since the
 * first connect, "message": <decoded message>}`, bodies included (byte arrays as base64, index
 * arrays as JSON arrays). Logs go to stderr only.
 *
 * Script (JSON, every key optional):
 *
 *   { "hello":   { "features": ["prompt.close", "ui"], "modes": ["ask", "scan", "plan", "build"] },
 *     "send":    [ <message>, … ],                                   sent once after each handshake
 *     "replies": [ { "on": "<type>", "kind"?: "<ui.request kind>", "send": <message> | [<message>, …] } ],
 *     "results": { "<ui.request kind>": { "ok": true, "result": {…}, "bodyBase64"?: "…" }
 *                                     | { "ok": false, "error": "<code>", "message": "…" } } }
 *
 * A <message> is the codec's message object (`src/world/protocol/messages.ts`) as JSON, with these
 * conveniences: in `ui.ghost` sections and `replay.frame` regions, `"fill": "<palette state>"` in
 * place of `states` fills the whole section or box with that state, and `states` may be a plain array;
 * a `ui.result`'s binary body is `bodyBase64`. `request` and `player` of a reply to a `ui.request` are
 * filled in from the request when absent. A `ui.request` with no reply or result gets
 * `bad_request` ("the fake MCP has no scripted result for <kind>"), so a client never waits forever.
 */
import { readFile, writeFile, appendFile } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import { decodeMessage, encodeMessage } from "../../src/world/protocol/codec.js";
import { FrameReader } from "../../src/world/protocol/frame.js";
import { DEFAULT_VOLATILE } from "../../src/world/protocol/hash.js";
import { PROTOCOL_VERSION, REQUEST_MODES, type McpMessage, type ModHello, type ModMessage, type RequestMode, type UiRequest, type WireBox } from "../../src/world/protocol/messages.js";
import { parsePairing } from "../../src/world/protocol/pairing.js";

export interface FakeMcpScript {
  hello?: { features?: string[]; modes?: RequestMode[] };
  send?: unknown[];
  replies?: { on: string; kind?: string; send: unknown }[];
  results?: Record<string, { ok: true; result?: Record<string, unknown>; bodyBase64?: string } | { ok: false; error: string; message?: string }>;
}

export interface FakeMcpOptions {
  /** The pairing file (`<instance>/config/autosketch-bridge.toml`). */
  pairing: string;
  script?: FakeMcpScript;
  /** Called with every message received, decoded. */
  onMessage?: (m: ModMessage) => void;
  log?: (msg: string) => void;
}

/** The default hello: every MCP feature this fake plays, including `16`'s `ui`. */
export const FAKE_MCP_FEATURES = ["prompt.close", "ui"];

export class FakeMcp {
  /** Every message received from the mod, in order (the mod's hello first). */
  readonly received: ModMessage[] = [];
  /** Every message sent. */
  readonly sent: McpMessage[] = [];
  hello: ModHello | undefined;
  private socket?: Socket;
  private closed = false;

  private constructor(private readonly opts: FakeMcpOptions) {}

  /** Connects and completes the handshake. Rejects when the mod refuses it. */
  static async connect(opts: FakeMcpOptions): Promise<FakeMcp> {
    const f = new FakeMcp(opts);
    await f.open();
    return f;
  }

  get connected(): boolean {
    return this.socket !== undefined && !this.socket.destroyed;
  }

  get features(): string[] {
    return this.opts.script?.hello?.features ?? FAKE_MCP_FEATURES;
  }

  /** Sends one message, given as the codec's message object or the script's JSON form. */
  send(m: McpMessage | Record<string, unknown>): void {
    const msg = toMessage(m);
    this.sent.push(msg);
    if (this.connected) this.socket!.write(encodeMessage(msg));
  }

  /** Waits until `pred` holds over the received messages. */
  async waitFor<T>(pred: (received: ModMessage[]) => T | undefined | false, timeoutMs = 5000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = pred(this.received);
      if (v !== undefined && v !== false) return v;
      if (Date.now() > end) throw new Error("fake MCP: timed out waiting");
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** The `ui.request`s received so far. */
  get uiRequests(): UiRequest[] {
    return this.received.filter((m): m is UiRequest => m.type === "ui.request");
  }

  /** Connects again (after the mod closed the connection, or to play a restarted MCP). */
  async open(): Promise<ModHello> {
    this.closed = false;
    const p = parsePairing(await readFile(this.opts.pairing, "utf8"));
    const s = netConnect({ host: p.host, port: p.port });
    s.setNoDelay(true);
    const reader = new FrameReader();
    return new Promise((resolve, reject) => {
      let done = false;
      s.on("error", (e) => {
        if (!done) reject(e);
      });
      s.on("close", () => {
        if (!done) reject(new Error("fake MCP: the mod closed the connection during the handshake"));
        if (this.socket === s) this.socket = undefined;
        this.onClose?.();
      });
      s.on("data", (chunk: Buffer) => {
        for (const frame of reader.push(new Uint8Array(chunk))) {
          let m: ModMessage;
          try {
            m = decodeMessage(frame, "mod");
          } catch (e) {
            this.opts.log?.(`fake MCP: dropped a malformed message: ${(e as Error).message}`);
            continue;
          }
          this.received.push(m);
          this.opts.onMessage?.(m);
          if (!done) {
            if (m.type !== "hello") {
              done = true;
              s.destroy();
              return reject(new Error(`fake MCP: the mod answered the hello with ${m.type}${m.type === "error" ? ` ${m.code}: ${m.message}` : ""}`));
            }
            done = true;
            this.hello = m;
            this.socket = s;
            for (const x of this.opts.script?.send ?? []) this.send(x as Record<string, unknown>);
            resolve(m);
            continue;
          }
          this.react(m);
        }
      });
      const h = this.opts.script?.hello;
      const hello: McpMessage = {
        type: "hello",
        protocol: p.protocol === PROTOCOL_VERSION - 1 ? p.protocol : PROTOCOL_VERSION,
        token: p.token,
        client: { name: "fake-mcp", version: "1.0.0" },
        volatile: DEFAULT_VOLATILE,
        modes: h?.modes ?? [...REQUEST_MODES],
        features: this.features,
      };
      this.sent.push(hello);
      s.write(encodeMessage(hello));
    });
  }

  /** Called when the connection closes (the CLI reconnects from here). */
  onClose?: () => void;

  close(): void {
    this.closed = true;
    this.socket?.destroy();
    this.socket = undefined;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Replies from the script, then the results table for `ui.request`s. */
  private react(m: ModMessage): void {
    const script = this.opts.script ?? {};
    const req = m.type === "ui.request" ? m : undefined;
    let answered = false;
    for (const r of script.replies ?? []) {
      if (r.on !== m.type || (r.kind !== undefined && r.kind !== req?.kind)) continue;
      for (const out of Array.isArray(r.send) ? r.send : [r.send]) {
        const o = { ...(out as Record<string, unknown>) };
        if (req && o.type === "ui.result") {
          o.request ??= req.request;
          o.player ??= req.player.uuid;
          answered = true;
        }
        this.send(o);
      }
    }
    if (!req || answered) return;
    const res = script.results?.[req.kind];
    if (res?.ok) this.send({ type: "ui.result", request: req.request, player: req.player.uuid, ok: true, result: res.result ?? {}, ...(res.bodyBase64 ? { bodyBase64: res.bodyBase64 } : {}) });
    else if (res) this.send({ type: "ui.result", request: req.request, player: req.player.uuid, ok: false, error: res.error, message: res.message ?? res.error });
    else this.send({ type: "ui.result", request: req.request, player: req.player.uuid, ok: false, error: "bad_request", message: `the fake MCP has no scripted result for ${req.kind}` });
  }
}

/** The script's JSON form of a message to the codec's message object (see the file comment). */
export function toMessage(raw: McpMessage | Record<string, unknown>): McpMessage {
  const m = { ...(raw as Record<string, any>) };
  const indices = (v: unknown, n: number, palette: string[], fill: unknown, what: string): Uint32Array => {
    if (v instanceof Uint32Array) return v;
    if (Array.isArray(v)) return Uint32Array.from(v as number[]);
    if (typeof fill === "string") {
      const i = palette.indexOf(fill);
      if (i < 0) throw new Error(`fake MCP: ${what} fills with "${fill}", which isn't in the palette`);
      return new Uint32Array(n).fill(i);
    }
    throw new Error(`fake MCP: ${what} needs states or fill`);
  };
  if (m.type === "ui.ghost") m.sections = (m.sections as any[]).map((s, i) => ({ section: s.section, states: indices(s.states, 4096, m.palette, s.fill, `sections[${i}]`) }));
  if (m.type === "replay.frame" && m.keyframe)
    m.regions = (m.regions as any[]).map((r, i) => {
      const b = r.box as WireBox;
      const n = (b.max[0] - b.min[0] + 1) * (b.max[1] - b.min[1] + 1) * (b.max[2] - b.min[2] + 1);
      return { box: b, states: indices(r.states, n, m.palette, r.fill, `regions[${i}]`) };
    });
  if (m.type === "ui.result" && typeof m.bodyBase64 === "string") {
    m.body = new Uint8Array(Buffer.from(m.bodyBase64, "base64"));
    delete m.bodyBase64;
  }
  return m as McpMessage;
}

/** JSON for the record file: byte arrays as base64, index arrays as plain arrays. */
export function recordJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (x instanceof Uint32Array ? Array.from(x) : x instanceof Uint8Array ? Buffer.from(x).toString("base64") : x));
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const pairing = arg("--pairing");
  if (!pairing) {
    process.stderr.write("usage: fake-mcp --pairing <autosketch-bridge.toml> [--script <json>] [--record <jsonl>] [--exit-on-close]\n");
    process.exit(2);
  }
  const scriptPath = arg("--script");
  const script = scriptPath ? (JSON.parse(await readFile(scriptPath, "utf8")) as FakeMcpScript) : {};
  const record = arg("--record");
  const exitOnClose = argv.includes("--exit-on-close");
  const log = (msg: string) => process.stderr.write(`${new Date().toISOString()} ${msg}\n`);
  if (record) await writeFile(record, "");
  let t0: number | undefined;
  let writes = Promise.resolve();
  const onMessage = (m: ModMessage) => {
    log(`received ${m.type}${m.type === "ui.request" ? ` ${m.kind} #${m.request}` : ""}`);
    if (record) {
      const line = recordJson({ t: Date.now() - (t0 ?? Date.now()), message: m }) + "\n";
      writes = writes.then(() => appendFile(record, line));
    }
  };
  let mcp: FakeMcp | undefined;
  let stopping = false;
  const stop = () => {
    stopping = true;
    mcp?.close();
    void writes.finally(() => process.exit(0));
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  const attempt = async (): Promise<void> => {
    while (!stopping) {
      try {
        mcp = await FakeMcp.connect({ pairing, script, onMessage, log });
        t0 ??= Date.now();
        log(`paired (features ${mcp.features.join(", ") || "none"})`);
        mcp.onClose = () => {
          if (stopping) return;
          log("the mod closed the connection");
          if (exitOnClose) return stop();
          setTimeout(() => void attempt(), 500);
        };
        return;
      } catch (e) {
        log(`not connected yet: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  };
  await attempt();
}

if (process.argv[1] && /fake-mcp\.(ts|js)$/.test(process.argv[1])) void main(process.argv.slice(2));
