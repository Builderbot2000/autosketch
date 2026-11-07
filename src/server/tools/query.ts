import { z } from "zod";
import type { Vec3 } from "../../core/region.js";
import { resolveSelection, type SelExpr } from "../../ops/selection.js";
import { formatRegionSummary, queryBlock, queryColumn, regionSummary } from "../../perception/query.js";
import { selSchema, text, vec3, type ToolDeps } from "./shared.js";

/** Point and region queries (06): the cheapest way to answer "what is at X?". */
export function registerQueryTools({ tool, session }: ToolDeps): void {
  tool(
    "query_block",
    {
      title: "Query block",
      description: "The block at one position: state, block-entity (NBT) summary and the components it belongs to. Text, <50 tokens.",
      inputSchema: { pos: vec3 },
    },
    (c, a) => text(queryBlock(session.require(), c.registry, a.pos as Vec3)),
  );

  tool(
    "query_column",
    {
      title: "Query column",
      description: "The column at (x, z) as bottom-to-top runs over the document's height, e.g. \"y0 cobblestone, y1-4 oak_planks, y5-9 air\". Text, <50 tokens.",
      inputSchema: { x: z.number().int(), z: z.number().int() },
    },
    (c, a) => text(queryColumn(session.require(), c.registry, a.x, a.z)),
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
    (c, a) => {
      const doc = session.require();
      const r = resolveSelection(a.sel as SelExpr, { doc, registry: c.registry, index: c.palette });
      const s = regionSummary(doc, r.mask, { registry: c.registry, index: c.palette });
      return text([formatRegionSummary(s, c.registry), ...r.notes.map((x) => `note: ${x}`)].join("\n"));
    },
  );
}
