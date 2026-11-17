import { readFile } from "node:fs/promises";
import type { Registry } from "../assets/registry.js";
import type { Vec3 } from "../core/region.js";
import { importFile } from "../formats/index.js";
import {
  copyToLibrary,
  deleteEntry,
  duplicateEntry,
  editableFile,
  emptyTrash,
  ENTRY_KINDS,
  entryHash,
  listEntries,
  listTrash,
  renameEntry,
  resolveEntry,
  restoreEntry,
  type ResolvedEntry,
} from "../library/manage.js";
import type { Prefab } from "../library/prefabs.js";
import { LIBRARY_HIDDEN, type LibraryRoot } from "../library/roots.js";
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
