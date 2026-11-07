import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { refusalCode, type EventSink } from "../core/events.js";

/**
 * Tool-call events for the observability log (docs/design/12-observability.md, `call.start`,
 * `call.end`, `call.refused`). Wraps a tool handler: emits around it and returns its result
 * untouched, so nothing an agent sees depends on observability being on.
 */

/** Errors noted by the tool wrapper, so the refusal code survives the error becoming a result. */
const errors = new WeakMap<object, unknown>();

/** Remembers the error behind an error result (for `call.refused`). Returns the result unchanged. */
export function noteError<R extends object>(result: R, e: unknown): R {
  errors.set(result, e);
  return result;
}

let nextCall = 1;

export function observeCall<A extends unknown[]>(
  sink: () => EventSink,
  tool: string,
  handler: (...args: A) => Promise<CallToolResult>,
): (...args: A) => Promise<CallToolResult> {
  return async (...args: A) => {
    const events = sink();
    if (!events.enabled) return handler(...args);
    const call = nextCall++;
    const s = (args[0] as { scope?: unknown } | undefined)?.scope;
    const scope = typeof s === "string" ? { scope: s } : {};
    const t0 = performance.now();
    events.emit({ kind: "call.start", call, tool, ...scope });
    let result: CallToolResult | undefined;
    try {
      result = await handler(...args);
      return result;
    } finally {
      const ms = Math.round((performance.now() - t0) * 10) / 10;
      const size = result ? responseSize(result) : { chars: 0, images: 0, pixels: 0 };
      const ok = !!result && !result.isError;
      const err = result ? errors.get(result) : undefined;
      const code = err === undefined ? undefined : refusalCode(err);
      if (code) events.emit({ kind: "call.refused", call, tool, ...scope, code, message: (err as Error).message ?? String(err) });
      events.emit({ kind: "call.end", call, tool, ...scope, ms, ok, ...size });
    }
  };
}

/** Text characters, image count and total image pixels of a result (12, `call.end`). */
export function responseSize(r: CallToolResult): { chars: number; images: number; pixels: number } {
  let chars = 0, images = 0, pixels = 0;
  for (const c of r.content ?? []) {
    if (c.type === "text") chars += c.text.length;
    else if (c.type === "image") {
      images++;
      pixels += pngPixels(c.data);
    }
  }
  return { chars, images, pixels };
}

/** Width × height from a base64 PNG's IHDR, without decoding the image. 0 if it isn't a PNG. */
function pngPixels(b64: string): number {
  const head = Buffer.from(b64.slice(0, 32), "base64");
  if (head.length < 24 || head.readUInt32BE(12) !== 0x49484452) return 0; // "IHDR"
  return head.readUInt32BE(16) * head.readUInt32BE(20);
}
