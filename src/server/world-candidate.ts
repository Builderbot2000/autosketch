import { Mask } from "../core/mask.js";
import { resolveSelection } from "../ops/selection.js";
import type { FeedHost } from "../ui/feed.js";
import { CANDIDATE } from "../world/select/fill.js";
import type { WorldView } from "../world/view.js";

/**
 * The select candidate as the in-game UI's feed draws it (docs/design/18-select.md, piece 8): the
 * world view's named selection `candidate` while its request holds (the view empties itself when the
 * request changes or ends, so the shell goes with it), keyed by the stored selection itself, so the
 * feed rebuilds the shell exactly when `world_fill`, `world_expand` or `select` replaces it. Here in
 * `server/` because it resolves a selection (`ops/`), which neither `ui/` nor `world/` imports.
 */
export function worldCandidate(view: WorldView): ReturnType<NonNullable<FeedHost["candidate"]>> {
  const sel = view.doc.selections.get(CANDIDATE);
  const dimension = view.dimension;
  if (sel === undefined || !dimension) return undefined;
  const doc = view.doc;
  return {
    key: sel,
    dimension,
    mask: () => {
      try {
        return resolveSelection(CANDIDATE, { doc }).mask;
      } catch {
        return new Mask(); // a stored expression that no longer resolves draws nothing
      }
    },
  };
}
