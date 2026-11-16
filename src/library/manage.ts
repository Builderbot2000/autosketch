import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { listKnowledge } from "./knowledge.js";
import { listLibraryPalettes } from "./palettes.js";
import { scanPrefabs, type Prefab } from "./prefabs.js";
import { listProcedures } from "./procedures.js";
import { ENTRY_NAME, isHidden, writableRoot, type LibraryRoot } from "./roots.js";

/**
 * Library management for the UI's Library tab (docs/design/15-management-ui.md, *Library tab*):
 * every entry of every root (shadowed and hidden ones included, which the tools' listings leave
 * out), addressed as `<root label>/<kind>/<name>` and never by path, and the actions on them:
 * rename, duplicate, recoverable delete into `<root>/.trash/<id>/`, restore, empty trash, and copy
 * from a read-only root into the first writable one. Hiding is a setting (`library.hidden`), written
 * by the caller.
 *
 * An address resolves only to an entry the listing of that root has, so a name can never reach a
 * file outside its root; the resolved path is checked against the root as well.
 */

export const ENTRY_KINDS = ["prefabs", "palettes", "procedures", "knowledge"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export interface LibraryEntry {
  kind: EntryKind;
  /** The name within its root: `park_bench`, `heuristics/roofs`, an Axiom blueprint's path. */
  name: string;
  root: string;
  writable: boolean;
  title: string;
  tags: string[];
  summary: string;
  hidden: boolean;
  /** The earlier root whose entry of the same name wins over this one. */
  shadowedBy?: string;
  /** Later roots whose entry of the same name this one wins over. */
  overrides?: string[];
}

/** An entry with where it lives (server side only, never sent). */
export interface ResolvedEntry extends LibraryEntry {
  rootRef: LibraryRoot;
  /** The prefab folder, or the entry's file. */
  target: string;
  /** The file that holds the entry's text or blocks. */
  file: string;
  prefab?: Prefab;
}

/** A refusal the API answers with a status (404 unknown, 409 taken or read-only, 400 bad name). */
export class LibraryError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "LibraryError";
  }
}

/** Every entry of one root and kind, hidden ones included. */
async function rootEntries(root: LibraryRoot, kind: EntryKind): Promise<ResolvedEntry[]> {
  const bare: LibraryRoot = { ...root, hidden: new Set() };
  const base = { root: root.label, writable: !root.readOnly, rootRef: root };
  const hidden = (name: string) => isHidden(root, kind, name);
  if (kind === "prefabs") {
    return (await scanPrefabs([bare])).map((p) => {
      const name = root.kind === "axiom" ? p.id.slice("axiom/".length) : p.id;
      return { ...base, kind, name, title: p.meta.name, tags: p.meta.tags, summary: p.meta.notes ?? "", hidden: hidden(name), target: p.dir ?? p.file, file: p.file, prefab: p };
    });
  }
  if (root.kind !== "library") return [];
  if (kind === "palettes")
    return (await listLibraryPalettes([bare])).map((p) => ({ ...base, kind, name: basename(p.file, ".json"), title: p.name, tags: p.tags, summary: p.notes ?? `${Object.keys(p.roles).length} roles`, hidden: hidden(basename(p.file, ".json")), target: p.file, file: p.file }));
  if (kind === "procedures")
    return (await listProcedures([bare])).map((p) => ({ ...base, kind, name: p.name, title: p.name, tags: [], summary: p.summary, hidden: hidden(p.name), target: p.file, file: p.file }));
  return (await listKnowledge([bare])).map((k) => ({ ...base, kind, name: k.name, title: k.title, tags: k.tags, summary: k.summary, hidden: hidden(k.name), target: k.file, file: k.file }));
}

/** Every entry of every root, per kind, with shadowing worked out in search order. */
export async function listEntries(roots: readonly LibraryRoot[]): Promise<Record<EntryKind, LibraryEntry[]>> {
  const out = {} as Record<EntryKind, LibraryEntry[]>;
  for (const kind of ENTRY_KINDS) {
    const all: ResolvedEntry[] = [];
    for (const root of roots) all.push(...(await rootEntries(root, kind)));
    // The tools' id: an Axiom prefab is "axiom/<path>", so it never collides with a library prefab.
    const key = (e: ResolvedEntry) => (kind === "prefabs" && e.rootRef.kind === "axiom" ? `axiom/${e.name}` : e.name);
    const winner = new Map<string, ResolvedEntry>();
    for (const e of all) if (!e.hidden && !winner.has(key(e))) winner.set(key(e), e);
    out[kind] = all.map((e) => {
      const w = winner.get(key(e));
      const shadowedBy = w && w !== e ? w.root : undefined;
      const overrides = w === e ? all.filter((o) => o !== e && key(o) === key(e)).map((o) => o.root) : [];
      return strip({ ...e, ...(shadowedBy ? { shadowedBy } : {}), ...(overrides.length ? { overrides } : {}) });
    });
  }
  return out;
}

const strip = (e: ResolvedEntry & { shadowedBy?: string; overrides?: string[] }): LibraryEntry => {
  const { rootRef: _r, target: _t, file: _f, prefab: _p, ...rest } = e;
  return rest;
};

/** Checks an address's name: "/"-separated segments, none empty, `.`, `..` or starting with a dot. */
export function checkAddressName(name: string): void {
  const segs = name.split("/");
  if (!name || name.length > 256 || /[\\\0]/.test(name) || segs.some((s) => !s || s.startsWith(".") || s !== s.trim()))
    throw new LibraryError(400, `"${name}" isn't an entry name (no empty, hidden, . or .. parts, no backslashes)`);
}

/** The entry at `<root label>/<kind>/<name>`, or a 404. */
export async function resolveEntry(roots: readonly LibraryRoot[], rootLabel: string, kind: string, name: string): Promise<ResolvedEntry> {
  const root = roots.find((r) => r.label === rootLabel);
  if (!root) throw new LibraryError(404, `no library root "${rootLabel}" (have: ${roots.map((r) => r.label).join(", ")})`);
  if (!(ENTRY_KINDS as readonly string[]).includes(kind)) throw new LibraryError(404, `no entry kind "${kind}" (${ENTRY_KINDS.join(", ")})`);
  checkAddressName(name);
  const e = (await rootEntries(root, kind as EntryKind)).find((x) => x.name === name);
  if (!e) throw new LibraryError(404, `no ${kind.replace(/s$/, "")} "${name}" in ${rootLabel}`);
  inside(root, e.target);
  return e;
}

function inside(root: LibraryRoot, path: string): void {
  const r = resolve(root.path);
  const p = resolve(path);
  if (p !== r && !p.startsWith(r + sep)) throw new LibraryError(403, "that entry resolves outside its root");
}

const exists = async (p: string) => !!(await stat(p).catch(() => undefined));

/** A new name for an entry of a writable root: ENTRY_NAME per segment (sub-folders only where the kind has them). */
function checkNewName(kind: EntryKind, name: string): void {
  const segs = name.split("/");
  if (kind === "prefabs" || kind === "palettes" ? segs.length !== 1 : segs.length > 4) throw new LibraryError(400, `a ${kind.replace(/s$/, "")} name ${kind === "prefabs" || kind === "palettes" ? "can't contain /" : "has at most 4 parts"}`);
  for (const s of segs) if (!ENTRY_NAME.test(s)) throw new LibraryError(400, `"${name}": names use letters, digits, _ or - (each part starts with a letter or digit, at most 64)`);
}

/** Where an entry named `name` of `kind` lives in `root`, shaped like `like` (a prefab folder or a loose file). */
function targetFor(root: LibraryRoot, kind: EntryKind, name: string, like: ResolvedEntry): string {
  const ext = like.target === like.file ? extname(like.file) : "";
  const p = join(root.path, kind, ...name.split("/")) + (kind === "prefabs" ? ext : kind === "palettes" ? ".json" : kind === "procedures" ? ".js" : ".md");
  inside(root, p);
  return p;
}

function writable(e: ResolvedEntry): void {
  if (e.rootRef.readOnly) throw new LibraryError(409, `${e.root} is read-only: copy the entry to your library first`);
}

/** Keeps a renamed or copied entry's own `name` field in step when it matched the old name. */
async function renameInside(e: ResolvedEntry, target: string, from: string, to: string): Promise<void> {
  const json = e.kind === "palettes" ? target : e.kind === "prefabs" && e.target !== e.file ? join(target, "prefab.json") : undefined;
  if (!json) return;
  try {
    const data = JSON.parse(await readFile(json, "utf8")) as { name?: unknown };
    if (data.name !== from) return;
    data.name = to;
    await writeFile(json, JSON.stringify(data, null, 2) + "\n");
  } catch {
    /* no metadata, or unreadable: left as it is */
  }
}

export async function renameEntry(e: ResolvedEntry, to: string): Promise<{ name: string }> {
  writable(e);
  checkNewName(e.kind, to);
  const target = targetFor(e.rootRef, e.kind, to, e);
  if (await exists(target)) throw new LibraryError(409, `${e.root} already has a ${e.kind.replace(/s$/, "")} "${to}"`);
  await mkdir(dirname(target), { recursive: true });
  await rename(e.target, target);
  await renameInside(e, target, e.name, to);
  return { name: to };
}

export async function duplicateEntry(e: ResolvedEntry, to: string): Promise<{ name: string }> {
  writable(e);
  checkNewName(e.kind, to);
  const target = targetFor(e.rootRef, e.kind, to, e);
  if (await exists(target)) throw new LibraryError(409, `${e.root} already has a ${e.kind.replace(/s$/, "")} "${to}"`);
  await mkdir(dirname(target), { recursive: true });
  await cp(e.target, target, { recursive: true, errorOnExist: true, force: false });
  await renameInside(e, target, e.name, to);
  return { name: to };
}

/** Copies an entry of a read-only root into the first writable root under the same name (its last part for an Axiom blueprint). */
export async function copyToLibrary(e: ResolvedEntry, roots: readonly LibraryRoot[]): Promise<{ root: string; name: string }> {
  if (!e.rootRef.readOnly) throw new LibraryError(409, `${e.name} is already in a writable root`);
  const dest = writableRoot(roots);
  const name = e.rootRef.kind === "axiom" ? e.name.split("/").pop()! : e.name;
  const target = targetFor(dest, e.kind, name, e);
  if (await exists(target)) throw new LibraryError(409, `${dest.label} already has a ${e.kind.replace(/s$/, "")} "${name}"`);
  await mkdir(dirname(target), { recursive: true });
  await cp(e.target, target, { recursive: true, errorOnExist: true, force: false });
  return { root: dest.label, name };
}

// -- trash -------------------------------------------------------------------------------------------

export interface TrashItem {
  id: string;
  kind: EntryKind;
  name: string;
  deletedAt: string;
}

const TRASH = ".trash";
const MANIFEST = "entry.json";

/** Moves an entry into `<root>/.trash/<id>/`, where listings never look; `restoreEntry` puts it back unchanged. */
export async function deleteEntry(e: ResolvedEntry): Promise<TrashItem> {
  writable(e);
  const now = new Date();
  const id = `${now.toISOString().replace(/[-:.]/g, "").replace("T", "-").slice(0, 15)}-${randomBytes(3).toString("hex")}`;
  const dir = join(e.rootRef.path, TRASH, id);
  const rel = relative(e.rootRef.path, e.target);
  await mkdir(join(dir, dirname(rel)), { recursive: true });
  await rename(e.target, join(dir, rel));
  const item: TrashItem = { id, kind: e.kind, name: e.name, deletedAt: now.toISOString() };
  await writeFile(join(dir, MANIFEST), JSON.stringify({ ...item, path: rel.split(sep).join("/") }, null, 2) + "\n");
  return item;
}

export async function listTrash(root: LibraryRoot): Promise<TrashItem[]> {
  const out: TrashItem[] = [];
  for (const id of (await readdir(join(root.path, TRASH)).catch(() => [] as string[])).sort().reverse()) {
    try {
      const m = JSON.parse(await readFile(join(root.path, TRASH, id, MANIFEST), "utf8")) as TrashItem;
      out.push({ id, kind: m.kind, name: m.name, deletedAt: m.deletedAt });
    } catch {
      /* not one of ours */
    }
  }
  return out;
}

export async function restoreEntry(root: LibraryRoot, id: string): Promise<TrashItem> {
  if (root.readOnly) throw new LibraryError(409, `${root.label} is read-only`);
  if (!/^[\w-]+$/.test(id)) throw new LibraryError(400, `"${id}" isn't a trash id`);
  const dir = join(root.path, TRASH, id);
  let m: TrashItem & { path: string };
  try {
    m = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as TrashItem & { path: string };
  } catch {
    throw new LibraryError(404, `nothing in ${root.label}'s trash with id ${id}`);
  }
  const back = join(root.path, ...m.path.split("/"));
  inside(root, back);
  if (back.startsWith(join(root.path, TRASH))) throw new LibraryError(400, "bad trash entry");
  if (await exists(back)) throw new LibraryError(409, `${root.label} has a new ${m.kind.replace(/s$/, "")} "${m.name}" since; rename it first`);
  await mkdir(dirname(back), { recursive: true });
  await rename(join(dir, ...m.path.split("/")), back);
  await rm(dir, { recursive: true, force: true });
  return { id, kind: m.kind, name: m.name, deletedAt: m.deletedAt };
}

export async function emptyTrash(root: LibraryRoot): Promise<number> {
  if (root.readOnly) throw new LibraryError(409, `${root.label} is read-only`);
  const n = (await listTrash(root)).length;
  await rm(join(root.path, TRASH), { recursive: true, force: true });
  return n;
}
