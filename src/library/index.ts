import type { Registry } from "../assets/registry.js";
import type { Vec3 } from "../core/region.js";
import { findPrefab, prefabSize, prefabThumbnail, scanPrefabs, searchPrefabs, type Prefab, type PrefabQuery, type ThumbnailRenderer } from "./prefabs.js";
import type { LibraryRoot } from "./roots.js";
import { layoutPrefabSheet, prefabAtCell, prefabSheetCaption, renderPrefabSheet, type PrefabSheetLayout } from "./sheet.js";

/**
 * The library (docs/design/07-library.md) over a list of roots: what the tools call. Entries are
 * plain files, re-read on each call so edits made outside the server show up at once. The only
 * state is the most recent prefab sheet, so `stamp({prefab:"B3"})` can refer to its cells.
 */

export interface LibraryOptions {
  roots: LibraryRoot[];
  registry?: Registry;
  /** Renders thumbnails for prefabs that have none (the server passes the 06 renderer). */
  thumbnail?: ThumbnailRenderer;
  /** Where thumbnails of read-only prefabs are cached. */
  cacheDir?: string;
}

export interface PrefabSheet {
  layout: PrefabSheetLayout;
  png: Buffer;
  caption: string;
}

export class Library {
  private lastSheet?: PrefabSheetLayout;

  constructor(readonly opts: LibraryOptions) {}

  get roots(): LibraryRoot[] {
    return this.opts.roots;
  }

  prefabs(): Promise<Prefab[]> {
    return scanPrefabs(this.roots);
  }

  async search(q: PrefabQuery): Promise<Prefab[]> {
    return searchPrefabs(await this.prefabs(), q, this.opts.registry);
  }

  size(p: Prefab): Promise<Vec3> {
    return prefabSize(p, this.opts.registry);
  }

  thumbnail(p: Prefab): Promise<Buffer | undefined> {
    return prefabThumbnail(p, { ...(this.opts.thumbnail ? { render: this.opts.thumbnail } : {}), ...(this.opts.cacheDir ? { cacheDir: this.opts.cacheDir } : {}), ...(this.opts.registry ? { registry: this.opts.registry } : {}) });
  }

  /** Renders a page of prefab thumbnails and remembers its cells for stamp. */
  async sheet(q: PrefabQuery & { page?: number }): Promise<PrefabSheet | undefined> {
    const list = q.query || q.tags?.length || q.maxFootprint ? await this.search(q) : await this.prefabs();
    if (!list.length) return undefined;
    const spec = [q.query ? `query:"${q.query}"` : "", q.tags?.length ? `tags:${q.tags.join(",")}` : "", q.maxFootprint ? `max_footprint:${q.maxFootprint.join("×")}` : ""].filter(Boolean).join(" ") || "all";
    const layout = layoutPrefabSheet(list, spec, q.page ?? 1);
    const byId = new Map(list.map((p) => [p.id, p]));
    const onPage = layout.cells.map((id) => byId.get(id)!);
    const [thumbs, sizes] = await Promise.all([
      Promise.all(onPage.map((p) => this.thumbnail(p).catch(() => undefined))),
      Promise.all(onPage.map((p) => this.size(p).catch(() => undefined))),
    ]);
    this.lastSheet = layout;
    return { layout, png: renderPrefabSheet(layout, thumbs), caption: prefabSheetCaption(layout, byId, sizes) };
  }

  /** A prefab by id, display name, or cell of the last prefab sheet. */
  async resolve(ref: string): Promise<Prefab> {
    const all = await this.prefabs();
    const exact = all.find((p) => p.id === ref);
    if (exact) return exact;
    if (/^[A-Z]+\d+$/.test(ref.trim())) {
      if (!this.lastSheet) throw new Error(`"${ref}" looks like a sheet cell, but no prefab_sheet has been shown yet; call prefab_sheet first or give the prefab's name`);
      return findPrefab(all, prefabAtCell(this.lastSheet, ref)!);
    }
    return findPrefab(all, ref);
  }
}

export { libraryRoots, starterRoot, writableRoot, type LibraryRoot } from "./roots.js";
