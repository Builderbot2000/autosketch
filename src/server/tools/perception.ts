import { z } from "zod";
import type { Mask } from "../../core/mask.js";
import type { Box, PublicBox } from "../../core/region.js";
import { resolveSelection, type SelExpr } from "../../ops/selection.js";
import { analyzeStructure, formatAnalysis } from "../../perception/analyze.js";
import { renderDocument, VIEW_NAMES, type View } from "../../perception/render/render.js";
import { viewSlice } from "../../perception/slice.js";
import { bakerFor, box, boxSchema, image, selSchema, text, type ToolDeps } from "./shared.js";

/** Renders and slices (06). */
export function registerPerceptionTools({ tool, session }: ToolDeps): void {
  tool(
    "render",
    {
      title: "Render",
      description:
        "Draws the build with the instance's real block models and textures. views (max 4, shared in one image): iso_se|iso_sw|iso_ne|iso_nw (3/4 views from that corner), " +
        "front|back|left|right (flat elevations, resolved through the document's front), top (plan, north up), or {yaw, pitch} (camera bearing from the build: 0 north, 90 east; pitch above horizon). " +
        "Default: iso_se, iso_nw, front, top at 768px (~800 tokens). One view at 512px is ~350 tokens. region zooms to a box; cutaway:{maxY} hides everything above y to look inside. " +
        "Axis ticks label block coordinates; N marks north. style flat = mean colours (structure only). Image + caption.",
      inputSchema: {
        views: z
          .array(z.union([z.enum(VIEW_NAMES), z.object({ yaw: z.number(), pitch: z.number().min(-89).max(89) })]))
          .min(1)
          .max(4)
          .optional(),
        region: boxSchema.optional(),
        cutaway: z.object({ maxY: z.number().int() }).optional(),
        size: z.number().int().min(128).max(1024).optional().describe("Longest side in pixels (default 768 for several views, 512 for one)"),
        style: z.enum(["textured", "flat"]).optional(),
      },
    },
    async (c, a) => {
      const doc = session.require();
      const r = await renderDocument(doc, await bakerFor(c), {
        ...(a.views ? { views: a.views as View[] } : {}),
        ...(a.region ? { region: box(a.region as PublicBox) } : {}),
        ...(a.cutaway ? { cutaway: a.cutaway } : {}),
        ...(a.size ? { size: a.size } : {}),
        ...(a.style ? { style: a.style } : {}),
      });
      return image(r.png, r.caption);
    },
  );

  tool(
    "view_slice",
    {
      title: "View slice",
      description:
        "One layer of the build as a character grid with a legend: exact and cheap, the way to check a build. axis y = top-down plan at height at (north up); " +
        "axis z = elevation at that z looking north; axis x = elevation at that x looking east. Max 64×64; region limits the area. Text, ~0.1–1.5k tokens.",
      inputSchema: {
        axis: z.enum(["x", "y", "z"]),
        at: z.number().int(),
        region: boxSchema.optional().describe("Limit the slice to this box (its extent along axis is ignored)"),
      },
    },
    (c, a) => text(viewSlice(session.require(), c.registry, { axis: a.axis, at: a.at, ...(a.region ? { region: box(a.region as PublicBox) } : {}) })),
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
      } else if (a.region !== undefined) region = resolveSelection(a.region as SelExpr, { doc, registry: c.registry, index: c.palette }).mask;
      return text(formatAnalysis(analyzeStructure(doc, { registry: c.registry, index: c.palette, ...(region ? { region } : {}) }), c.registry));
    },
  );
}
