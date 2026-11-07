import { Mask } from "../../core/mask.js";
import { intersectBox, type Box } from "../../core/region.js";
import type { Document } from "../../document/document.js";
import type { BlockBaker } from "./bake.js";
import { renderDocument, type RenderResult } from "./render.js";

/**
 * Op previews (docs/design/05-operations.md result contract, `preview: true`; 06 token table
 * "Verify the last edit"): one small iso view of the region an op changed, with the changes
 * highlighted and two blocks of surroundings.
 */
export async function renderEditPreview(doc: Document, baker: BlockBaker, seq: number, size = 512): Promise<RenderResult | undefined> {
  const e = doc.journal.entries.find((x) => x.seq === seq);
  if (!e || !e.before.length) return undefined;
  const mask = new Mask();
  for (let i = 0; i < e.before.length; i++) mask.add(...doc.toLocal(e.positions[i * 3]!, e.positions[i * 3 + 1]!, e.positions[i * 3 + 2]!));
  const b = mask.bbox()!;
  const bounds = doc.localBounds();
  const around: Box = { min: [b.min[0] - 2, b.min[1] - 2, b.min[2] - 2], max: [b.max[0] + 2, b.max[1] + 2, b.max[2] + 2] };
  return renderDocument(doc, baker, { views: ["iso_se"], size, highlight: mask, region: bounds ? intersectBox(around, bounds) : around });
}
