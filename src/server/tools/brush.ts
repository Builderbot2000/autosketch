import { z } from "zod";
import type { Vec3 } from "../../core/region.js";
import { array, extrude, hollow, morph, paint, sweep, type PathCurve, type ProfileCell } from "../../ops/brush.js";
import type { PatternExpr } from "../../ops/pattern.js";
import { formatEdit } from "../format.js";
import { boxSchema, common, commonSchema, componentLine, env, patternSchema, regionOf, selSchema, vec3, type ToolDeps } from "./shared.js";
import { editWithPreview, previewSchema } from "./perception.js";

const dirEnum = z.enum(["up", "down", "north", "south", "east", "west"]);

/** Brushes (05 L2): hollow, paint, smooth/erode/dilate, extrude, sweep, array. */
export function registerBrushTools({ tool, session }: ToolDeps): void {
  const where = { sel: selSchema.optional(), box: boxSchema.optional().describe("Shorthand for sel:{min,max}"), ...commonSchema, preview: previewSchema };
  const notesOf = (a: { as?: string | undefined }, notes: string[]) => [...componentLine(a), ...notes.map((n) => `note: ${n}`)];

  tool(
    "hollow",
    {
      title: "Hollow",
      description: "Keeps the outer shell (thickness, default 1) of a selection and clears the inside to air; pattern rewrites the shell too. Follows the selection's shape. One undo step. Text.",
      inputSchema: { ...where, thickness: z.number().int().min(1).max(16).optional(), pattern: patternSchema.optional() },
      readOnly: false,
    },
    (c, a) =>
      editWithPreview(c, session, a.preview, (doc) => {
        const { region, label, notes } = regionOf(c, doc, a);
        return formatEdit(doc, hollow(doc, env(c), region, a.thickness ?? 1, a.pattern as PatternExpr | undefined, { ...common(a), ...(label ? { label } : {}) }), notesOf(a, notes));
      }),
  );

  tool(
    "paint",
    {
      title: "Paint surface",
      description: 'Rewrites only exposed blocks (those touching air) in a selection with a pattern, e.g. "mossy_cobblestone 30%, cobblestone" for weathering. dirs limits which open faces count (["up"] = top surfaces). One undo step. Text.',
      inputSchema: { ...where, pattern: patternSchema, dirs: z.array(dirEnum).optional() },
      readOnly: false,
    },
    (c, a) =>
      editWithPreview(c, session, a.preview, (doc) => {
        const { region, label, notes } = regionOf(c, doc, a);
        return formatEdit(doc, paint(doc, env(c), region, a.pattern as PatternExpr, { ...common(a), ...(label ? { label } : {}), ...(a.dirs ? { dirs: a.dirs } : {}) }), notesOf(a, notes));
      }),
  );

  tool(
    "smooth",
    {
      title: "Smooth / erode / dilate",
      description:
        "Morphological cleanup of terrain and organic shapes inside a selection. mode smooth (default: 3×3×3 majority) · erode (removes blocks with ≥ threshold air faces, default 3) · " +
        "dilate (fills air with ≥ threshold solid faces, using pattern or the most common neighbour). iterations repeats. One undo step. Text.",
      inputSchema: {
        ...where,
        mode: z.enum(["smooth", "erode", "dilate"]).optional(),
        threshold: z.number().int().min(1).max(6).optional(),
        iterations: z.number().int().min(1).max(16).optional(),
        pattern: patternSchema.optional(),
      },
      readOnly: false,
    },
    (c, a) =>
      editWithPreview(c, session, a.preview, (doc) => {
        const { region, label, notes } = regionOf(c, doc, a);
        const r = morph(doc, env(c), region, a.mode ?? "smooth", {
          ...common(a),
          ...(label ? { label } : {}),
          ...(a.threshold ? { threshold: a.threshold } : {}),
          ...(a.iterations ? { iterations: a.iterations } : {}),
          ...(a.pattern !== undefined ? { pattern: a.pattern as PatternExpr } : {}),
        });
        return formatEdit(doc, r, notesOf(a, notes));
      }),
  );

  tool(
    "extrude",
    {
      title: "Extrude face",
      description:
        "Pushes a face (a selection of blocks, e.g. a wall's outer layer) outward by n blocks, copying each block, or inward with negative n (clears n layers). dir defaults to the side where the face touches air. One undo step. Text.",
      inputSchema: { ...where, n: z.number().int(), dir: dirEnum.optional() },
      readOnly: false,
    },
    (c, a) =>
      editWithPreview(c, session, a.preview, (doc) => {
        const { region, label, notes } = regionOf(c, doc, a);
        return formatEdit(doc, extrude(doc, env(c), region, a.n, { ...common(a), ...(label ? { label } : {}), ...(a.dir ? { dir: a.dir } : {}) }), notesOf(a, notes));
      }),
  );

  tool(
    "sweep",
    {
      title: "Sweep profile",
      description:
        "Places a 2D cross-section along a path. profile cells {u, v, block}: u = blocks to the right of travel, v = up; authored for travel toward north, " +
        "so a stair in the profile turns with the path, which follows its main horizontal direction. curve: polyline (default, straight segments) · smooth (a Catmull-Rom curve through every point) · " +
        "bezier (the points are one Bézier curve's control points; it passes through the first and last). One undo step. Text.",
      inputSchema: {
        profile: z.array(z.object({ u: z.number().int(), v: z.number().int(), block: patternSchema })).min(1),
        path: z.array(vec3).min(2).describe("Path points [[x,y,z],...]"),
        curve: z.enum(["polyline", "smooth", "bezier"]).optional(),
        ...commonSchema,
        preview: previewSchema,
      },
      readOnly: false,
    },
    (c, a) => editWithPreview(c, session, a.preview, (doc) => formatEdit(doc, sweep(doc, env(c), a.profile as ProfileCell[], a.path as Vec3[], { ...common(a), ...(a.curve ? { curve: a.curve as PathCurve } : {}) }), componentLine(a))),
  );

  tool(
    "array",
    {
      title: "Array",
      description:
        "Repeats a selection count times in total (the original plus count-1 copies), each shifted by step [dx,dy,dz]. Air in the selection is copied unless skip_air. One undo step. Text.",
      inputSchema: { ...where, step: vec3, count: z.number().int().min(2).max(1024), skip_air: z.boolean().optional() },
      readOnly: false,
    },
    (c, a) =>
      editWithPreview(c, session, a.preview, (doc) => {
        const { region, label, notes } = regionOf(c, doc, a);
        return formatEdit(doc, array(doc, env(c), region, a.step as Vec3, a.count, { ...common(a), ...(label ? { label } : {}), ...(a.skip_air ? { skipAir: true } : {}) }), notesOf(a, notes));
      }),
  );
}
