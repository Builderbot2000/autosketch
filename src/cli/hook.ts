import { livePortFiles, runDir, TURN_END_PATH, type PortFile } from "../observe/turn-hook.js";

/**
 * `autosketch hook turn-end` (docs/design/19-canvas-and-requests.md, *When a request has concluded*):
 * the command the Claude Code plugin's `Stop` and `StopFailure` hooks run
 * (`packaging/claude-plugin/hooks/hooks.json`). It reads Claude Code's hook input from stdin when
 * there is any, then posts `turn.end` to every live MCP's turn-end route (the port files,
 * `observe/turn-hook.ts`) with that MCP's token.
 *
 * It never blocks the turn: everything is bounded by `timeoutMs` (1 s), failures are silent, it
 * prints nothing and always exits 0.
 */

export interface HookDeps {
  /** Where the port files are; default `<AUTOSKETCH_HOME>/run`. */
  dir?: string;
  /** Claude Code's hook input (JSON); default stdin when it isn't a terminal. */
  input?: () => Promise<string>;
  timeoutMs?: number;
  /** The POST; default `fetch`. */
  post?: (url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<unknown>;
}

export const HOOK_TIMEOUT_MS = 1000;

/** Runs `autosketch hook <args>`; always resolves to 0. */
export async function runHook(args: string[], deps: HookDeps = {}): Promise<number> {
  if (args[0] !== "turn-end") return 0;
  const timeoutMs = deps.timeoutMs ?? HOOK_TIMEOUT_MS;
  const started = Date.now();
  try {
    const files = livePortFiles(deps.dir ?? runDir());
    if (!files.length) return 0;
    const raw = await withTimeout((deps.input ?? readStdin)(), Math.min(250, timeoutMs), "");
    const body = JSON.stringify(hookBody(raw));
    const signal = AbortSignal.timeout(Math.max(1, timeoutMs - (Date.now() - started)));
    const post = deps.post ?? ((url, init) => fetch(url, { method: "POST", ...init }));
    await Promise.allSettled(files.map((f: PortFile) => post(`http://127.0.0.1:${f.port}${TURN_END_PATH}`, { headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" }, body, signal })));
  } catch {
    // silent: the MCP falls back to world_reply done, then the idle timeout (19)
  }
  return 0;
}

/** What the route gets from Claude Code's hook input: the reason (`Stop` or `StopFailure`) and the session id. */
export function hookBody(raw: string): { reason: string; session?: string } {
  let input: { hook_event_name?: unknown; session_id?: unknown } = {};
  try {
    if (raw.trim()) input = JSON.parse(raw) as typeof input;
  } catch {
    // not JSON: still a turn end
  }
  const reason = input?.hook_event_name === "StopFailure" ? "error" : "stop";
  return { reason, ...(typeof input?.session_id === "string" && input.session_id ? { session: input.session_id } : {}) };
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((ok) => {
    const t = setTimeout(() => ok(fallback), ms);
    t.unref?.();
    p.then(
      (v) => (clearTimeout(t), ok(v)),
      () => (clearTimeout(t), ok(fallback)),
    );
  });
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((ok) => {
    const chunks: Buffer[] = [];
    let size = 0;
    process.stdin.on("data", (c: Buffer) => {
      size += c.length;
      if (size <= 1 << 20) chunks.push(c);
    });
    process.stdin.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => ok(""));
  });
}
