import { z } from "zod";
import type { Mask } from "../../core/mask.js";
import { formatBox, intersectBox, type Box, type PublicBox, type Vec3 } from "../../core/region.js";
import type { Document } from "../../document/document.js";
import { resolveSelection, type SelExpr } from "../../ops/selection.js";
import { analyzeStructure, formatAnalysis } from "../../perception/analyze.js";
import { diffSince, documentAt, formatDiff } from "../../perception/diff.js";
import { getRender, raycast, renderIds } from "../../perception/render/cameras.js";
import { renderEditPreview } from "../../perception/render/preview.js";
import { renderDocument, VIEW_NAMES, type Cutaway, type View } from "../../perception/render/render.js";
import { viewSlice } from "../../perception/slice.js";
import type { InstanceContext } from "../context.js";
import type { Session } from "../session.js";
import { bakerFor, box, boxSchema, editWith, image, selSchema, text, vec3, type Result, type ToolDeps } from "./shared.js";

/** Resolves a selection for a perception call without changing "last". */
function maskOf(c: InstanceContext, doc: Document, expr: unknown): { mask: Mask; notes: string[] } {
  const r = resolveSelection(expr as SelExpr, { doc, registry: c.registry, index: c.palette });
  return { mask: r.mask, notes: r.notes };
}

/** Publishes `render.produced` for an image a tool returns (12, *Kinds*). Never affects the result. */
function emitRender(session: Session, views: { label: string }[], width: number, height: number): void {
  const events = session.events;
  if (!events.enabled) return;
  events.emit({ kind: "render.produced", view: views.map((v) => v.label).join(",") || "none", size: [width, height], source: "tool" });
}

/**
 * Wraps an edit tool so `preview: true` appends a small render of what the op changed (05 result
 * contract, 06 "Verify the last edit"). Used by the edit tools.
 */
export async function withPreview(c: InstanceContext, session: Session, preview: boolean | undefined, run: () => Result): Promise<Result> {
  const before = session.current?.journal.headSeq;
  const res = run();
  const doc = session.current;
  if (!preview || !doc || res.isError || doc.journal.headSeq === before) return res;
  const r = await renderEditPreview(doc, await bakerFor(c), doc.journal.headSeq);
  if (!r) return res;
  emitRender(session, r.views, r.width, r.height);
  return { ...res, content: [...res.content, { type: "image", data: r.png.toString("base64"), mimeType: "image/png" }, { type: "text", text: `preview: ${r.caption}` }] };
}

/** editWith (shared.ts) plus the optional preview. */
export function editWithPreview(c: InstanceContext, session: Session, preview: boolean | undefined, run: (doc: Document) => string): Promise<Result> {
  return withPreview(c, session, preview, () => editWith(session, run));
}

/** JSON schema fragment for the optional preview flag on edit tools. */
export const previewSchema = z.boolean().optional().describe("Also return a small render of the changed region with the changes highlighted (~350 tokens)");

const viewSchema = z.union([
  z.enum(VIEW_NAMES),
  z.string().regex(/^component:.+$/).describe('"component:<id>" frames that component'),
  z.object({
    yaw: z.number(),
    pitch: z.number().min(-89).max(89),
    distance: z.number().positive().optional().describe("Blocks framed around target (zoom; views are orthographic)"),
    target: vec3.optional().describe("Point the view centres on (default: the middle of what is drawn)"),
  }),
]);

/** Renders, slices, analysis, diffs and raycast (06). */
export function registerPerceptionTools({ tool, session }: ToolDeps): void {
  tool(
    "render",
    {
      title: "Render",
      description:
        "Draws the build with the instance's real block models and textures. views (max 4, shared in one image): iso_se|iso_sw|iso_ne|iso_nw (3/4 views from that corner), " +
        "front|back|left|right (flat elevations, resolved through the document's front), top (plan, north up), \"component:<id>\" (auto-framed on a component), " +
        "or {yaw, pitch, distance?, target?} (camera bearing from the build: 0 north, 90 east; pitch above horizon; distance = blocks framed around target). " +
        "Default: iso_se, iso_nw, front, top at 768px (~800 tokens). One view at 512px is ~350 tokens. region takes any selection: only it is drawn, framed tightly. " +
        "cutaway: {maxY} hides everything above y; {plane:\"x\"|\"y\"|\"z\", at, keep:\"west|east|down|up|north|south\"} keeps one side of a plane. " +
        "highlight: any selection, tinted orange; {changed:\"op:-1\"|\"checkpoint:<name>\"} shows a diff ({since:..} still works). style: textured | flat (mean colours) | depth (darker = farther) | xray (translucent shell). " +
        "overlays: {components, storeys} labels components and draws storey floor lines. Axis ticks label block coordinates; N marks north. " +
        "The caption gives the render id for raycast and for view_box/view_lasso selections. Image + caption.",
      inputSchema: {
        views: z.array(viewSchema).min(1).max(4).optional(),
        region: selSchema.optional().describe("Draw only this selection (a box {min,max} or any selection)"),
        cutaway: z.union([z.object({ maxY: z.number().int() }), z.object({ plane: z.enum(["x", "y", "z"]), at: z.number().int(), keep: z.enum(["west", "east", "down", "up", "north", "south"]) })]).optional(),
        highlight: z.union([z.object({ since: z.string() }), selSchema]).optional(),
        size: z.number().int().min(128).max(1024).optional().describe("Longest side in pixels (default 768 for several views, 512 for one)"),
        style: z.enum(["textured", "flat", "depth", "xray"]).optional(),
        overlays: z.object({ components: z.boolean().optional(), storeys: z.boolean().optional() }).optional(),
        context: z.enum(["ghost", "normal", "hide"]).optional().describe("In a scoped job's sandbox: how the read-only context is drawn (default ghost: grey, translucent)"),
      },
    },
    async (c, a) => {
      const doc = session.require();
      const notes: string[] = [];
      let region: Box | Mask | undefined;
      if (a.region !== undefined) {
        const r = maskOf(c, doc, a.region);
        notes.push(...r.notes);
        if (r.mask.isEmpty()) throw new Error(["the region selection is empty", ...r.notes].join("; "));
        region = r.mask.isBox() ?? r.mask;
      }
      let highlight: Mask | undefined;
      if (a.highlight !== undefined) {
        const h = a.highlight as unknown;
        if (h && typeof h === "object" && "since" in h) highlight = diffSince(doc, String((h as { since: unknown }).since)).mask;
        else {
          const r = maskOf(c, doc, h);
          notes.push(...r.notes);
          highlight = r.mask;
        }
      }
      const r = await renderDocument(doc, await bakerFor(c), {
        ...(a.views ? { views: a.views as View[] } : {}),
        ...(region ? { region } : {}),
        ...(a.cutaway ? { cutaway: a.cutaway as Cutaway } : {}),
        ...(highlight ? { highlight } : {}),
        ...(a.size ? { size: a.size } : {}),
        ...(a.style ? { style: a.style } : {}),
        ...(a.overlays ? { overlays: a.overlays } : {}),
        ...(a.context ? { context: a.context } : {}),
      });
      emitRender(session, r.views, r.width, r.height);
      return image(r.png, [r.caption, ...notes.map((n) => `note: ${n}`)].join("\n"));
    },
  );

  tool(
    "view_slice",
    {
      title: "View slice",
      description:
        "One layer of the build as a character grid with a legend: exact and cheap, the way to check a build. axis y = top-down plan at height at (north up); " +
        "axis z = elevation at that z looking north; axis x = elevation at that x looking east. Max 64×64; region limits the area. " +
        "mode runs lists each row's blocks as runs instead (for sparse layers; up to 256×256). Text, ~0.1–1.5k tokens.",
      inputSchema: {
        axis: z.enum(["x", "y", "z"]),
        at: z.number().int(),
        region: boxSchema.optional().describe("Limit the slice to this box (its extent along axis is ignored)"),
        mode: z.enum(["grid", "runs"]).optional().describe("grid (default) or runs (run-length rows, for sparse layers)"),
      },
    },
    (c, a) =>
      text(viewSlice(session.require(), c.registry, { axis: a.axis, at: a.at, ...(a.region ? { region: box(a.region as PublicBox) } : {}), ...(a.mode ? { mode: a.mode } : {}) })),
  );

  tool(
    "analyze",
    {
      title: "Analyze structure",
      description:
        "Structural summary of the build (or of one component / selection): footprint, storeys with floor heights, wall thickness and material, " +
        "windows and doors per facade (front/back/left/right via the document's front), roof type, ridge, pitch and overhang, enclosed rooms, " +
        "issues (floating blocks, roof gaps) and proposed components with boxes. Use it to check \"does this make sense?\" before rendering. Text, ~200–400 tokens.",
      inputSchema: {
        component: z.string().optional().describe("Analyse only this component's box"),
        region: selSchema.optional().describe("Analyse only this selection"),
      },
    },
    (c, a) => {
      const doc = session.require();
      if (a.component !== undefined && a.region !== undefined) throw new Error("give component or region, not both");
      let region: Box | Mask | undefined;
      if (a.component !== undefined) {
        const comp = doc.componentLocal(a.component);
        if (!comp) throw new Error(`no component "${a.component}"${doc.components.size ? ` (have: ${[...doc.components.keys()].join(", ")})` : ""}`);
        region = comp.box;
      } else if (a.region !== undefined) region = maskOf(c, doc, a.region).mask;
      return text(formatAnalysis(analyzeStructure(doc, { registry: c.registry, index: c.palette, ...(region ? { region } : {}) }), c.registry));
    },
  );

  tool(
    "diff",
    {
      title: "Diff",
      description:
        'What changed since a checkpoint ("checkpoint:<name>") or the last n ops ("op:-n"): counts by material family (added, removed, replaced) and the regions changed. ' +
        "Text, ~100–300 tokens. render:true adds a before/after pair of the changed area with the changes in orange (~350 tokens each).",
      inputSchema: {
        since: z.string().describe('"checkpoint:<name>" or "op:-n" (op:-1 = the last op)'),
        render: z.boolean().optional(),
      },
    },
    async (c, a) => {
      const doc = session.require();
      const d = diffSince(doc, a.since);
      const summary = formatDiff(d, { registry: c.registry, index: c.palette });
      if (!a.render || !d.box) return text(summary);
      const baker = await bakerFor(c);
      const around: Box = { min: [d.box.min[0] - 2, d.box.min[1] - 2, d.box.min[2] - 2], max: [d.box.max[0] + 2, d.box.max[1] + 2, d.box.max[2] + 2] };
      const snap = documentAt(doc, d.target);
      const clip = (doc2: Document) => {
        const b = doc2.localBounds();
        return b ? intersectBox(around, b) : around;
      };
      const opts = { views: ["iso_se"] as View[], size: 384, highlight: d.mask };
      const before = await renderDocument(snap, baker, { ...opts, region: clip(snap) });
      const after = await renderDocument(doc, baker, { ...opts, region: clip(doc) });
      emitRender(session, before.views, before.width, before.height);
      emitRender(session, after.views, after.width, after.height);
      return {
        content: [
          { type: "text", text: summary },
          { type: "image", data: before.png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: `before (${d.label}): ${formatBox(around)} with changed positions in orange` },
          { type: "image", data: after.png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: `after (now): ${after.caption}` },
        ],
      };
    },
  );

  tool(
    "raycast",
    {
      title: "Raycast",
      description:
        "Names the block under a pixel of a recent render (pixel coordinates in the whole returned image, contact sheets included): position, state and the face hit. " +
        'view is the render id from its caption (e.g. "r3"; default: the latest render of this document). Text, <50 tokens.',
      inputSchema: {
        px: z.number().int().min(0),
        py: z.number().int().min(0),
        view: z.string().optional().describe('Render id, e.g. "r3" (default: the latest render)'),
      },
    },
    (_c, a) => {
      const doc = session.require();
      const rec = getRender(doc, a.view);
      if (!rec) throw new Error(a.view ? `no recent render "${a.view}" (kept: ${renderIds(doc).join(", ") || "none"})` : "no render of this document yet; call render first");
      const hit = raycast(doc, rec, a.px, a.py);
      if (!hit) throw new Error(`pixel (${a.px},${a.py}) is outside render ${rec.id} (${rec.width}×${rec.height})`);
      const stale = rec.revision !== doc.revision ? " (the document changed since this render)" : "";
      if (!hit.pos) return text(`${rec.id} ${hit.view.label} (${a.px},${a.py}): nothing drawn under this pixel${stale}`);
      const p = hit.pos as Vec3;
      return text(`${rec.id} ${hit.view.label} (${a.px},${a.py}) → (${p.join(",")}) ${hit.state!.replace(/^minecraft:/, "")}, ${hit.face} face${stale}`);
    },
  );
}
