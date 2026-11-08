import { getQuickJS, type QuickJSWASMModule } from "quickjs-emscripten";
import type { Document, EditResult } from "../document/document.js";
import type { OpEnv } from "../ops/edit.js";
import { SCRIPT_OPS, type ScriptHost, type ScriptOp } from "./ops.js";
import { preloadPrefabs, stampLiterals, type PrefabSource } from "./prefabs.js";
import { prelude } from "./prelude.js";

/**
 * Script runs (docs/design/05-operations.md, Scripting L4). Scripts run in QuickJS compiled to
 * WASM: no filesystem, network, Node or host objects; only JSON crosses the boundary through one
 * host function. Memory and time are capped (defaults 64 MB, 10 s). A run is one journal entry
 * (`Document.group`): if the script throws or is stopped, every edit it made is rolled back, and
 * so are the named selections it stored. The result is the script's return value (JSON) plus a
 * diff summary; `log()` output is capped at about 2 KB.
 *
 * The source is a function body: `args` holds the arguments and `return` gives the result.
 */

export const SCRIPT_DEFAULTS = { timeoutMs: 10_000, memoryBytes: 64 * 1024 * 1024 };
export const LOG_CAP = 2048;
const VALUE_CAP = 4096;

export interface RunOptions {
  source: string;
  args?: Record<string, unknown>;
  /** Label for the journal entry (default "script"). */
  name?: string;
  timeoutMs?: number;
  memoryBytes?: number;
  /** Seed for rand() (default: the document seed). */
  seed?: number;
  /** Extra ops, e.g. plugin actions (see `ops.ts`). */
  ops?: readonly ScriptOp[];
  /**
   * Where `stamp` finds prefabs. They are loaded before the run (outside its time limit): every
   * string literal passed to stamp() plus `preload`. Without a source, stamp throws.
   */
  prefabs?: PrefabSource;
  /** Prefab names to load besides the literals, for names the script computes. */
  preload?: readonly string[];
}

export interface ScriptRun {
  result: EditResult;
  /** The return value as JSON (truncated), or undefined. */
  value?: string;
  log: string;
  /** Ops that changed something. */
  edits: number;
  /** Components the run added. */
  added: string[];
  ms: number;
}

export class ScriptError extends Error {
  constructor(
    message: string,
    readonly log: string,
    readonly kind: "error" | "timeout" | "memory",
  ) {
    super(message);
  }
}

let module: Promise<QuickJSWASMModule> | undefined;
const quickjs = () => (module ??= getQuickJS());

/** Every op a script can call: the built-in registry plus extra entries (plugin actions). */
export function scriptOps(extra: readonly ScriptOp[] = []): ScriptOp[] {
  const names = new Set(SCRIPT_OPS.map((o) => o.name));
  for (const e of extra) if (names.has(e.name)) throw new Error(`script op "${e.name}" is already defined`);
  return [...SCRIPT_OPS, ...extra];
}

export async function runScript(doc: Document, env: OpEnv, opts: RunOptions): Promise<ScriptRun> {
  const QJS = await quickjs();
  const prefabs = opts.prefabs ? await preloadPrefabs(opts.prefabs, [...stampLiterals(opts.source), ...(opts.preload ?? [])]) : undefined;
  const timeoutMs = opts.timeoutMs ?? SCRIPT_DEFAULTS.timeoutMs;
  const ops = scriptOps(opts.ops);
  const byName = new Map(ops.map((o) => [o.name, o]));
  const host: ScriptHost = { doc, env, edits: 0, ...(prefabs ? { prefabs } : {}) };
  let log = "";
  let logFull = false;
  const seed = opts.seed ?? doc.meta.seed;
  const started = Date.now();
  const deadline = started + timeoutMs;
  const compsBefore = new Set(doc.components.keys());
  const selectionsBefore = new Map(doc.selections);

  const rt = QJS.newRuntime();
  rt.setMemoryLimit(opts.memoryBytes ?? SCRIPT_DEFAULTS.memoryBytes);
  rt.setMaxStackSize(1024 * 1024);
  rt.setInterruptHandler(() => Date.now() > deadline);
  const ctx = rt.newContext();
  try {
    const fn = ctx.newFunction("__host", (nameH, argsH) => {
      if (Date.now() > deadline) throw new Error("interrupted");
      const name = ctx.getString(nameH);
      const args = JSON.parse(ctx.getString(argsH)) as unknown[];
      if (name === "__log") {
        if (!logFull) {
          log += `${String(args[0])}\n`;
          if (log.length > LOG_CAP) {
            log = `${log.slice(0, LOG_CAP)}… (log capped at ${LOG_CAP} chars)\n`;
            logFull = true;
          }
        }
        return undefined;
      }
      if (name === "__seed") return ctx.newString(String(seed));
      const op = byName.get(name);
      if (!op) throw new Error(`unknown op "${name}"`);
      const r = op.run(host, args);
      return r === undefined ? undefined : ctx.newString(JSON.stringify(r));
    });
    ctx.setProp(ctx.global, "__host", fn);
    fn.dispose();
    const pre = ctx.evalCode(prelude(ops), "prelude.js");
    if (pre.error) {
      const e = ctx.dump(pre.error);
      pre.error.dispose();
      throw new Error(`script prelude failed: ${JSON.stringify(e)}`);
    }
    pre.value.dispose();

    const argsJson = JSON.stringify(opts.args ?? {});
    const code = `JSON.stringify((function (args) {${opts.source}\n})(${argsJson}))`;
    let value: string | undefined;
    const result = doc.group("script", opts.name ?? "script", () => {
      const r = ctx.evalCode(code, "script.js");
      if (r.error) {
        const e = ctx.dump(r.error) as { name?: string; message?: string; stack?: string } | string;
        r.error.dispose();
        throw describeError(e, timeoutMs, opts.memoryBytes ?? SCRIPT_DEFAULTS.memoryBytes, log);
      }
      const v = ctx.dump(r.value) as string | undefined;
      r.value.dispose();
      value = v === undefined ? undefined : v.length > VALUE_CAP ? `${v.slice(0, VALUE_CAP)}… (truncated)` : v;
    });
    return {
      result,
      ...(value !== undefined ? { value } : {}),
      log,
      edits: host.edits,
      added: [...doc.components.keys()].filter((k) => !compsBefore.has(k)),
      ms: Date.now() - started,
    };
  } catch (e) {
    doc.selections = selectionsBefore;
    if (e instanceof ScriptError) throw e;
    throw new ScriptError((e as Error).message, log, "error");
  } finally {
    ctx.dispose();
    rt.dispose();
  }
}

function describeError(e: { name?: string; message?: string; stack?: string } | string, timeoutMs: number, memoryBytes: number, log: string): ScriptError {
  const msg = typeof e === "string" ? e : e.message ?? JSON.stringify(e);
  if (/interrupted/.test(msg)) return new ScriptError(`script stopped: over the ${timeoutMs / 1000} s time limit; nothing was changed`, log, "timeout");
  if (/out of memory/.test(msg) || (typeof e === "object" && e.name === "InternalError" && /stack overflow/.test(msg)))
    return new ScriptError(`script stopped: over the ${Math.round(memoryBytes / 1048576)} MB memory limit${/stack/.test(msg) ? " (stack overflow)" : ""}; nothing was changed`, log, "memory");
  const where = typeof e === "object" && e.stack ? /script\.js:(\d+)(?::(\d+))?/.exec(e.stack) : null;
  const name = typeof e === "object" && e.name && e.name !== "Error" ? `${e.name}: ` : "";
  return new ScriptError(`script error${where ? ` at line ${where[1]}` : ""}: ${name}${msg}; nothing was changed`, log, "error");
}
