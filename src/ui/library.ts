import { readFile } from "node:fs/promises";
import type { Registry } from "../assets/registry.js";
import type { Vec3 } from "../core/region.js";
import { importFile } from "../formats/index.js";
import type { PaletteFileMember } from "../library/palettes.js";
import {
  copyToLibrary,
  deleteEntry,
  duplicateEntry,
  editableFile,
  EntryChangedError,
  emptyTrash,
  ENTRY_KINDS,
  entryHash,
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
import type { Prefab } from "../library/prefabs.js";
import { LIBRARY_HIDDEN, type LibraryRoot } from "../library/roots.js";
import { rgbToHex } from "../palette/color.js";
import type { PaletteIndex } from "../palette/index.js";
import { editPalette, type NamedPalette, type PaletteEdit, type RoleMember } from "../palette/pick.js";
import { encodePreviewBody } from "../world/protocol/body.js";
import { UiRequestError } from "./errors.js";
import type { SettingsRows } from "./settings.js";

/**
 * Library requests for the in-game library screen (docs/design/16-in-game-ui.md, *Library screen*;
 * `13`, the `library.*` kinds), rewritten from the browser's `/api/library` (`15`, *Library tab*)
 * over the same `library/manage.ts` and `library/roots.ts`. Entries are addressed by root label,
 * kind and name, never by path (`resolveEntry` checks them).
 */

export interface LibraryHost {
  /** The roots in search order, as the tools see them now (`library.*` settings, the loaded instance's Axiom folder). */
  roots(): LibraryRoot[];
  /** A prefab's thumbnail: cached, embedded, or rendered with the instance when one is loaded. */
  thumbnail?(p: Prefab): Promise<Buffer | undefined>;
  registry?(): Registry | undefined;
  /** The loaded instance's palette index, for palette member edits (`library.write.palette`); undefined without an instance. */
  paletteIndex?(): PaletteIndex | undefined;
}

type Args = Record<string, unknown>;

function str(a: Args, key: string): string {
  const v = a[key];
  if (typeof v !== "string" || !v) throw new UiRequestError("bad_request", `${key} must be non-empty text`);
  return v;
}

export class LibraryRequests {
  constructor(
    private readonly host: LibraryHost,
    private readonly settings: SettingsRows,
  ) {}

  async list(): Promise<Record<string, unknown>> {
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

  async entry(a: Args): Promise<Record<string, unknown>> {
    const e = await this.resolve(a);
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
    out.hash = await entryHash(e);
    out.editable = e.writable && editableFile(e) !== undefined;
    return out;
  }

  async thumbnail(a: Args): Promise<{ result: Record<string, unknown>; body: Uint8Array }> {
    const e = await this.resolve({ ...a, kind: "prefabs" });
    const png = e.prefab ? await this.host.thumbnail?.(e.prefab).catch(() => undefined) : undefined;
    if (!png) throw new UiRequestError("not_found", `${e.name} has no thumbnail (load an instance to render one)`);
    if (png.length < 24 || png.toString("latin1", 12, 16) !== "IHDR") throw new UiRequestError("internal", `${e.name}'s thumbnail isn't a PNG`);
    return { result: { format: "png", width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, body: new Uint8Array(png) };
  }

  /** The prefab's blocks, prefab-local from (0,0,0), states only. */
  async preview(a: Args): Promise<{ result: Record<string, unknown>; body: Uint8Array }> {
    const e = await this.resolve({ ...a, kind: "prefabs" });
    const registry = this.host.registry?.();
    const imp = await importFile(e.file, { name: "preview", ...(registry ? { registry } : {}) });
    const doc = imp.doc;
    const b = doc.localBounds();
    const size: Vec3 = b ? [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]] : [1, 1, 1];
    const palette: string[] = [];
    const index = new Map<string, number>();
    const states = new Uint32Array(size[0] * size[1] * size[2]);
    const o = b?.min ?? [0, 0, 0];
    let i = 0;
    for (let y = 0; y < size[1]; y++)
      for (let z = 0; z < size[2]; z++)
        for (let x = 0; x < size[0]; x++, i++) {
          const s = doc.getState(x + o[0], y + o[1], z + o[2]);
          let p = index.get(s);
          if (p === undefined) index.set(s, (p = palette.push(s) - 1));
          states[i] = p;
        }
    return { result: { size }, body: encodePreviewBody(palette, size, states) };
  }

  async rename(a: Args): Promise<Record<string, unknown>> {
    return renameEntry(await this.resolve(a), str(a, "to").trim());
  }

  async duplicate(a: Args): Promise<Record<string, unknown>> {
    return duplicateEntry(await this.resolve(a), str(a, "to").trim());
  }

  async delete(a: Args): Promise<Record<string, unknown>> {
    return { trashed: await deleteEntry(await this.resolve(a)) };
  }

  async trash(a: Args): Promise<Record<string, unknown>> {
    return { trash: await listTrash(this.root(a)) };
  }

  async restore(a: Args): Promise<Record<string, unknown>> {
    return { restored: await restoreEntry(this.root(a), str(a, "id")) };
  }

  async copy(a: Args): Promise<Record<string, unknown>> {
    return copyToLibrary(await this.resolve(a), this.host.roots());
  }

  async emptyTrash(a: Args): Promise<Record<string, unknown>> {
    return { emptied: await emptyTrash(this.root(a)) };
  }

  /** Adds or removes `<kind>/<name>` in `library.hidden` (config.toml, compare-and-set). Only read-only roots' entries hide. */
  async hide(a: Args): Promise<Record<string, unknown>> {
    const e = await this.resolve(a);
    if (typeof a.hidden !== "boolean") throw new UiRequestError("bad_request", "hidden must be true or false");
    const hide = a.hidden;
    if (!e.rootRef.readOnly) throw new UiRequestError("bad_request", "hiding is for starter and Axiom entries; delete your own entries instead (they go to the trash)");
    const key = `${e.kind}/${e.name}`;
    // From the effective list (config.toml, else a launch value), so saving never drops what was hidden.
    const list = [...(e.rootRef.hidden ?? [])].filter((x) => x !== key);
    if (hide) list.push(key);
    const hash = this.settings.write(a.hash, (settings) => {
      const out = { ...settings };
      if (list.length) out[LIBRARY_HIDDEN.key] = list.join(", ");
      else delete out[LIBRARY_HIDDEN.key];
      return out;
    });
    return { hidden: hide, hash };
  }

  // -- editor writes (`17`, piece 6; `13`, *Request kinds*) -------------------------------------------
  //
  // Each names the hash the form started from. A stale one is `conflict` (the form reloads, so a file
  // the agent just saved is never overwritten); a read-only root or a loose schematic file is
  // `bad_request` (the library's refusals, `uiErrorOf`). Every write answers the file's new hash.

  async writePrefab(a: Args): Promise<Record<string, unknown>> {
    const e = await this.resolve({ ...a, kind: "prefabs" });
    return { hash: await changed(() => writePrefabMeta(e, a.meta, a.hash)) };
  }

  async writeProcedure(a: Args): Promise<Record<string, unknown>> {
    const e = await this.resolve({ ...a, kind: "procedures" });
    return { hash: await changed(() => writeEntryText(e, a.text, a.hash)) };
  }

  async writeKnowledge(a: Args): Promise<Record<string, unknown>> {
    const e = await this.resolve({ ...a, kind: "knowledge" });
    return { hash: await changed(() => writeEntryText(e, a.text, a.hash)) };
  }

  /**
   * `tags` and `notes` need nothing loaded; member changes go through `palette_edit`'s operations
   * that need no sheet (`editPalette`, `03`: weights, remove, drop, rename) and `addBlocks` (members
   * by block id at an even share), which need the instance's palette index. Skipped ids are warnings.
   */
  async writePalette(a: Args): Promise<Record<string, unknown>> {
    const e = await this.resolve({ ...a, kind: "palettes" });
    if (e.rootRef.readOnly) throw new UiRequestError("bad_request", `${e.root} is read-only: copy the entry to your library first`);
    if (typeof a.hash !== "string") throw new UiRequestError("bad_request", "a write needs the hash of the version it edits");
    if ((await entryHash(e)) !== a.hash) throw new UiRequestError("conflict", `palette "${e.name}" changed since it was opened (the agent may have saved it); reload it and edit again`);
    const edit = memberEdit(a.edit);
    const addBlocks = blockLists(a.addBlocks, "addBlocks");
    let raw: Record<string, unknown> & { roles?: Record<string, PaletteFileMember[]> };
    try {
      raw = JSON.parse(await readFile(e.file, "utf8"));
    } catch (err) {
      throw new UiRequestError("bad_request", `palette "${e.name}" can't be read (${(err as Error).message}); fix the file by hand`);
    }
    const warnings: string[] = [];
    if (edit || addBlocks) {
      const index = this.host.paletteIndex?.();
      if (!index) throw new UiRequestError("bad_request", "Changing a palette's members needs the instance's blocks: load an instance first (tags and notes can be edited without one).");
      const colors = new Map<string, string>();
      const roles: Record<string, RoleMember[]> = {};
      for (const [role, ms] of Object.entries(raw.roles ?? {})) {
        roles[role] = ms.map((m) => ({ family: m.family, block: m.block, weight: m.weight }));
        for (const m of ms) if (m.color) colors.set(m.block, m.color);
      }
      for (const [role, ids] of Object.entries(addBlocks ?? {})) {
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
      if (edit) {
        try {
          const r = editPalette(index, named, edit);
          named = r.palette;
          warnings.push(...r.warnings);
        } catch (err) {
          throw new UiRequestError("bad_request", (err as Error).message);
        }
      }
      const out: Record<string, PaletteFileMember[]> = {};
      for (const [role, ms] of Object.entries(named.roles)) {
        const total = ms.reduce((sum, m) => sum + m.weight, 0) || 1;
        out[role] = ms.map((m) => {
          const stats = index.stats(m.family);
          const color = colors.get(m.block) ?? (stats ? rgbToHex(stats.rgb) : undefined);
          return { family: m.family, block: m.block, weight: Math.round((m.weight / total) * 1000) / 1000, ...(color ? { color } : {}) };
        });
      }
      raw.roles = out;
    }
    if (a.tags !== undefined) {
      if (!Array.isArray(a.tags) || !a.tags.every((t) => typeof t === "string")) throw new UiRequestError("bad_request", "tags must be a list of text");
      raw.tags = [...new Set((a.tags as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean))];
    }
    if (a.notes !== undefined) {
      if (typeof a.notes !== "string") throw new UiRequestError("bad_request", "notes must be text");
      if (a.notes.trim()) raw.notes = a.notes;
      else delete raw.notes;
    }
    return { hash: await changed(() => writePaletteFile(e, raw, a.hash)), warnings };
  }

  private root(a: Args): LibraryRoot {
    const label = str(a, "root");
    const r = this.host.roots().find((x) => x.label === label);
    if (!r) throw new UiRequestError("not_found", `no library root "${label}"`);
    return r;
  }

  private resolve(a: Args): Promise<ResolvedEntry> {
    return resolveEntry(this.host.roots(), str(a, "root"), str(a, "kind"), str(a, "name"));
  }
}

/** The library's stale-hash refusal as `conflict`; its other refusals map through `uiErrorOf`. */
async function changed<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (e) {
    if (e instanceof EntryChangedError) throw new UiRequestError("conflict", e.message);
    throw e;
  }
}

const MEMBER_OPS = ["weights", "remove", "drop", "rename"] as const;

/** The `palette_edit` operations the editor may send (no cell refs: there is no sheet in game); undefined when empty. */
function memberEdit(v: unknown): PaletteEdit | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new UiRequestError("bad_request", `edit must be an object of ${MEMBER_OPS.join(", ")}`);
  const extra = Object.keys(v).filter((k) => !(MEMBER_OPS as readonly string[]).includes(k));
  if (extra.length) throw new UiRequestError("bad_request", `edit takes only ${MEMBER_OPS.join(", ")} in game (not ${extra.join(", ")}); add members by block id with addBlocks`);
  const o = v as PaletteEdit;
  if (o.drop !== undefined && (!Array.isArray(o.drop) || !o.drop.every((r) => typeof r === "string"))) throw new UiRequestError("bad_request", "edit.drop must be a list of role names");
  for (const k of ["weights", "remove", "rename"] as const) if (o[k] !== undefined && (typeof o[k] !== "object" || o[k] === null || Array.isArray(o[k]))) throw new UiRequestError("bad_request", `edit.${k} must map role names`);
  return Object.keys(o).length ? o : undefined;
}

/** `{role: [block id…]}`; undefined when absent or empty. */
function blockLists(v: unknown, key: string): Record<string, string[]> | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v) || !Object.values(v).every((ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"))) throw new UiRequestError("bad_request", `${key} must map role names to lists of block ids`);
  const o = v as Record<string, string[]>;
  return Object.keys(o).length ? o : undefined;
}
