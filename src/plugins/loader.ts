import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { AutosketchPlugin } from "./types.js";

/**
 * Third-party plugins (docs/design/09-mod-compat.md, "Third-party plugins"): ESM files in
 * `<workspace>/plugins/*.js` (default `~/autosketch/plugins`).
 *
 * FULL TRUST: a plugin file is imported like any Node module and runs with the server's
 * permissions (files, network, processes). Only put files there that you would run yourself.
 *
 * A file's default export is one plugin, an array of plugins, or a function `({ z }) => plugin(s)`
 * that receives the server's zod (plugin folders have no node_modules, and action params must be
 * zod schemas). A plugin with the id of a built-in one replaces it. Bad files are skipped with a
 * warning; they never stop the server.
 */

/** What a factory-style plugin file receives. */
export interface PluginApi {
  z: typeof z;
}
const PLUGIN_API: PluginApi = { z };

export interface LoadedPlugins {
  plugins: AutosketchPlugin[];
  warnings: string[];
}

export function pluginDir(workspace: string): string {
  return join(workspace, "plugins");
}

export async function loadPluginDir(dir: string): Promise<LoadedPlugins> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => /\.m?js$/.test(n)).sort();
  } catch {
    return { plugins: [], warnings: [] }; // no plugin folder: nothing to load
  }
  const plugins: AutosketchPlugin[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const file = join(dir, name);
    try {
      const hash = createHash("sha1").update(await readFile(file)).digest("hex").slice(0, 12);
      // The hash in the URL makes an edited file load fresh instead of from Node's module cache.
      const mod = (await import(`${pathToFileURL(file).href}?v=${hash}`)) as { default?: unknown };
      const exported = typeof mod.default === "function" ? await (mod.default as (api: PluginApi) => unknown)(PLUGIN_API) : mod.default;
      const list = Array.isArray(exported) ? exported : [exported];
      for (const p of list) {
        const problem = checkPlugin(p);
        if (problem) {
          warnings.push(`plugin ${name}: ${problem}; skipped`);
          continue;
        }
        const plugin = p as AutosketchPlugin;
        if (seen.has(plugin.id)) {
          warnings.push(`plugin ${name}: id "${plugin.id}" already loaded from another file; skipped`);
          continue;
        }
        seen.add(plugin.id);
        plugins.push({ ...plugin, cacheKey: plugin.cacheKey ?? hash });
      }
    } catch (e) {
      warnings.push(`plugin ${name}: failed to load (${(e as Error).message})`);
    }
  }
  return { plugins, warnings };
}

/** Built-ins plus third-party plugins; a third-party plugin replaces a built-in with the same id. */
export function mergePlugins(builtin: readonly AutosketchPlugin[], extra: readonly AutosketchPlugin[]): LoadedPlugins {
  const ids = new Set(extra.map((p) => p.id));
  const warnings = builtin.filter((p) => ids.has(p.id)).map((p) => `plugin "${p.id}" from the plugins folder replaces the built-in one`);
  return { plugins: [...builtin.filter((p) => !ids.has(p.id)), ...extra], warnings };
}

const FUNCTION_FIELDS = ["classify", "families", "render", "items", "validateNbt"] as const;

/** Why a default export isn't a usable plugin, or undefined. */
export function checkPlugin(p: unknown): string | undefined {
  if (!p || typeof p !== "object") return "default export is not a plugin object";
  const o = p as Record<string, unknown>;
  if (typeof o.id !== "string" || !/^[a-z0-9_-]+$/.test(o.id)) return "id must be a lowercase string of [a-z0-9_-]";
  if (!Array.isArray(o.namespaces) || !o.namespaces.length || o.namespaces.some((n) => typeof n !== "string")) return "namespaces must be a non-empty string array";
  for (const f of FUNCTION_FIELDS) if (o[f] !== undefined && typeof o[f] !== "function") return `${f} must be a function`;
  if (o.variantTagNamespaces !== undefined && !(Array.isArray(o.variantTagNamespaces) && o.variantTagNamespaces.every((n) => typeof n === "string"))) return "variantTagNamespaces must be a string array";
  if (o.docs !== undefined && typeof o.docs !== "string") return "docs must be a string";
  if (o.opNamespace !== undefined && (typeof o.opNamespace !== "string" || !/^[a-z0-9_-]+$/.test(o.opNamespace))) return "opNamespace must be a lowercase string of [a-z0-9_-]";
  if (o.actions !== undefined) {
    if (!o.actions || typeof o.actions !== "object") return "actions must be an object";
    for (const [name, a] of Object.entries(o.actions as Record<string, unknown>)) {
      const act = a as Record<string, unknown> | undefined;
      if (!/^[a-z][a-z0-9_]*$/.test(name)) return `action name "${name}" must be lowercase [a-z0-9_]`;
      if (!act || typeof act.description !== "string" || typeof act.run !== "function") return `action "${name}" needs a description and a run function`;
      const params = act.params as { safeParse?: unknown } | undefined;
      if (!params || typeof params.safeParse !== "function") return `action "${name}" params must be a zod schema`;
    }
  }
  return undefined;
}
