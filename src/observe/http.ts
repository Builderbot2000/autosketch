import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LoggedEvent, ObserveEvent } from "../core/events.js";
import { configPath } from "../core/config.js";
import type { Settings } from "../core/settings.js";
import type { Document } from "../document/document.js";
import type { BlockBaker } from "../perception/render/bake.js";
import { Atlas, bakeModels } from "./atlas.js";
import type { EventBus } from "./bus.js";
import { BodyTooLarge, newToken, ownOrigin, readBody, refuseWrite, WRITE_METHODS } from "./guard.js";
import { MAX_OTLP_BYTES, otelSetup, otlpRecords } from "./otel.js";
import { InstanceApi, type InstanceHost } from "./instance-api.js";
import { LibraryApi, type LibraryHost } from "./library-api.js";
import { SettingsApi, type ApiReply } from "./settings-api.js";
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
 *   GET /log/snapshots/<seq>.png   a time-lapse snapshot (replay's fallback when deltas were capped)
 *   GET /vendor/three/...          three.js from the installed package (build/ and examples/jsm/)
 *
 * The page is also the management UI (docs/design/15-management-ui.md): an app shell whose other
 * tabs are ESM modules under `viewer/js/tabs/`, loaded when first opened, talking to `/api/…`:
 *
 *   GET    /api/settings, PUT|DELETE /api/settings/<key>   settings-api.ts
 *   GET|PUT|DELETE /api/instance                            instance-api.ts
 *   /api/library/…                                          library-api.ts
 *   POST   /v1/logs                Claude Code's OTLP/HTTP JSON log events (13, B3; otel.ts)
 *
 * Every request that changes something goes through `guard.ts` (POST/PUT/DELETE only, the
 * per-launch token from the URL fragment, our own Origin). `/v1/logs` comes from Claude Code's
 * exporter, not a page, so it needs no token: it only appends to the log, takes JSON only (so a
 * cross-origin page can't send it without a preflight) and refuses any foreign Origin.
 *
 * The same server serves a finished log (`offline.ts`, `autosketch observe <path>`) with
 * `live: false`: the events come from the file, there is no document to read, and nothing is
 * written into the log folder.
 *
 * Nothing here is on the tool-call path. The bus subscriber only appends to a ring buffer and
 * schedules a write to the clients; a client whose socket backs up stops receiving events and,
 * once drained, gets `event: resync` with the latest seq, so it refetches the snapshot. When a
 * client asks for events older than the buffer, it gets `resync` first as well. No tool reads any
 * of this.
 */

/** Reads `deltas.bin` ranges: the live writer (`DeltaWriter`) or a finished file (`offline.ts`). */
export interface DeltaSource {
  readonly capped: boolean;
  readonly bytes: number;
  size(name: string): number;
  read(name: string, offset: number, length: number): Promise<Buffer>;
}

export interface ObserveHttpOptions {
  /** Only the latest seq is read; events arrive through `onEvent`. */
  bus: Pick<EventBus, "lastSeq">;
  tables: LogTables;
  sessionId: string;
  /** Session folder for a document name (the `url` file is written there). */
  dirFor: (name: string) => string;
  /** The document behind a `doc` tag ("base" or a scope id). */
  docFor: (doc: string) => Document | undefined;
  getBaker?: () => Promise<BlockBaker>;
  deltas?: DeltaSource;
  /** False for a finished log: no `url` file is written and `/info` says so. Default true. */
  live?: boolean;
  /** 0 for a free port. */
  port: number;
  version?: string;
  viewerDir?: string;
  /** Events kept for `since` replays. */
  bufferEvents?: number;
  /** Unsent bytes past which a client is dropped until it drains, then resynced. */
  maxClientBacklog?: number;
  log?: (msg: string) => void;
  /** The server's settings: enables the Settings tab's endpoints (15). Its config.toml snapshot names the file. */
  settings?: Settings;
  /** config.toml to read and write; defaults to the path of `settings.config`. Without either, settings are read-only. */
  configPath?: string;
  /** Appends an event to the session's log (the `otel` events of `/v1/logs`); absent for a finished log. */
  publish?: (e: ObserveEvent) => void;
  /** How often config.toml is polled for changes (default 1000 ms; tests shorten it). */
  configPollMs?: number;
  /** The per-launch write token; random by default. */
  token?: string;
  /** The session's instance, discovery and link: enables the Instance tab's endpoints (15). */
  instance?: InstanceHost;
  /** Library roots, thumbnails and the baker for previews: enables the Library tab's endpoints (15). */
  library?: LibraryHost;
}

interface Client {
  res: ServerResponse;
  lagging: boolean;
}

const DEFAULT_VIEWER = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "viewer");

/** The installed three.js package folder, or undefined when it can't be found. */
let threeRoot: string | undefined | null = null;
export function threeDir(): string | undefined {
  if (threeRoot === null) {
    try {
      // "three" resolves to build/three.cjs for require; package.json itself is not exported.
      threeRoot = dirname(dirname(createRequire(import.meta.url).resolve("three")));
    } catch {
      threeRoot = undefined;
    }
  }
  return threeRoot;
}
/** The parts of the three.js package the viewer may load. */
const THREE_PATHS = /^(build\/three\.(module|core)\.js|examples\/jsm\/[\w/-]+\.js)$/;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export class ObserveHttp {
  /** The server's base URL (`http://127.0.0.1:<port>/`). */
  url?: string;
  /** The URL to open and print: the base URL with the write token in its fragment (`#t=…`, 15 *Security*). */
  pageUrl?: string;
  readonly token: string;
  /** Log records received at /v1/logs. */
  otelRecords = 0;
  private port = 0;
  private readonly settingsApi?: SettingsApi;
  private readonly instanceApi?: InstanceApi;
  private readonly libraryApi?: LibraryApi;
  private server?: Server;
  private ring: LoggedEvent[] = [];
  private readonly clients = new Set<Client>();
  private pending: string[] = [];
  private scheduled = false;
  private ping?: NodeJS.Timeout;
  private readonly atlas = new Atlas();
  private readonly urlWritten = new Set<string>();

  constructor(private readonly opts: ObserveHttpOptions) {
    this.token = opts.token ?? newToken();
    const path = opts.configPath ?? opts.settings?.config?.path;
    if (opts.settings && path) this.settingsApi = new SettingsApi(opts.settings, path, opts.log ? { log: opts.log } : {});
    if (opts.instance) this.instanceApi = new InstanceApi(opts.instance, path ?? configPath(), opts.log);
    if (opts.library) this.libraryApi = new LibraryApi(opts.library, path ?? configPath(), this.atlas, opts.log);
  }

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
      this.handle(req, res).catch((e: Error & { status?: number }) => {
        if (!res.headersSent) json(res, e.status ?? 500, { error: e.message });
        else res.end();
      });
    });
    this.server = server;
    await new Promise<void>((ok, fail) => {
      server.once("error", fail);
      server.listen(this.opts.port, "127.0.0.1", () => ok());
    });
    const port = (server.address() as AddressInfo).port;
    this.port = port;
    this.url = `http://127.0.0.1:${port}/`;
    this.pageUrl = `${this.url}#t=${this.token}`;
    this.ping = setInterval(() => {
      for (const c of this.clients) if (!c.lagging) c.res.write(": ping\n\n");
    }, 15_000);
    this.ping.unref();
    this.settingsApi?.watch(this.opts.configPollMs);
    this.opts.log?.(`observe: viewer at ${this.pageUrl}`);
    const current = this.opts.tables.current;
    if (current) void this.writeUrl(current);
    return this.pageUrl;
  }

  /** Calls `fn` each time a changed config.toml is reloaded into the settings; a no-op without settings. */
  onSettingsReload(fn: () => void): () => void {
    return this.settingsApi?.onReload(fn) ?? (() => {});
  }

  async close(): Promise<void> {
    this.settingsApi?.close();
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
    if (this.opts.live === false || !this.pageUrl || this.urlWritten.has(name)) return;
    this.urlWritten.add(name);
    const dir = this.opts.dirFor(name);
    try {
      await mkdir(dir, { recursive: true });
      // With the token (15, *Security*): the folder is in the user's own workspace.
      await writeFile(join(dir, "url"), this.pageUrl + "\n");
    } catch (e) {
      this.opts.log?.(`observe: writing ${join(dir, "url")} failed: ${(e as Error).message}`);
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Loopback only, and only for pages addressed to it: refuses DNS-rebinding requests.
    if (!allowedHost(req.headers.host)) return json(res, 403, { error: "forbidden host" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const read = method === "GET" || method === "HEAD";
    if (path === "/v1/logs") return this.otlp(req, res);
    if (path === "/api" || path.startsWith("/api/")) {
      if (!read) {
        // Preflights (OPTIONS) and anything else fall through to 405 without CORS headers: never approved.
        if (!WRITE_METHODS.has(method)) return json(res, 405, { error: "changes need POST, PUT or DELETE" });
        const why = refuseWrite(req, this.token, this.port);
        if (why) return json(res, 403, { error: why });
      }
      return this.api(path.slice(4), method, req, res, url);
    }
    if (!read) return json(res, 405, { error: "GET only" });
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
    const snap = /^\/log\/snapshots\/(\d+\.png)$/.exec(path);
    if (snap) {
      const name = this.opts.tables.current;
      if (name === undefined) return json(res, 404, { error: "no document" });
      return this.file(join(this.opts.dirFor(name), "snapshots", snap[1]!), res);
    }
    if (path.startsWith("/vendor/three/")) {
      const rel = path.slice("/vendor/three/".length);
      const root = threeDir();
      if (!root || !THREE_PATHS.test(rel) || rel.includes("..")) return json(res, 404, { error: "not found" });
      return this.file(join(root, rel), res);
    }
    return this.static(path, res);
  }

  /**
   * `/api/…` (15, *Endpoints*); `rel` is the path after `/api`. Writes reach here only past the
   * guard. A GET never changes anything, so a GET of a write-only path is refused.
   */
  private async api(rel: string, method: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const read = method === "GET" || method === "HEAD";
    const settings = /^\/settings(?:\/([^/]+))?\/?$/.exec(rel);
    if (settings) {
      const api = this.settingsApi;
      if (!api) return json(res, 404, { error: "settings are not available here" });
      const key = settings[1] === undefined ? undefined : decodeURIComponent(settings[1]);
      if (key === undefined) return read ? json(res, 200, api.view()) : json(res, 405, { error: "change one setting at /api/settings/<key>" });
      if (method === "PUT") return reply(res, api.put(key, await jsonBody(req)));
      if (method === "DELETE") return reply(res, api.remove(key, await jsonBody(req)));
      return json(res, 405, { error: "PUT /api/settings/<key> {value} saves a setting; DELETE resets it" });
    }
    if (rel === "/instance" || rel === "/instance/") {
      const api = this.instanceApi;
      if (!api) return json(res, 404, { error: "the instance isn't available here" });
      if (read) return json(res, 200, await api.view(url.searchParams.has("refresh")));
      if (method === "PUT") return reply(res, await api.put(await jsonBody(req)));
      if (method === "DELETE") return reply(res, api.remove(await jsonBody(req)));
      return json(res, 405, { error: "PUT /api/instance {id | path} chooses an instance; DELETE unlinks it" });
    }
    if (rel === "/library" || rel.startsWith("/library/")) {
      const api = this.libraryApi;
      if (!api) return json(res, 404, { error: "the library isn't available here" });
      const sub = rel.slice("/library".length).replace(/^\/|\/$/g, "");
      if (!sub) return read ? json(res, 200, await api.view()) : json(res, 405, { error: "act on an entry at /api/library/<root>/<kind>/<name>/<action>" });
      const r = await api.handle(sub, method, url.searchParams, () => jsonBody(req));
      if ("data" in r) {
        res.writeHead(200, { "content-type": r.type, "cache-control": "no-cache" });
        return void res.end(r.data);
      }
      return reply(res, r);
    }
    return json(res, 404, { error: "no such endpoint" });
  }

  /** POST /v1/logs: an OTLP/HTTP JSON logs batch from Claude Code; each record becomes an `otel` event (13, B3). */
  private async otlp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    const publish = this.opts.publish;
    if (!publish || this.opts.live === false) return json(res, 404, { error: "not a live session" });
    // Claude Code's exporter sends no Origin; a page would, and a foreign one is refused.
    const origin = req.headers.origin;
    if (origin !== undefined && !ownOrigin(origin, this.port)) return json(res, 403, { error: "foreign Origin" });
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
      if (!this.warnedProtobuf) this.opts.log?.("observe: /v1/logs got a non-JSON batch; set OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json");
      this.warnedProtobuf = true;
      return json(res, 415, { error: "OTLP/HTTP JSON only: set OTEL_EXPORTER_OTLP_LOGS_PROTOCOL=http/json" });
    }
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req, MAX_OTLP_BYTES)).toString("utf8"));
    } catch (e) {
      return json(res, e instanceof BodyTooLarge ? 413 : 400, { error: (e as Error).message });
    }
    const records = otlpRecords(body);
    if (!records) return json(res, 400, { error: "not an OTLP logs request (resourceLogs[].scopeLogs[].logRecords[])" });
    for (const record of records) publish({ kind: "otel", record });
    this.otelRecords += records.length;
    json(res, 200, {});
  }

  private warnedProtobuf = false;

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
      live: this.opts.live !== false,
      version: this.opts.version,
      doc: this.opts.tables.current ?? null,
      seq: this.opts.bus.lastSeq,
      deltas: d ? { on: true, capped: d.capped, bytes: d.bytes } : { on: false },
      assets: !!this.opts.getBaker,
      settings: !!this.settingsApi,
      instance: !!this.instanceApi,
      library: !!this.libraryApi,
      // B3 (13): how many Claude Code log records have arrived, and the setup that sends them here.
      // A free port changes with every launch, so the endpoint only stays valid with a pinned `observe.http`.
      ...(this.opts.publish && this.opts.live !== false ? { otel: { records: this.otelRecords, portPinned: this.opts.port !== 0, setup: otelSetup(this.port) } } : {}),
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
    return this.file(file, res);
  }

  private async file(file: string, res: ServerResponse): Promise<void> {
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

function reply(res: ServerResponse, r: ApiReply): void {
  json(res, r.status, r.body);
}

/** A write's JSON body (`undefined` when empty). Throws a 400/413-shaped error otherwise. */
async function jsonBody(req: IncomingMessage): Promise<unknown> {
  let text: string;
  try {
    text = (await readBody(req, 1024 * 1024)).toString("utf8");
  } catch (e) {
    throw Object.assign(new Error((e as Error).message), { status: e instanceof BodyTooLarge ? 413 : 400 });
  }
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error("body must be JSON"), { status: 400 });
  }
}

function allowedHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}
