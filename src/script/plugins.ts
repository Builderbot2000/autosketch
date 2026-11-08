import { z } from "zod";
import { toPublic } from "../core/region.js";
import type { EditResult } from "../document/document.js";
import { findAction, listActions, pluginActionContext } from "../ops/plugin-actions.js";
import type { AutosketchPlugin } from "../plugins/types.js";
import type { ScriptOp } from "./ops.js";

/**
 * Plugin actions in scripts (docs/design/05-operations.md, Mod actions: "callable from scripts";
 * 09 `actions`). Each action "<plugin>.<name>" becomes a script function taking the same args
 * object as `op_run`, e.g. `framed.shape({ sel: sel.box([0,0,0],[3,0,0]), shape: "slope" })`.
 *
 * It uses the same pieces as `runPluginAction` (the action registry, zod argument check and
 * `pluginActionContext` with its `edit` hook, so the writes join the script's single journal
 * entry), but calls the action synchronously: `runPluginAction` is async, and a script op must
 * finish, or throw, before the script goes on. An action that returns a promise is refused, and
 * its edit hook refuses late writes, so it can't touch the document after the run.
 */
export function pluginScriptOps(plugins: readonly AutosketchPlugin[]): ScriptOp[] {
  return listActions(plugins).map(({ op, action }) => ({
    name: op,
    params: `args: ${argsType(action.params)}`,
    returns: "EditSummary",
    doc: action.description.replace(/\s+/g, " ").replace(/\*\//g, "* /"),
    run: (h, [args]) => {
      const found = findAction(h.env.plugins ?? [], op);
      if (!found) throw new Error(`no plugin op "${op}"`);
      const parsed = found.action.params.safeParse(args ?? {});
      if (!parsed.success) throw new Error(`bad arguments for ${op}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "args"}: ${i.message}`).join("; ")}`);
      let open = true;
      const ctx = pluginActionContext(h.doc, h.env, op, {
        edit: (name, summary, body) => {
          if (!open) throw new Error(`${op} wrote after its script call returned`);
          return h.doc.edit(name, summary, body);
        },
      });
      let r: EditResult | Promise<EditResult>;
      try {
        r = found.action.run(ctx, parsed.data);
      } finally {
        open = false;
      }
      if (r instanceof Promise) {
        r.catch(() => undefined);
        throw new Error(`${op} is asynchronous and can't run inside a script; use op_run`);
      }
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
