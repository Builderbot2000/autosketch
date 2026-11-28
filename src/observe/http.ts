import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ObserveEvent } from "../core/events.js";
import { allowedHost, BodyTooLarge, foreignOrigin, readBody } from "./guard.js";
import { MAX_OTLP_BYTES, otlpRecords } from "./otel.js";
import { TURN_END_PATH } from "./turn-hook.js";

/**
 * The OTLP receiver (docs/design/13-live-world.md, *Backlog* B3; `16`, *What goes, what stays, what
 * moves*): Claude Code's telemetry export can only post over HTTP, so this is the one HTTP endpoint
 * left once the browser UI went. The turn-end hook (`19`, *When a request has concluded*) posts here too.
 *
 *   POST /v1/logs             Claude Code's OTLP/HTTP JSON log events; each record becomes an `otel` event
 *   POST /v1/hooks/turn-end   the plugin's `Stop` hook; with the port file's bearer token, one `turn.end` event
 *
 * Loopback only, on `observe.http`'s port. Nothing here writes anything but the session's log: the
 * request comes from Claude Code's exporter, not a page, so it needs no token. It takes JSON only
 * (so a cross-origin page can't send it without a preflight, which is never approved) and `guard.ts`
 * refuses a foreign `Origin` or `Host`. The turn-end route changes request state (`19`), so it also
 * needs the token from the port file (`turn-hook.ts`); a wrong or missing token gets 403 and no event.
 * Nothing here is on the tool-call path.
 */

export interface ObserveHttpOptions {
  /** 0 for a free port. */
  port: number;
  /** Listen on a free port when `port` is taken (only for the default port, never one the user set). */
  fallbackToFreePort?: boolean;
  /** Appends an event to the session's log (the `otel` events of `/v1/logs`). */
  publish: (e: ObserveEvent) => void;
  /** The bearer token `POST /v1/hooks/turn-end` requires; without one the route doesn't exist (404). */
  turnEndToken?: string;
  now?: () => number;
  log?: (msg: string) => void;
}

/** Largest turn-end body accepted (the hook sends a few fields). */
const MAX_HOOK_BYTES = 4096;

export class ObserveHttp {
  /** `http://127.0.0.1:<port>/` once listening. */
  url?: string;
  /** Log records received at /v1/logs. */
  otelRecords = 0;
  /** Valid turn-end pings received, and when the last one arrived (epoch ms). */
  turnEnds = 0;
  lastTurnEnd?: number;
  port = 0;
  private server?: Server;
  private warnedProtobuf = false;

  constructor(private readonly opts: ObserveHttpOptions) {}

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e: Error) => {
        if (!res.headersSent) json(res, 500, { error: e.message });
        else res.end();
      });
    });
    this.server = server;
    const listen = (port: number) =>
      new Promise<void>((ok, fail) => {
        const onError = (e: Error) => fail(e);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", onError);
          ok();
        });
      });
    try {
      await listen(this.opts.port);
    } catch (e) {
      if (!this.opts.fallbackToFreePort || this.opts.port === 0 || (e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
      this.opts.log?.(`observe: port ${this.opts.port} is taken; using a free port (Claude Code's token telemetry won't reach this session)`);
      await listen(0);
    }
    this.port = (server.address() as AddressInfo).port;
    this.url = `http://127.0.0.1:${this.port}/`;
    this.opts.log?.(`observe: receiving Claude Code's telemetry at ${this.url}v1/logs`);
    return this.url;
  }

  async close(): Promise<void> {
    const s = this.server;
    if (!s) return;
    await new Promise<void>((ok) => s.close(() => ok()));
    s.closeAllConnections?.();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Loopback only, and only for requests addressed to it: refuses DNS-rebinding requests.
    if (!allowedHost(req.headers.host)) return json(res, 403, { error: "forbidden host" });
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const turnEnd = path === TURN_END_PATH && !!this.opts.turnEndToken;
    if (path !== "/v1/logs" && !turnEnd) return json(res, 404, { error: "no such endpoint" });
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    // Claude Code's exporter and hook send no Origin; a page would, and a foreign one is refused.
    if (foreignOrigin(req.headers.origin, this.port)) return json(res, 403, { error: "foreign Origin" });
    if (turnEnd) return this.turnEnd(req, res);
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
    for (const record of records) this.opts.publish({ kind: "otel", record });
    this.otelRecords += records.length;
    json(res, 200, {});
  }

  /** `POST /v1/hooks/turn-end` (`19`): bearer token, then an optional JSON body `{reason?, session?}`. */
  private async turnEnd(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    if (!bearer || !tokenMatches(bearer, this.opts.turnEndToken!)) {
      req.resume();
      return json(res, 403, { error: "bad token" });
    }
    let body: { reason?: unknown; session?: unknown } = {};
    try {
      const raw = (await readBody(req, MAX_HOOK_BYTES)).toString("utf8").trim();
      if (raw) body = JSON.parse(raw) as typeof body;
    } catch (e) {
      return json(res, e instanceof BodyTooLarge ? 413 : 400, { error: (e as Error).message });
    }
    const at = (this.opts.now ?? Date.now)();
    const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v.slice(0, 100) : undefined);
    const reason = str(body?.reason);
    const session = str(body?.session);
    this.opts.publish({ kind: "turn.end", at, ...(reason ? { reason } : {}), ...(session ? { session } : {}) });
    this.turnEnds++;
    this.lastTurnEnd = at;
    json(res, 200, {});
  }
}

/** Constant-time token comparison. */
function tokenMatches(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}
