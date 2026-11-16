import type { LibraryHost } from "../observe/library-api.js";
import type { InstanceContext } from "./context.js";
import type { Session } from "./session.js";
import { libraryFor, rootsFor } from "./tools/library-context.js";
import { bakerFor } from "./tools/shared.js";

/**
 * The management UI's view of the library (docs/design/15-management-ui.md, *Library tab*): the
 * same roots the tools use (`rootsFor`: `library.*` settings read now, the loaded instance's Axiom
 * folder), thumbnails through the same `Library` (cached, embedded, or rendered with the instance),
 * and the instance's baker for 3D previews. Without a loaded instance, there is no Axiom root, no
 * rendering, and previews draw in flat colours.
 */
export function makeLibraryHost(session: Session): LibraryHost {
  let loaded: InstanceContext | undefined;
  void session.whenInstance().then((c) => (loaded = c));
  const ctx = (): InstanceContext | undefined => loaded;
  return {
    roots: () => rootsFor(session, ctx()),
    async thumbnail(p) {
      const c = ctx();
      if (c) return libraryFor(c, session).thumbnail(p);
      const { prefabThumbnail } = await import("../library/prefabs.js");
      const { defaultCacheDir } = await import("../assets/cache.js");
      return prefabThumbnail(p, { cacheDir: defaultCacheDir() });
    },
    baker: async () => {
      const c = ctx();
      return c ? bakerFor(c) : undefined;
    },
    registry: () => ctx()?.registry,
    paletteIndex: () => ctx()?.palette,
  };
}
