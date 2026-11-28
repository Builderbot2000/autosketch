import type { IncomingMessage } from "node:http";
import { createGunzip } from "node:zlib";

/**
 * Request checks for the OTLP receiver and the turn-end route (`http.ts`; `16`, *What goes, what
 * stays, what moves*; `19`). Loopback binding and the Host check stop DNS rebinding; the Origin check
 * stops another page open in the user's browser (which can send requests to `127.0.0.1`) from
 * posting. The log needs nothing more; the turn-end route also needs the port file's token.
 */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Whether a request's `Host` names this machine's loopback (any port). */
export function allowedHost(host: string | undefined): boolean {
  if (!host) return false;
  return LOOPBACK.has(host.replace(/:\d+$/, ""));
}

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

/** True for a request that carries an `Origin` other than this server's own (none at all is fine: Claude Code's exporter sends none). */
export function foreignOrigin(origin: string | string[] | undefined, port: number): boolean {
  const o = Array.isArray(origin) ? origin[0] : origin;
  return o !== undefined && !ownOrigin(o, port);
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
