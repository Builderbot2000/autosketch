import { z } from "zod";
import type { Vec3 } from "../../core/region.js";
import type { Document } from "../../document/document.js";
import { resolveSelection, type SelExpr } from "../../ops/selection.js";
import { formatRegionSummary, queryBlock, queryColumn, regionSummary } from "../../perception/query.js";
import { selSchema, text, vec3, type ToolDeps } from "./shared.js";
import { readDocFor, selReach } from "./world-view.js";

/**
 * Point and region queries (06): the cheapest way to answer "what is at X?". On a linked document
 * with a canvas, positions outside the brush and context are read through the world view (19).
 */
export function registerQueryTools({ tool, session }: ToolDeps): void {
  tool(
    "query_block",
    {
      title: "Query block",
      description: "The block at one position: state, block-entity (NBT) summary and the components it belongs to. Text, <50 tokens.",
      inputSchema: { pos: vec3 },
    },
    async (c, a) => {
      const p = a.pos as Vec3;
      const doc = await readDocFor(session, undefined, () => [{ min: p, max: [p[0] + 1, p[1] + 1, p[2] + 1] }]);
      return text(queryBlock(doc, c.registry, p));
    },
  );

  tool(
    "query_column",
    {
      title: "Query column",
      description: "The column at (x, z) as bottom-to-top runs over the document's height, e.g. \"y0 cobblestone, y1-4 oak_planks, y5-9 air\". Text, <50 tokens.",
      inputSchema: { x: z.number().int(), z: z.number().int() },
    },
    async (c, a) => {
      const doc = await readDocFor(session, undefined, (d) => {
        const b = d.localBounds();
        return b ? [{ min: [a.x, b.min[1], a.z], max: [a.x + 1, b.max[1], a.z + 1] }] : undefined;
      });
      return text(queryColumn(doc, c.registry, a.x, a.z));
    },
  );

  tool(
    "query_region",
    {
      title: "Query region",
      description:
        "What a selection contains: block counts by material family and by palette role, the bounding box of its blocks, and the components inside it. " +
        "Does not change \"last\". Text, <150 tokens.",
      inputSchema: { sel: selSchema },
    },
    async (c, a) => {
      const resolve = (e: SelExpr, doc: Document) => resolveSelection(e, { doc, registry: c.registry, index: c.palette });
      const doc = await readDocFor(session, undefined, (d) => selReach(a.sel, (e) => resolve(e, d).mask));
      const r = resolve(a.sel as SelExpr, doc);
      const s = regionSummary(doc, r.mask, { registry: c.registry, index: c.palette });
      return text([formatRegionSummary(s, c.registry), ...r.notes.map((x) => `note: ${x}`)].join("\n"));
    },
  );
}
