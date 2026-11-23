import { z } from "zod";
import { toPublic, type PublicBox } from "../../core/region.js";
import type { Document } from "../../document/document.js";
import { resolveSelection, type SelExpr } from "../../ops/selection.js";
import { setRenderIdPrefix } from "../../perception/render/cameras.js";
import { refusal } from "../../scope/scopes.js";
import type { Session } from "../session.js";
import { boxSchema, selSchema, text, type ToolDeps } from "./shared.js";

/**
 * The world view's tools (docs/design/18-select.md, piece 5): `world_view_read`, and `docFor`, which
 * the perception tools use to address the view with `view: "world"` instead of the open document.
 * The view lives in `world/`; this module reaches it only through `session.worldView`, never by
 * importing `world/` (ARCHITECTURE.md, *Dependency rules*).
 */

/** The `view` argument of render, view_slice, select and analyze (raycast's `view` also takes "world"). */
export const worldViewSchema = z.literal("world").optional().describe('"world": the world view (world_view_read) instead of the open document; world coordinates');

/** The view's render ids ("w1", "w2", …) beside the documents' "r1", "r2", … */
export const WORLD_RENDER_PREFIX = "w";

/** The document a perception call addresses: the world view for `view: "world"`, else the open one. */
export function docFor(session: Session, view: "world" | undefined, opts: { allowEmpty?: boolean } = {}): Document {
  if (view !== "world") return session.require();
  const v = session.worldView;
  if (!v) throw refusal("world_disconnected", "The world view isn't available in this server (no live world link).");
  if (v.empty && !opts.allowEmpty) throw refusal("world_view_empty", "The world view holds nothing yet: world_view_read({box}) reads blocks from the world into it.");
  setRenderIdPrefix(v.doc, WORLD_RENDER_PREFIX);
  return v.doc;
}

/** world_view_read (18, piece 5). */
export function registerWorldViewTools({ tool, session }: ToolDeps): void {
  tool(
    "world_view_read",
    {
      title: "Read into the world view",
      description:
        "Reads full blocks from the live world into the world view, a read-only look at the world held beside the open document (it never replaces it). " +
        'box is in world coordinates; sel is resolved in the world view (e.g. {"dilate":"candidate","by":8}) and its bounding box is read. ' +
        'One read is capped at the mod\'s contextCap (4,194,304 blocks by default). A later read of the same place replaces it; the view empties when the in-game request ends. ' +
        'Then look with view:"world" on render, view_slice, raycast, select and analyze; edits there are refused. Text, <80 tokens.',
      inputSchema: {
        box: boxSchema.optional().describe("World box to read (inclusive)"),
        sel: selSchema.optional().describe("A selection in the world view; its bounding box is read"),
      },
      doc: false,
    },
    async (c, a) => {
      const v = session.worldView;
      if (!v) throw refusal("world_disconnected", "The world view isn't available in this server (no live world link).");
      if ((a.box === undefined) === (a.sel === undefined)) throw new Error("give box or sel (one of them)");
      let box: PublicBox;
      if (a.box) box = a.box as PublicBox;
      else {
        const r = resolveSelection(a.sel as SelExpr, { doc: v.doc, registry: c.registry, index: c.palette });
        const b = r.mask.bbox();
        if (!b) throw new Error(["the selection is empty in the world view, so there is nothing to read", ...r.notes].join("; "));
        box = toPublic(b);
      }
      const r = await v.read({ boxes: [box] });
      return text(v.describe(r));
    },
  );
}
