import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { asList, asText, parseFrontmatter, walk } from "./files.js";
import type { LibraryRoot } from "./roots.js";

/**
 * Knowledge packs (docs/design/07-library.md): markdown with light frontmatter, retrieved on
 * demand. A pack's name is its path under `knowledge/` without `.md` ("heuristics/roofs"). They
 * are advice the agent may weigh, never rules the server enforces.
 */

export type KnowledgeKind = "style" | "heuristic" | "technique" | string;

export interface KnowledgeEntry {
  /** Path under knowledge/ without .md, e.g. "styles/gothic". */
  name: string;
  title: string;
  kind: KnowledgeKind;
  tags: string[];
  summary: string;
  root: string;
  file: string;
}

export async function listKnowledge(roots: readonly LibraryRoot[], filter: { kind?: string; tags?: string[] } = {}): Promise<KnowledgeEntry[]> {
  const seen = new Map<string, KnowledgeEntry>();
  for (const root of roots) {
    if (root.kind !== "library") continue;
    const dir = join(root.path, "knowledge");
    for (const rel of await walk(dir, (n) => n.endsWith(".md") && n.toLowerCase() !== "readme.md")) {
      const name = rel.slice(0, -3);
      if (seen.has(name)) continue;
      const file = join(dir, rel);
      const { data, body } = parseFrontmatter(await readFile(file, "utf8"));
      seen.set(name, {
        name,
        title: asText(data.name) ?? name.split("/").pop()!,
        kind: asText(data.kind) ?? (name.includes("/") ? singular(name.split("/")[0]!) : "note"),
        tags: asList(data.tags).map((t) => t.toLowerCase()),
        summary: asText(data.summary) ?? firstLine(body),
        root: root.label,
        file,
      });
    }
  }
  const tags = (filter.tags ?? []).map((t) => t.toLowerCase());
  return [...seen.values()].filter((e) => (!filter.kind || e.kind === filter.kind) && tags.every((t) => e.tags.includes(t)));
}

/** Finds a pack by name, by last path segment, or by its frontmatter title (case-insensitive). */
export async function readKnowledge(roots: readonly LibraryRoot[], name: string): Promise<{ entry: KnowledgeEntry; text: string }> {
  const all = await listKnowledge(roots);
  const n = name.trim().replace(/\.md$/i, "").toLowerCase();
  const entry =
    all.find((e) => e.name.toLowerCase() === n) ??
    all.find((e) => e.name.split("/").pop()!.toLowerCase() === n) ??
    all.find((e) => e.title.toLowerCase() === n);
  if (!entry) throw new Error(`no knowledge pack "${name}"${all.length ? ` (have: ${all.map((e) => e.name).join(", ")})` : ""}`);
  return { entry, text: await readFile(entry.file, "utf8") };
}

/** One line per pack: name, kind, tags and summary (07: names and summaries only). */
export function formatKnowledgeList(entries: readonly KnowledgeEntry[]): string {
  if (!entries.length) return "No knowledge packs match. Add markdown files under <library>/knowledge/.";
  const lines = entries.map((e) => `${e.name} [${e.kind}]${e.tags.length ? ` (${e.tags.join(", ")})` : ""}: ${e.summary}`);
  lines.push("Read one with knowledge_read({name}). Packs are suggestions to weigh, not rules.");
  return lines.join("\n");
}

function singular(dir: string): string {
  return dir.endsWith("s") ? dir.slice(0, -1) : dir;
}

function firstLine(body: string): string {
  const l = body.split(/\r?\n/).map((s) => s.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  return l.length > 120 ? `${l.slice(0, 117)}…` : l;
}
