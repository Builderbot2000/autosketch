import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createGunzip } from "node:zlib";

/**
 * Write guard for the management UI (docs/design/15-management-ui.md, *Security*). Loopback
 * binding and the Host check (http.ts) stop DNS rebinding, but not a cross-origin request from
 * another page open in the user's browser. So every request that changes something must:
 *
 *   - use POST, PUT or DELETE (GET stays side-effect free),
 *   - carry the per-launch token as `X-Autosketch-Token` (a custom header can't be sent
 *     cross-origin without a preflight, which this server never approves),
 *   - carry an `Origin` that is this server's own.
 *
 * The token is made at start and handed to the page in the URL fragment (`…/#t=<token>`), which
 * browsers never send to a server.
 */

export const TOKEN_HEADER = "x-autosketch-token";

export const WRITE_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "DELETE"]);

export const newToken = (): string => randomBytes(24).toString("base64url");

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Whether `origin` is this server's own (a loopback name on `port`). */
export function ownOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  return u.protocol === "http:" && LOOPBACK.has(u.hostname) && Number(u.port || 80) === port && origin.replace(/\/$/, "") === u.origin;
}

/** Why a changing request is refused, or undefined when it may go ahead. */
export function refuseWrite(req: IncomingMessage, token: string, port: number): string | undefined {
  if (!WRITE_METHODS.has(req.method ?? "")) return "changes need POST, PUT or DELETE";
  if (!ownOrigin(header(req, "origin"), port)) return "foreign or missing Origin";
  const given = header(req, TOKEN_HEADER);
  if (!given || !sameText(given, token)) return "missing or wrong token: open the link the server printed (it ends in #t=…)";
  return undefined;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A request body too large to accept (answered 413). */
export class BodyTooLarge extends Error {}

/** Reads a request body up to `limit` bytes (after gunzip when `Content-Encoding: gzip`). */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const gzip = /gzip/i.test(String(req.headers["content-encoding"] ?? ""));
    const src = gzip ? req.pipe(createGunzip()) : req;
    const chunks: Buffer[] = [];
    let size = 0;
    src.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        src.destroy();
        req.resume();
        fail(new BodyTooLarge(`body over ${limit} bytes`));
      } else chunks.push(c);
    });
    src.on("end", () => ok(Buffer.concat(chunks)));
    src.on("error", fail);
  });
}
