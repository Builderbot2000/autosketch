import { readFile } from "node:fs/promises";
import type { Registry } from "../assets/registry.js";
import { ConfigConflictError, readConfig, writeConfig } from "../core/config.js";
import { importFile } from "../formats/index.js";
import {
  copyToLibrary,
  deleteEntry,
  duplicateEntry,
  editableFile,
  entryHash,
  emptyTrash,
  ENTRY_KINDS,
  LibraryError,
  listEntries,
  listTrash,
  renameEntry,
  resolveEntry,
  restoreEntry,
  writeEntryText,
  writePaletteFile,
  writePrefabMeta,
  type ResolvedEntry,
} from "../library/manage.js";
import type { PaletteFileMember } from "../library/palettes.js";
import { rgbToHex } from "../palette/color.js";
import type { PaletteIndex } from "../palette/index.js";
import { editPalette, type NamedPalette, type PaletteEdit, type RoleMember } from "../palette/pick.js";
import type { Prefab } from "../library/prefabs.js";
import { LIBRARY_HIDDEN, type LibraryRoot } from "../library/roots.js";
import type { BlockBaker } from "../perception/render/bake.js";
import { bakeModels, type Atlas } from "./atlas.js";
import { openInBrowser } from "./open.js";
import type { ApiReply } from "./settings-api.js";
import { StateIds } from "./states.js";
import { encodeVoxels } from "./voxels.js";

/**
 * The Library tab's endpoints (docs/design/15-management-ui.md, *Library tab*, *Endpoints*). Entries
 * are addressed as `<root label>/<kind>/<name>`, never by path (library/manage.ts resolves them):
 *
 *   GET    /api/library                                    roots (with counts and trash), entries per kind
 *                                                          with origin, shadowing and hidden flags
 *   GET    /api/library/<root>/<kind>/<name>               one entry: metadata, and its text for text kinds
 *   GET    /api/library/<root>/prefabs/<name>?thumb        the prefab's thumbnail (PNG)
 *   GET    /api/library/<root>/prefabs/<name>?preview      voxels and baked models for the 3D preview
 *   POST   /api/library/<root>/<kind>/<name>/rename        {to}
 *   POST   …/duplicate {to} | …/copy | …/hide | …/unhide | …/delete
 *   PUT    /api/library/<root>/<kind>/<name>               {hash, text | metadata | palette edits} (U3b; 409 on a stale hash)
 *   GET    /api/library/<root>/trash                       what that root's trash holds
 *   POST   /api/library/<root>/trash/<id>/restore,  DELETE /api/library/<root>/trash
 *   POST   /api/library/<root>/open                        opens the root folder in the OS file manager
 *
 * Hiding writes `library.hidden` in config.toml (compare-and-set, like every UI write).
 */

export interface LibraryHost {
  /** The roots in search order, as the tools see them now (`library.*` settings, the loaded instance's Axiom folder). */
  roots(): LibraryRoot[];
  /** A prefab's thumbnail: cached, embedded, or rendered with the instance when one is loaded. */
  thumbnail?(p: Prefab): Promise<Buffer | undefined>;
  /** The block baker for 3D previews (undefined without an instance: blocks then draw in flat colours). */
  baker?(): Promise<BlockBaker | undefined>;
  registry?(): Registry | undefined;
  /** The instance's palette index, for palette member edits (U3b). */
  paletteIndex?(): PaletteIndex | undefined;
}

/** The body of an editor's write (`PUT /api/library/<root>/<kind>/<name>`, U3b). */
interface EntryWrite {
  hash?: unknown;
  text?: unknown;
  metadata?: unknown;
  edit?: PaletteEdit;
  addBlocks?: Record<string, string[]>;
  tags?: string[];
  notes?: string;
}

const ACTIONS = new Set(["rename", "duplicate", "copy", "hide", "unhide", "delete"]);

export class LibraryApi {
  constructor(
    private readonly host: LibraryHost,
    private readonly configPath: string,
    private readonly atlas: Atlas,
    private readonly log?: (msg: string) => void,
  ) {}

  async view(): Promise<unknown> {
    const roots = this.host.roots();
    const entries = await listEntries(roots);
    return {
      roots: await Promise.all(
        roots.map(async (r) => ({
          label: r.label,
          path: r.path,
          kind: r.kind,
          writable: !r.readOnly,
          counts: Object.fromEntries(ENTRY_KINDS.map((k) => [k, entries[k].filter((e) => e.root === r.label).length])),
          trash: r.readOnly ? 0 : (await listTrash(r)).length,
        })),
      ),
      entries,
      hidden: [...(roots.find((r) => r.hidden)?.hidden ?? [])],
    };
  }

  /** `rel` is the path after `/api/library/`, still URL-encoded per segment. */
  async handle(rel: string, method: string, params: URLSearchParams, body: () => Promise<unknown>): Promise<ApiReply | { status: 200; type: string; data: Buffer }> {
    try {
      return await this.route(rel.split("/").map(decodeURIComponent), method, params, body);
    } catch (e) {
      if (e instanceof LibraryError) return { status: e.status, body: { error: e.message } };
      if (e instanceof ConfigConflictError) return { status: 409, body: { error: e.message, conflict: true } };
      throw e;
    }
  }

  private async route(parts: string[], method: string, params: URLSearchParams, body: () => Promise<unknown>): Promise<ApiReply | { status: 200; type: string; data: Buffer }> {
    const read = method === "GET" || method === "HEAD";
    const roots = this.host.roots();
    const [label, second, ...rest] = parts;
    const root = roots.find((r) => r.label === label);
    if (!label || !root) return { status: 404, body: { error: `no library root "${label ?? ""}"` } };

    if (second === "open" && rest.length === 0) {
      if (method !== "POST") return { status: 405, body: { error: "POST opens the folder" } };
      openInBrowser(root.path, this.log);
      return { status: 200, body: { opened: root.path } };
    }
    if (second === "trash") {
      if (rest.length === 0) {
        if (read) return { status: 200, body: { trash: await listTrash(root) } };
        if (method === "DELETE") return { status: 200, body: { emptied: await emptyTrash(root) } };
      } else if (rest.length === 2 && rest[1] === "restore" && method === "POST") return { status: 200, body: { restored: await restoreEntry(root, rest[0]!) } };
      return { status: 405, body: { error: "GET lists the trash, DELETE empties it, POST trash/<id>/restore restores one" } };
    }

    const kind = second ?? "";
    let name = rest.join("/");
    let action: string | undefined;
    if (method === "PUT") {
      const e = await resolveEntry(roots, label, kind, name);
      return this.put(e, ((await body()) ?? {}) as EntryWrite);
    }
    if (!read) {
      action = rest[rest.length - 1];
      if (!action || !ACTIONS.has(action)) return { status: 405, body: { error: `POST …/<name>/{${[...ACTIONS].join("|")}}` } };
      if (method !== "POST") return { status: 405, body: { error: "actions are POSTs" } };
      name = rest.slice(0, -1).join("/");
    }
    const e = await resolveEntry(roots, label, kind, name);
    if (read) {
      if (params.has("thumb")) return this.thumb(e);
      if (params.has("preview")) return this.preview(e);
      return { status: 200, body: await this.detail(e) };
    }
    const b = ((await body()) ?? {}) as { to?: unknown; hash?: unknown };
    const to = typeof b.to === "string" ? b.to.trim() : "";
    switch (action) {
      case "rename":
        return { status: 200, body: { renamed: await renameEntry(e, to) } };
      case "duplicate":
        return { status: 200, body: { duplicated: await duplicateEntry(e, to) } };
      case "copy":
        return { status: 200, body: { copied: await copyToLibrary(e, roots) } };
      case "delete":
        return { status: 200, body: { trashed: await deleteEntry(e) } };
      default:
        return { status: 200, body: { hidden: this.setHidden(e, action === "hide", typeof b.hash === "string" ? b.hash : undefined) } };
    }
  }

  private async detail(e: ResolvedEntry): Promise<unknown> {
    const { rootRef: _r, target: _t, file, prefab, ...entry } = e;
    const out: Record<string, unknown> = { ...entry };
    if (prefab) out.meta = prefab.meta;
    if (e.kind !== "prefabs") out.text = await readFile(file, "utf8");
    if (e.kind === "palettes") {
      try {
        out.palette = JSON.parse(out.text as string);
      } catch {
        /* shown as text */
      }
    }
    // What an editor sends back with its write (U3b): the editable file's hash, and whether there is one.
    out.hash = await entryHash(e);
    out.editable = e.writable && editableFile(e) !== undefined;
    return out;
  }

  /**
   * U3b: an editor's whole-entry write, refused with 409 when the file changed since the editor
   * read it (`hash`). Text for procedures and knowledge packs, `prefab.json` fields for prefabs,
   * and for palettes `tags`, `notes` and the `palette_edit` operations (`editPalette`, `03`) plus
   * `addBlocks` (members by block id), which need the instance's palette index.
   */
  private async put(e: ResolvedEntry, b: EntryWrite): Promise<ApiReply> {
    if (e.kind === "procedures" || e.kind === "knowledge") return { status: 200, body: { hash: await writeEntryText(e, b.text, b.hash) } };
    if (e.kind === "prefabs") return { status: 200, body: { hash: await writePrefabMeta(e, b.metadata, b.hash) } };
    if (typeof b.hash !== "string") throw new LibraryError(400, "a write needs the hash of the version it edits");
    if ((await entryHash(e)) !== b.hash) throw new LibraryError(409, `palette "${e.name}" changed since it was opened (the agent may have saved it); reload it and edit again`);
    let raw: Record<string, unknown> & { roles?: Record<string, PaletteFileMember[]> };
    try {
      raw = JSON.parse(await readFile(e.file, "utf8"));
    } catch (err) {
      throw new LibraryError(409, `palette "${e.name}" can't be read (${(err as Error).message}); fix the file by hand`);
    }
    const warnings: string[] = [];
    const memberEdit = b.edit && Object.keys(b.edit).length ? b.edit : undefined;
    if (memberEdit || (b.addBlocks && Object.keys(b.addBlocks).length)) {
      const index = this.host.paletteIndex?.();
      if (!index) throw new LibraryError(409, "changing a palette's members needs the instance's blocks: load an instance first (tags and notes can be edited without one)");
      const colors = new Map<string, string>();
      const roles: Record<string, RoleMember[]> = {};
      for (const [role, ms] of Object.entries(raw.roles ?? {})) {
        roles[role] = ms.map((m) => ({ family: m.family, block: m.block, weight: m.weight }));
        for (const m of ms) if (m.color) colors.set(m.block, m.color);
      }
      for (const [role, ids] of Object.entries(b.addBlocks ?? {})) {
        for (const id0 of ids) {
          const id = id0.includes(":") ? id0.trim() : `minecraft:${id0.trim()}`;
          const fam = index.familyOfBlock(id);
          if (!fam) {
            warnings.push(`${role}: ${id} is not a building block in this instance; not added`);
            continue;
          }
          const cur = (roles[role] ??= []);
          if (cur.some((m) => m.block === id)) continue;
          const share = cur.length ? cur.reduce((sum, m) => sum + m.weight, 0) / cur.length : 1;
          cur.push({ family: fam.id, block: id, weight: share });
        }
      }
      let named: NamedPalette = { name: String(raw.name ?? e.name), roles, source: (raw.source as NamedPalette["source"]) ?? { sheet: "overview", page: 1 } };
      if (memberEdit) {
        try {
          const r = editPalette(index, named, memberEdit);
          named = r.palette;
          warnings.push(...r.warnings);
        } catch (err) {
          throw new LibraryError(400, (err as Error).message);
        }
      }
      const out: Record<string, PaletteFileMember[]> = {};
      for (const [role, ms] of Object.entries(named.roles)) {
        const total = ms.reduce((sum, m) => sum + m.weight, 0) || 1;
        out[role] = ms.map((m) => {
          const color = colors.get(m.block) ?? (index.stats(m.family) ? rgbToHex(index.stats(m.family)!.rgb) : undefined);
          return { family: m.family, block: m.block, weight: Math.round((m.weight / total) * 1000) / 1000, ...(color ? { color } : {}) };
        });
      }
      raw.roles = out;
    }
    if (b.tags !== undefined) {
      if (!Array.isArray(b.tags) || !b.tags.every((t) => typeof t === "string")) throw new LibraryError(400, "tags must be a list of text");
      raw.tags = [...new Set(b.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    }
    if (b.notes !== undefined) {
      if (typeof b.notes !== "string") throw new LibraryError(400, "notes must be text");
      if (b.notes.trim()) raw.notes = b.notes;
      else delete raw.notes;
    }
    return { status: 200, body: { hash: await writePaletteFile(e, raw, b.hash), warnings } };
  }

  private async thumb(e: ResolvedEntry): Promise<ApiReply | { status: 200; type: string; data: Buffer }> {
    if (!e.prefab) return { status: 404, body: { error: "only prefabs have thumbnails" } };
    const png = await this.host.thumbnail?.(e.prefab).catch(() => undefined);
    if (!png) return { status: 404, body: { error: "no thumbnail (load an instance to render one)" } };
    return { status: 200, type: "image/png", data: png };
  }

  /** The prefab's blocks in the viewer's voxel format, with its own state table and baked models (none without an instance). */
  private async preview(e: ResolvedEntry): Promise<ApiReply> {
    if (!e.prefab) return { status: 404, body: { error: "only prefabs have a 3D preview" } };
    const registry = this.host.registry?.();
    const imp = await importFile(e.file, { name: "preview", ...(registry ? { registry } : {}) });
    const table = new StateIds(() => {});
    const voxels = Buffer.concat(encodeVoxels(imp.doc, "preview", table, 0));
    const baker = await this.host.baker?.().catch(() => undefined);
    const models = baker ? await bakeModels(baker, this.atlas, table.states.map((s, i) => [i, s] as const)) : null;
    return { status: 200, body: { voxels: voxels.toString("base64"), models, warnings: imp.warnings } };
  }

  /** Adds or removes `<kind>/<name>` in `library.hidden` (config.toml). Only read-only roots' entries hide. */
  private setHidden(e: ResolvedEntry, hide: boolean, expected?: string): boolean {
    if (!e.rootRef.readOnly) throw new LibraryError(409, "hiding is for starter and Axiom entries; delete your own entries instead (they go to the trash)");
    const snap = readConfig(this.configPath);
    if (expected !== undefined && expected !== snap.hash) throw new LibraryError(409, "config.toml changed since it was read; reload and try again");
    if (snap.warnings.length) throw new LibraryError(409, `${this.configPath} has problems; fix them by hand first`);
    const key = `${e.kind}/${e.name}`;
    // From the effective list (config.toml, else a launch value), so saving never drops what was hidden.
    const list = [...(e.rootRef.hidden ?? [])].filter((x) => x !== key);
    if (hide) list.push(key);
    const settings = { ...snap.config.settings };
    if (list.length) settings[LIBRARY_HIDDEN.key] = list.join(", ");
    else delete settings[LIBRARY_HIDDEN.key];
    writeConfig({ ...snap.config, settings }, snap.hash, this.configPath);
    return hide;
  }
}
