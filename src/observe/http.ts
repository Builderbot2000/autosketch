import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoggedEvent } from "../core/events.js";
import type { Document } from "../document/document.js";
import type { BlockBaker } from "../perception/render/bake.js";
import { Atlas, bakeModels } from "./atlas.js";
import type { EventBus } from "./bus.js";
import type { DeltaWriter } from "./deltas.js";
import type { LogTables } from "./states.js";
import { encodeVoxels, parseBoxParam } from "./voxels.js";

/**
 * The live viewer's HTTP server (docs/design/12-observability.md, *Live viewer*). Loopback only,
 * off unless `observe.http` is set. It serves the static bundle in `viewer/` and:
 *
 *   GET /events?since=<seq>        SSE: buffered events after `since`, then live
 *   GET /doc/<doc>/snapshot        voxels of a document ("base" or a scope id), see voxels.ts
 *   GET /doc/<doc>/region?box=x0,y0,z0,x1,y1,z1   voxels of one inclusive local box
 *   GET /assets/atlas.png          texture atlas from the user's instance (atlas.ts)
 *   GET /assets/models.json        baked block models keyed by log-wide state id
 *   GET /log/deltas?offset&length  raw deltas.bin records
 *   GET /info                      session id, current document, latest seq, what is available
 *
 * Nothing here is on the tool-call path. The bus subscriber only appends to a ring buffer and
 * schedules a write to the clients; a client whose socket backs up stops receiving events and,
 * once drained, gets `event: resync` with the latest seq, so it refetches the snapshot. When a
 * client asks for events older than the buffer, it gets `resync` first as well. No tool reads any
 * of this.
 */

export interface ObserveHttpOptions {
  bus: EventBus;
  tables: LogTables;
  sessionId: string;
  /** Session folder for a document name (the `url` file is written there). */
  dirFor: (name: string) => string;
  /** The document behind a `doc` tag ("base" or a scope id). */
  docFor: (doc: string) => Document | undefined;
  getBaker?: () => Promise<BlockBaker>;
  deltas?: DeltaWriter;
  /** 0 for a free port. */
  port: number;
  version?: string;
  viewerDir?: string;
  /** Events kept for `since` replays. */
  bufferEvents?: number;
  /** Unsent bytes past which a client is dropped until it drains, then resynced. */
  maxClientBacklog?: number;
  log?: (msg: string) => void;
}

interface Client {
  res: ServerResponse;
  lagging: boolean;
}

const DEFAULT_VIEWER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "viewer");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export class ObserveHttp {
  url?: string;
  private server?: Server;
  private ring: LoggedEvent[] = [];
  private readonly clients = new Set<Client>();
  private pending: string[] = [];
  private scheduled = false;
  private ping?: NodeJS.Timeout;
  private readonly atlas = new Atlas();
  private readonly urlWritten = new Set<string>();

  constructor(private readonly opts: ObserveHttpOptions) {}

  /** Bus subscriber: buffers and schedules; never writes to a socket synchronously. */
  readonly onEvent = (e: LoggedEvent): void => {
    this.ring.push(e);
    const cap = this.opts.bufferEvents ?? 50_000;
    if (this.ring.length > cap * 1.25) this.ring = this.ring.slice(this.ring.length - cap);
    if (e.kind === "session.open") void this.writeUrl(e.name);
    if (!this.clients.size) return;
    this.pending.push(sse(e));
    if (!this.scheduled) {
      this.scheduled = true;
      setImmediate(() => this.send());
    }
  };

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e: Error) => {
        if (!res.headersSent) json(res, 500, { error: e.message });
        else res.end();
      });
    });
    this.server = server;
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(this.opts.port, "127.0.0.1", () => ok());
    });
    const port = (server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${port}/`;
    this.ping = setInterval(() => {
      for (const c of this.clients) if (!c.lagging) c.res.write(": ping\n\n");
    }, 15_000);
    this.ping.unref();
    this.opts.log?.(`observe: viewer at ${this.url}`);
    const current = this.opts.tables.current;
    if (current) void this.writeUrl(current);
    return this.url;
  }

  async close(): Promise<void> {
    if (this.ping) clearInterval(this.ping);
    for (const c of this.clients) c.res.end();
    this.clients.clear();
    const s = this.server;
    if (!s) return;
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }

  private send(): void {
    this.scheduled = false;
    const data = this.pending.join("");
    this.pending = [];
    if (!data) return;
    for (const c of this.clients) {
      if (c.lagging) continue;
      c.res.write(data);
      if (c.res.writableLength > (this.opts.maxClientBacklog ?? 4 * 1024 * 1024)) {
        c.lagging = true;
        c.res.once("drain", () => {
          c.lagging = false;
          c.res.write(`event: resync\ndata: ${JSON.stringify({ seq: this.opts.bus.lastSeq })}\n\n`);
        });
      }
    }
  }

  private async writeUrl(name: string): Promise<void> {
    if (!this.url || this.urlWritten.has(name)) return;
    this.urlWritten.add(name);
    const dir = this.opts.dirFor(name);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "url"), this.url + "\n");
    } catch (e) {
      this.opts.log?.(`observe: writing ${join(dir, "url")} failed: ${(e as Error).message}`);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Loopback only, and only for pages addressed to it: refuses DNS-rebinding requests.
    if (!allowedHost(req.headers.host)) return json(res, 403, { error: "forbidden host" });
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "GET only" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/events") return this.events(url, req, res);
    if (path === "/info") return this.info(res);
    const doc = /^\/doc\/([^/]+)\/(snapshot|region)$/.exec(path);
    if (doc) return this.voxels(decodeURIComponent(doc[1]!), doc[2] as "snapshot" | "region", url, res);
    if (path === "/assets/models.json") return this.models(url, res);
    if (path === "/assets/atlas.png") {
      if (!this.opts.getBaker) return json(res, 404, { error: "no instance assets" });
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      return void res.end(this.atlas.encode());
    }
    if (path === "/log/deltas") return this.deltas(url, res);
    return this.static(path, res);
  }

  private events(url: URL, req: IncomingMessage, res: ServerResponse): void {
    // EventSource sends Last-Event-ID when it reconnects; it wins over the original `since`.
    const since = Math.max(Number(url.searchParams.get("since") ?? 0) || 0, Number(req.headers["last-event-id"] ?? 0) || 0);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    const first = this.ring[0]?.seq ?? this.opts.bus.lastSeq + 1;
    let out = "retry: 2000\n\n";
    if (since + 1 < first) out += `event: resync\ndata: ${JSON.stringify({ seq: this.opts.bus.lastSeq, from: first })}\n\n`;
    for (const e of this.ring) if (e.seq > since) out += sse(e);
    res.write(out);
    const client: Client = { res, lagging: false };
    this.clients.add(client);
    req.on("close", () => this.clients.delete(client));
  }

  private info(res: ServerResponse): void {
    const d = this.opts.deltas;
    json(res, 200, {
      session: this.opts.sessionId,
      version: this.opts.version,
      doc: this.opts.tables.current ?? null,
      seq: this.opts.bus.lastSeq,
      deltas: d ? { on: true, capped: d.capped, bytes: d.bytes } : { on: false },
      assets: !!this.opts.getBaker,
    });
  }

  private voxels(tag: string, kind: "snapshot" | "region", url: URL, res: ServerResponse): void {
    const doc = this.opts.docFor(tag);
    const table = this.opts.tables.table();
    if (!doc || !table) return json(res, 404, { error: tag === "base" ? "no document is open" : `document "${tag}" is not available` });
    let box;
    if (kind === "region") {
      box = parseBoxParam(url.searchParams.get("box"));
      if (!box) return json(res, 400, { error: "box must be x0,y0,z0,x1,y1,z1 (inclusive integers)" });
    }
    const parts = encodeVoxels(doc, tag, table, this.opts.bus.lastSeq, box);
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
    for (const p of parts) res.write(p);
    res.end();
  }

  private async models(url: URL, res: ServerResponse): Promise<void> {
    if (!this.opts.getBaker) return json(res, 404, { error: "no instance assets" });
    const table = this.opts.tables.table();
    const baker = await this.opts.getBaker();
    const want = url.searchParams.get("ids")?.split(",").map(Number);
    const all = table ? table.states.map((s, i) => [i, s] as const) : [];
    const states = want ? all.filter(([i]) => want.includes(i)) : all;
    json(res, 200, await bakeModels(baker, this.atlas, states));
  }

  private async deltas(url: URL, res: ServerResponse): Promise<void> {
    const d = this.opts.deltas;
    const name = this.opts.tables.current;
    if (!d || name === undefined) return json(res, 404, { error: "deltas are off (observe.deltas)" });
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const length = Number(url.searchParams.get("length") ?? d.size(name) - offset);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset % 16 || length % 16 || length > 256 * 1024 * 1024)
      return json(res, 400, { error: "offset and length must be non-negative multiples of 16 (length at most 256 MB)" });
    const buf = await d.read(name, offset, length);
    res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
    res.end(buf);
  }

  private async static(path: string, res: ServerResponse): Promise<void> {
    const root = this.opts.viewerDir ?? DEFAULT_VIEWER;
    const rel = normalize(decodeURIComponent(path === "/" ? "/index.html" : path)).replace(/^([/\\])+/, "");
    const file = resolve(root, rel);
    if (!file.startsWith(resolve(root) + sep)) return json(res, 404, { error: "not found" });
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      return json(res, 404, { error: "not found" });
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  }
}

const sse = (e: LoggedEvent): string => `id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function allowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}
