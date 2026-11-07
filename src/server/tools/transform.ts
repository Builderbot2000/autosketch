import { z } from "zod";
import type { Vec3 } from "../../core/region.js";
import { copy, mirror, move, rotate, type TransformOptions } from "../../ops/transform.js";
import { formatEdit } from "../format.js";
import { boxSchema, commonSchema, editWith, env, regionOf, selSchema, vec3, type ToolDeps } from "./shared.js";

/** Transform ops (05 L2: move / copy / rotate / mirror, with block-state remapping from 01). */
export function registerTransformTools({ tool, session }: ToolDeps): void {
  const common = {
    sel: selSchema.optional(),
    box: boxSchema.optional().describe("Shorthand for sel:{min,max}"),
    skip_air: z.boolean().optional().describe("Carry only non-air blocks (default: air in the selection overwrites the destination too)"),
    ...commonSchema,
  };
  const opts = (a: { skip_air?: boolean | undefined; raw?: boolean | undefined; as?: string | undefined; kind?: string | undefined }, label?: string): TransformOptions => ({
    ...(a.skip_air ? { skipAir: true } : {}),
    ...(a.raw ? { raw: true } : {}),
    ...(a.as ? { as: a.as } : {}),
    ...(a.kind ? { kind: a.kind } : {}),
    ...(label ? { label } : {}),
  });
  const tail = "Block entities travel with their blocks; components wholly inside the selection move with it. One undo step. Text, <100 tokens.";

  tool(
    "move",
    {
      title: "Move",
      description: `Moves the blocks of a selection (sel) or box by [dx,dy,dz]; the vacated source becomes air. ${tail}`,
      inputSchema: { ...common, by: vec3.describe("Offset [dx,dy,dz]") },
      readOnly: false,
    },
    (c, a) =>
      editWith(session, (doc) => {
        const { region, label, notes } = regionOf(c, doc, a);
        return formatEdit(doc, move(doc, env(c), region, a.by as Vec3, opts(a, label)), notes.map((n) => `note: ${n}`));
      }),
  );

  tool(
    "copy",
    {
      title: "Copy",
      description:
        "Copies the blocks of a selection (sel) or box to an offset [dx,dy,dz], leaving the source. turns (clockwise from above) and mirror (x|z|y) " +
        "transform the copy about the selection's own centre first, remapping stairs, doors, logs, fences… For repeats use array. Block entities are copied. One undo step. Text, <100 tokens.",
      inputSchema: {
        ...common,
        by: vec3.describe("Offset [dx,dy,dz] applied after any turn/mirror"),
        turns: z.number().int().optional(),
        mirror: z.enum(["x", "y", "z"]).optional(),
      },
      readOnly: false,
    },
    (c, a) =>
      editWith(session, (doc) => {
        const { region, label, notes } = regionOf(c, doc, a);
        const r = copy(doc, env(c), region, a.by as Vec3, { ...opts(a, label), ...(a.turns ? { turns: a.turns } : {}), ...(a.mirror ? { mirror: a.mirror } : {}) });
        return formatEdit(doc, r, notes.map((n) => `note: ${n}`));
      }),
  );

  tool(
    "rotate",
    {
      title: "Rotate",
      description:
        "Rotates a selection (sel) or box in place by turns × 90°, clockwise seen from above (-1 = counter-clockwise), about pivot [x,y,z] " +
        `(default: the selection's centre block, rounded toward min). Block states are remapped (stair facing, log axis, sign rotation, fence sides). ${tail}`,
      inputSchema: { ...common, turns: z.number().int(), pivot: vec3.optional() },
      readOnly: false,
    },
    (c, a) =>
      editWith(session, (doc) => {
        const { region, label, notes } = regionOf(c, doc, a);
        const r = rotate(doc, env(c), region, a.turns, { ...opts(a, label), ...(a.pivot ? { pivot: a.pivot as Vec3 } : {}) });
        return formatEdit(doc, r, notes.map((n) => `note: ${n}`));
      }),
  );

  tool(
    "mirror",
    {
      title: "Mirror",
      description:
        'Mirrors a selection (sel) or box across a plane: axis "x" flips east↔west, "z" flips north↔south, "y" flips up↔down (stairs become upside-down). ' +
        `about = the plane's coordinate (a block, or a half such as 7.5; default: the selection's centre, so it flips in place). Door hinges, stair corners and facings are remapped. ${tail}`,
      inputSchema: { ...common, axis: z.enum(["x", "y", "z"]), about: z.number().optional() },
      readOnly: false,
    },
    (c, a) =>
      editWith(session, (doc) => {
        const { region, label, notes } = regionOf(c, doc, a);
        const r = mirror(doc, env(c), region, a.axis, { ...opts(a, label), ...(a.about !== undefined ? { about: a.about } : {}) });
        return formatEdit(doc, r, notes.map((n) => `note: ${n}`));
      }),
  );
}
