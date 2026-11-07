import { z } from "zod";
import type { AutosketchPlugin, PluginAction } from "./types.js";

/**
 * Plugin actions as ops named "<plugin id>.<name>" (09 `actions`; 05: discoverable through
 * `ops_list({ namespace })`).
 */

export interface ListedAction {
  op: string;
  plugin: AutosketchPlugin;
  action: PluginAction;
}

/** Actions of the given plugins, optionally only those of one plugin id or mod namespace. */
export function listActions(plugins: readonly AutosketchPlugin[], namespace?: string): ListedAction[] {
  const out: ListedAction[] = [];
  for (const p of plugins) {
    if (namespace && p.id !== namespace && !p.namespaces.includes(namespace)) continue;
    for (const [name, action] of Object.entries(p.actions ?? {})) out.push({ op: `${p.id}.${name}`, plugin: p, action });
  }
  return out.sort((a, b) => (a.op < b.op ? -1 : 1));
}

export function findAction(plugins: readonly AutosketchPlugin[], op: string): ListedAction | undefined {
  return listActions(plugins).find((a) => a.op === op);
}

/** A compact one-line signature of an action's params: `sel, shape, camo?, state?`. */
export function describeParams(schema: z.ZodType): string {
  let json: { properties?: Record<string, { type?: unknown; enum?: unknown[] }>; required?: string[] };
  try {
    json = z.toJSONSchema(schema, { unrepresentable: "any" }) as typeof json;
  } catch {
    return "(args)";
  }
  const req = new Set(json.required ?? []);
  const props = Object.entries(json.properties ?? {});
  if (!props.length) return "";
  return props
    .map(([k, v]) => {
      const t = v.enum ? v.enum.map(String).join("|") : typeof v.type === "string" ? v.type : "";
      return `${k}${req.has(k) ? "" : "?"}${t ? `: ${t}` : ""}`;
    })
    .join(", ");
}

/** The `ops_list` text: one line per action, at most `limit`. */
export function formatActionList(plugins: readonly AutosketchPlugin[], namespace?: string, limit = 50): string {
  const list = listActions(plugins, namespace);
  if (!list.length) {
    const active = plugins.map((p) => p.id).join(", ") || "none";
    return namespace ? `No plugin ops for "${namespace}" (active plugins: ${active}).` : `No plugin ops available (active plugins: ${active}).`;
  }
  const lines = [`${list.length} plugin op${list.length > 1 ? "s" : ""}${namespace ? ` for ${namespace}` : ""}:`];
  for (const { op, action } of list.slice(0, limit)) lines.push(`${op}(${describeParams(action.params)}) — ${action.description}`);
  if (list.length > limit) lines.push(`… ${list.length - limit} more; filter with namespace`);
  return lines.join("\n");
}
