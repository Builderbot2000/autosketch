import { z } from "zod";
import { toPublic } from "../core/region.js";
import { listActions, runPluginActionSync } from "../ops/plugin-actions.js";
import type { AutosketchPlugin } from "../plugins/types.js";
import type { ScriptOp } from "./ops.js";

/**
 * Plugin actions in scripts (docs/design/05-operations.md, Mod actions: "callable from scripts";
 * 09 `actions`). Each action "<plugin>.<name>" becomes a script function taking the same args
 * object as `op_run`, e.g. `framed.shape({ sel: sel.box([0,0,0],[3,0,0]), shape: "slope" })`.
 *
 * It calls `runPluginActionSync` with an `edit` hook, so the writes join the script's single
 * journal entry; asynchronous actions are refused there, since a script op must finish, or throw,
 * before the script goes on.
 */
export function pluginScriptOps(plugins: readonly AutosketchPlugin[]): ScriptOp[] {
  return listActions(plugins).map(({ op, action }) => ({
    name: op,
    params: `args: ${argsType(action.params)}`,
    returns: "EditSummary",
    doc: action.description.replace(/\s+/g, " ").replace(/\*\//g, "* /"),
    run: (h, [args]) => {
      const r = runPluginActionSync(h.doc, h.env, op, args, { edit: (name, summary, body) => h.doc.edit(name, summary, body) });
      if (r.changed) h.edits++;
      return { op: r.op, changed: r.changed, ...(r.box ? { box: toPublic(r.box) } : {}), warnings: r.warnings };
    },
  }));
}

/** A TypeScript object type for an action's zod params (for the generated .d.ts). */
function argsType(schema: z.ZodType): string {
  let json: { properties?: Record<string, { type?: unknown; enum?: unknown[] }>; required?: string[] };
  try {
    json = z.toJSONSchema(schema, { unrepresentable: "any" }) as typeof json;
  } catch {
    return "Record<string, unknown>";
  }
  const req = new Set(json.required ?? []);
  const props = Object.entries(json.properties ?? {}).map(([k, v]) => {
    const t =
      k === "sel" ? "SelLike" : v.enum ? v.enum.map((e) => JSON.stringify(e)).join(" | ") : v.type === "string" ? "string" : v.type === "number" || v.type === "integer" ? "number" : v.type === "boolean" ? "boolean" : v.type === "array" ? "unknown[]" : "unknown";
    return `${k}${req.has(k) ? "" : "?"}: ${t}`;
  });
  return props.length ? `{ ${props.join("; ")} }` : "Record<string, unknown>";
}
