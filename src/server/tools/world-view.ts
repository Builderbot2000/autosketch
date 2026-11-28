import { z } from "zod";
import { toPublic, type Box, type PublicBox } from "../../core/region.js";
import type { Document } from "../../document/document.js";
import type { Mask } from "../../core/mask.js";
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

/** The canvas read document's render ids ("c1", "c2", …; 19), beside "r" and the world view's "w". */
export const CANVAS_RENDER_PREFIX = "c";

/**
 * The document a read addresses (19, *The frame doesn't move with the brush*): as `docFor`, except
 * that on the linked document with a canvas, a read whose reach leaves the brush and context reads
 * those canvas positions through the world view and looks at the canvas read document (read-only,
 * possibly stale; the result's `world:` line says so). `reach` gives the local, half-open boxes the
 * call reads, worked out on the open document; undefined or empty reads the document as it is.
 */
export async function readDocFor(session: Session, view: "world" | undefined, reach: (doc: Document) => Box[] | undefined, opts: { allowEmpty?: boolean } = {}): Promise<Document> {
  const doc = docFor(session, view, opts);
  const cr = session.canvasReads;
  if (view === "world" || !cr) return doc;
  const boxes = reach(doc);
  if (!boxes?.length) return doc;
  const out = await cr.docFor(doc, boxes);
  if (out !== doc) setRenderIdPrefix(out, CANVAS_RENDER_PREFIX);
  return out;
}

/**
 * The local boxes a selection reads (19): its bounding box, and the `within` box of each pick
 * (`connected`, `similar`) in it, since a pick reads blocks there that the mirror may not hold.
 */
export function selReach(expr: unknown, resolve: (e: SelExpr) => Mask): Box[] {
  const out: Box[] = [];
  const add = (e: unknown) => {
    const b = resolve(e as SelExpr).bbox();
    if (b) out.push(b);
  };
  const visit = (e: unknown): void => {
    if (Array.isArray(e)) return e.forEach(visit);
    if (!e || typeof e !== "object") return;
    for (const [k, v] of Object.entries(e)) {
      if ((k === "connected" || k === "similar") && v && typeof v === "object" && "within" in v) add((v as { within: unknown }).within);
      visit(v);
    }
  };
  add(expr);
  visit(expr);
  return out;
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
        "One read is capped at the mod's contextCap (4,194,304 blocks by default); a larger one is read coarse, one block per 2³ or 4³ cell (the cell's most common block, drawn over the whole cell), " +
        "and the render caption names the coarse parts; reading a smaller box there again replaces them with full detail. " +
        "surface (a box, for terrain) reads only the topmost block of each column, kept where it lies within the box's y range. " +
        "A later read of the same place replaces it; the view empties when the in-game request ends. " +
        'Then look with view:"world" on render, view_slice, raycast, select and analyze; edits there are refused. Text, <150 tokens.',
      inputSchema: {
        box: boxSchema.optional().describe("World box to read (inclusive)"),
        sel: selSchema.optional().describe("A selection in the world view; its bounding box is read"),
        surface: boxSchema.optional().describe("World box: read the topmost block of each of its columns (a surface map, for terrain)"),
      },
      doc: false,
    },
    async (c, a) => {
      const v = session.worldView;
      if (!v) throw refusal("world_disconnected", "The world view isn't available in this server (no live world link).");
      if ([a.box, a.sel, a.surface].filter((x) => x !== undefined).length !== 1) throw new Error("give one of box, sel or surface");
      if (a.surface) return text(v.describe(await v.readSurface(a.surface as PublicBox)));
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
