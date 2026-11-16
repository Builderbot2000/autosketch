import type { Registry } from "../assets/registry.js";
import { ConfigConflictError, readConfig, writeConfig } from "../core/config.js";
import { importFile } from "../formats/index.js";
import {
  copyToLibrary,
  deleteEntry,
  duplicateEntry,
  emptyTrash,
  ENTRY_KINDS,
  LibraryError,
  listEntries,
  listTrash,
  renameEntry,
  resolveEntry,
  restoreEntry,
  type ResolvedEntry,
} from "../library/manage.js";
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
    if (e.kind !== "prefabs") {
      const { readFile } = await import("node:fs/promises");
      out.text = await readFile(file, "utf8");
    }
    return out;
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
