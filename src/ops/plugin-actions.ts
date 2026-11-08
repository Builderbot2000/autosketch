import type { Registry } from "../assets/registry.js";
import type { Document, EditResult, Transaction } from "../document/document.js";
import { detectVariantTagNamespaces } from "../palette/families.js";
import { findAction, listActions } from "../plugins/actions.js";
import type { PluginAction, PluginActionContext } from "../plugins/types.js";
import { blockMatcher, opEdit, type CommonOptions, type OpEnv } from "./edit.js";
import { resolveSelection, type SelExpr } from "./selection.js";

/**
 * Runs plugin actions through the normal op pipeline (09 `actions`; 05 "Mod actions"): arguments
 * are checked against the action's zod schema, selections resolve like any op's, and the writes
 * are one journal entry with auto-connection. This is the registry other callers bind to: the MCP
 * tool `op_run` goes through `runPluginAction`, the script runtime through `runPluginActionSync`.
 */

export { listActions, findAction };

export interface PluginRunOptions extends CommonOptions {
  /**
   * Replaces the journal entry the action would open, e.g. a script run that is one entry for the
   * whole script (05, Scripting). Receives the op name, the summary and the write body.
   */
  edit?: <T>(op: string, summary: string, body: (tx: Transaction) => T) => EditResult;
}

const detected = new WeakMap<Registry, string[]>();

/** Variant tag namespaces: plugin-declared plus detected from data (03), cached per registry. */
export function variantNamespaces(env: OpEnv): string[] {
  const declared = (env.plugins ?? []).flatMap((p) => p.variantTagNamespaces ?? []);
  let found: string[] = [];
  if (env.registry) {
    found = detected.get(env.registry) ?? detectVariantTagNamespaces(env.registry);
    detected.set(env.registry, found);
  }
  return [...new Set([...declared, ...found])].sort();
}

/** The context a plugin action runs against, for op `op` on `doc`. */
export function pluginActionContext(doc: Document, env: OpEnv, op: string, opts: PluginRunOptions = {}): PluginActionContext {
  const { edit, ...common } = opts;
  return {
    doc,
    ...(env.registry ? { registry: env.registry } : {}),
    plugins: env.plugins ?? [],
    region: (sel) => {
      const r = resolveSelection(sel as SelExpr, { doc, ...(env.registry ? { registry: env.registry } : {}), ...(env.index ? { index: env.index } : {}) });
      if (sel !== "last") doc.lastSelection = sel as SelExpr;
      if (r.mask.isEmpty()) throw new Error(["the selection is empty", ...r.notes].join("; "));
      return r.mask;
    },
    edit: (summary, body) => (edit ? edit(op, summary, body) : opEdit(doc, env, op, summary, common, body)),
    matcher: (spec) => blockMatcher(spec, env.registry),
    ...(env.index ? { family: (id: string) => env.index!.familyOfBlock(id) } : {}),
    variantNamespaces: variantNamespaces(env),
  };
}

/** Finds the action for `op` and checks `args` against its schema. */
function prepare(env: OpEnv, op: string, args: unknown): { action: PluginAction; data: unknown } {
  const plugins = env.plugins ?? [];
  const found = findAction(plugins, op);
  if (!found) {
    const known = listActions(plugins).map((a) => a.op);
    throw new Error(`no plugin op "${op}"${known.length ? `; available: ${known.join(", ")}` : " (no active plugin defines ops)"}. ops_list shows their params.`);
  }
  const parsed = found.action.params.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ");
    throw new Error(`bad arguments for ${op}: ${issues}`);
  }
  return { action: found.action, data: parsed.data };
}

/** Runs the plugin op `op` ("framed.shape", …) with `args`. Throws on an unknown op or bad arguments. */
export async function runPluginAction(doc: Document, env: OpEnv, op: string, args: unknown, opts: PluginRunOptions = {}): Promise<EditResult> {
  const { action, data } = prepare(env, op, args);
  return action.run(pluginActionContext(doc, env, op, opts), data);
}

/**
 * `runPluginAction` for callers that can't wait, such as a script op, which must finish or throw
 * before the script goes on (05, Scripting). An action that returns a promise is refused, and its
 * edit hook refuses writes after the call returns, so it can't touch the document later.
 */
export function runPluginActionSync(doc: Document, env: OpEnv, op: string, args: unknown, opts: PluginRunOptions = {}): EditResult {
  const { action, data } = prepare(env, op, args);
  let open = true;
  const { edit, ...common } = opts;
  const guarded: PluginRunOptions = {
    ...common,
    edit: (name, summary, body) => {
      if (!open) throw new Error(`${op} wrote after its call returned`);
      return edit ? edit(name, summary, body) : opEdit(doc, env, name, summary, common, body);
    },
  };
  let r: EditResult | Promise<EditResult>;
  try {
    r = action.run(pluginActionContext(doc, env, op, guarded), data);
  } finally {
    open = false;
  }
  if (r instanceof Promise) {
    r.catch(() => undefined);
    throw new Error(`${op} is asynchronous and can't run synchronously (e.g. inside a script); use op_run`);
  }
  return r;
}
