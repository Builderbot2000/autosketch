import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

/** Shared file helpers for the library (07). Missing folders read as empty. */

/** Files under `dir` (recursively, at most `depth` levels) whose name passes `keep`, as relative "/" paths, sorted. */
export async function walk(dir: string, keep: (name: string) => boolean, depth = 4): Promise<string[]> {
  const out: string[] = [];
  const visit = async (d: string, level: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (level < depth) await visit(p, level + 1);
      } else if (keep(e.name)) out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  await visit(dir, 1);
  return out.sort();
}

export type FrontValue = string | string[];

/**
 * Light frontmatter (07, Knowledge packs): a leading `---` block of `key: value` lines, where a
 * value may be a `[a, b]` list. Not full YAML on purpose: packs are hand-written and small.
 */
export function parseFrontmatter(text: string): { data: Record<string, FrontValue>; body: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, FrontValue> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*(?:#.*)?$/.exec(line);
    if (!kv) continue;
    const raw = kv[2]!;
    const list = /^\[(.*)\]$/.exec(raw);
    data[kv[1]!] = list ? list[1]!.split(",").map(unquote).filter(Boolean) : unquote(raw);
  }
  return { data, body: text.slice(m[0].length) };
}

function unquote(s: string): string {
  const t = s.trim();
  return /^(["']).*\1$/.test(t) ? t.slice(1, -1) : t;
}

export const asList = (v: FrontValue | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : v.split(",").map((s) => s.trim()).filter(Boolean));
export const asText = (v: FrontValue | undefined): string | undefined => (v === undefined ? undefined : Array.isArray(v) ? v.join(", ") : v);

/** Lower-case words of a query, for simple scoring. */
export const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
