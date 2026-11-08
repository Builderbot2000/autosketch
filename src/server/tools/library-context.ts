import { defaultCacheDir } from "../../assets/cache.js";
import { dataVersionFor } from "../../core/version.js";
import { documentFromSnapshot } from "../../formats/snapshot.js";
import { Library } from "../../library/index.js";
import { libraryRoots, type LibraryRoot } from "../../library/roots.js";
import { renderDocument } from "../../perception/render/render.js";
import type { InstanceContext } from "../context.js";
import type { Session } from "../session.js";
import { bakerFor } from "./shared.js";

/**
 * The library a tool call works with (07). Kept apart from tools/library.ts so the script and
 * palette tools can use it without importing the library tool module.
 */

/** Library roots for this server: AUTOSKETCH_LIBRARY or <workspace>/library, the starter library, and the instance's Axiom blueprints. */
export function rootsFor(session: Session, c?: InstanceContext): LibraryRoot[] {
  return libraryRoots({ workspace: session.workspace, env: process.env, ...(c?.info.root ? { instanceRoot: c.info.root } : {}) });
}

const libraries = new WeakMap<InstanceContext, Library>();

/** One library per loaded instance (it remembers the last prefab sheet for cell refs). */
export function libraryFor(c: InstanceContext, session: Session): Library {
  let lib = libraries.get(c);
  if (!lib) {
    const dataVersion = dataVersionFor(c.info.mcVersion) ?? 0;
    lib = new Library({
      roots: rootsFor(session, c),
      registry: c.registry,
      cacheDir: defaultCacheDir(),
      thumbnail: async (snap) => {
        const doc = documentFromSnapshot(snap, { name: "thumbnail", dataVersion, source: "prefab" });
        return (await renderDocument(doc, await bakerFor(c), { views: ["iso_se"], size: 96, thumbnail: true })).png;
      },
    });
    libraries.set(c, lib);
  }
  return lib;
}
