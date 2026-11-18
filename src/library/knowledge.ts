import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { asList, asText, parseFrontmatter, walk } from "./files.js";
import { isHidden, writableRoot, type LibraryRoot } from "./roots.js";

/**
 * Knowledge packs (docs/design/07-library.md): markdown with light frontmatter, retrieved on
 * demand. A pack's name is its path under `knowledge/` without `.md` ("heuristics/roofs"). They
 * are advice the agent may weigh, never rules the server enforces.
 */

export type KnowledgeKind = "style" | "heuristic" | "technique" | "skill" | "kit" | string;

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
      if (seen.has(name) || isHidden(root, "knowledge", name)) continue;
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

// -- kits (docs/design/17-reusable-components.md, piece 2) ------------------------------------------

/** One kit entry, as a component-set entry (17, piece 1). */
export interface KitEntry {
  prefab: string;
  label?: string;
  notes?: string;
}

/** Finds a kit (kind `kit`) by name, last path segment, title or the file stem `save_as` would use. */
export async function findKit(roots: readonly LibraryRoot[], name: string): Promise<KnowledgeEntry> {
  const kits = await listKnowledge(roots, { kind: "kit" });
  const n = name.trim().replace(/\.md$/i, "").toLowerCase();
  const kit =
    kits.find((e) => e.name.toLowerCase() === n) ??
    kits.find((e) => e.name.split("/").pop()!.toLowerCase() === n) ??
    kits.find((e) => e.title.toLowerCase() === n) ??
    kits.find((e) => e.name.split("/").pop()!.toLowerCase() === kitStem(name));
  if (!kit) throw new Error(`no kit "${name}"${kits.length ? ` (have: ${kits.map((e) => e.title).join(", ")})` : " (no kits saved yet)"}`);
  return kit;
}

/** A kit's entries and notes (the body). */
export async function readKit(roots: readonly LibraryRoot[], name: string): Promise<{ kit: KnowledgeEntry; entries: KitEntry[]; notes: string }> {
  const kit = await findKit(roots, name);
  const text = await readFile(kit.file, "utf8");
  return { kit, entries: parseKitEntries(text), notes: parseFrontmatter(text).body.trim() };
}

/**
 * Writes a set as `knowledge/kits/<stem>.md` in the first writable root (17, *Kits*). An existing
 * kit there keeps its other frontmatter and its notes; only `entries` is rewritten.
 */
export async function writeKit(roots: readonly LibraryRoot[], name: string, entries: readonly KitEntry[]): Promise<{ file: string; replaced: boolean }> {
  const stem = kitStem(name);
  if (!stem) throw new Error(`kit name "${name}" needs a letter or digit`);
  const file = join(writableRoot(roots).path, "knowledge", "kits", `${stem}.md`);
  const block = ["entries:", ...entries.map((e) => `  - ${flowMap(e)}`)];
  let old: string | undefined;
  try {
    old = await readFile(file, "utf8");
  } catch {
    old = undefined;
  }
  let text: string;
  const m = old === undefined ? null : /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(old);
  if (old !== undefined && m) {
    const lines = m[1]!.split(/\r?\n/);
    const at = lines.findIndex((l) => /^entries\s*:/.test(l));
    if (at < 0) lines.push(...block);
    else {
      let end = at + 1;
      while (end < lines.length && (/^\s/.test(lines[end]!) || /^-/.test(lines[end]!))) end++;
      lines.splice(at, end - at, ...block);
    }
    text = `---\n${lines.join("\n")}\n---\n${old.slice(m[0].length)}`;
  } else {
    const labels = entries.map((e) => e.label ?? e.prefab);
    const summary = `Component set of ${entries.length}${labels.length ? `: ${labels.join(", ")}` : ""}.`;
    text = ["---", "kind: kit", `name: ${scalar(name.trim())}`, `summary: ${scalar(summary)}`, ...block, "---", ""].join("\n") + (old ?? "");
  }
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
  return { file, replaced: old !== undefined };
}

/** File stem for a kit name: "Gothic cathedral kit" → "gothic_cathedral_kit". */
export function kitStem(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^[_-]+|_+$/g, "")
    .slice(0, 64);
}

/**
 * The `entries:` list of a kit's frontmatter. The light frontmatter parser (files.ts) reads one
 * line per key, so this reads the list itself: items as flow maps (`- { prefab: a, label: b }`),
 * block maps (`- prefab: a` with indented `label: b` lines below), or a bare prefab name.
 */
export function parseKitEntries(text: string): KitEntry[] {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return [];
  const lines = m[1]!.split(/\r?\n/);
  const at = lines.findIndex((l) => /^entries\s*:\s*$/.test(l));
  if (at < 0) return [];
  const items: Record<string, string>[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line) && !/^-/.test(line)) break;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) {
      const rest = item[1]!.trim();
      const flow = /^\{(.*)\}$/.exec(rest);
      if (flow) items.push(Object.fromEntries(splitTop(flow[1]!).map(pair).filter((p): p is [string, string] => !!p)));
      else {
        const kv = pair(rest);
        items.push(kv ? { [kv[0]]: kv[1] } : { prefab: unquote(rest) });
      }
    } else {
      const kv = pair(line.trim());
      const last = items[items.length - 1];
      if (kv && last) last[kv[0]] = kv[1];
    }
  }
  return items
    .filter((x) => x.prefab)
    .map((x) => ({ prefab: x.prefab!, ...(x.label ? { label: x.label } : {}), ...(x.notes ? { notes: x.notes } : {}) }));
}

/** Splits on commas outside quotes. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < s.length) {
        cur += ch + s[++i]!;
        continue;
      }
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function pair(s: string): [string, string] | undefined {
  const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(s.trim());
  return kv ? [kv[1]!, unquote(kv[2]!)] : undefined;
}

function unquote(s: string): string {
  const t = s.trim();
  if (/^".*"$/.test(t)) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return /^'.*'$/.test(t) ? t.slice(1, -1).replace(/''/g, "'") : t;
}

/** A value as written in frontmatter: plain when the light parsers read it back unchanged, else double-quoted. */
function scalar(v: string): string {
  return /^[^\s"'{}\[\],:#][^"{}\[\],:#]*$/.test(v) && v === v.trim() ? v : JSON.stringify(v);
}

function flowMap(e: KitEntry): string {
  return `{ ${[`prefab: ${scalar(e.prefab)}`, e.label ? `label: ${scalar(e.label)}` : "", e.notes ? `notes: ${scalar(e.notes)}` : ""].filter(Boolean).join(", ")} }`;
}

function singular(dir: string): string {
  return dir.endsWith("s") ? dir.slice(0, -1) : dir;
}

function firstLine(body: string): string {
  const l = body.split(/\r?\n/).map((s) => s.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  return l.length > 120 ? `${l.slice(0, 117)}…` : l;
}
