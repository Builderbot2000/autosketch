import { z } from "zod";
import type { Vec3 } from "../../core/region.js";
import { clear, fill, replace, setBlocks } from "../../ops/edit.js";
import type { MaterialExpr } from "../../ops/material.js";
import { checkSelectionName, resolveSelection, summarize, type SelExpr } from "../../ops/selection.js";
import { formatEdit, formatSelection } from "../format.js";
import { editWithPreview, previewSchema } from "./perception.js";
import { boxSchema, env, materialSchema, regionOf, selSchema, text, vec3, type ToolDeps } from "./shared.js";

/** Selections (05 L1). */
export function registerSelectionTools({ tool, session }: ToolDeps): void {
  tool(
    "select",
    {
      title: "Select",
      description:
        "Resolves a selection and reports what it covers (block count, solid/air, bounding box, top blocks, components touched), so you can check it before an op uses it. " +
        "name stores it for reuse as sel:\"<name>\" (stored as an expression: flood fills and filters follow later edits). name alone shows a stored selection; delete:true removes it; " +
        "no arguments lists stored selections. Every op's selection also becomes \"last\". Text, <150 tokens.",
      inputSchema: {
        sel: selSchema.optional(),
        name: z.string().optional().describe("Store the selection under this name"),
        delete: z.boolean().optional(),
      },
      readOnly: false,
    },
    (c, a) => {
      const doc = session.require();
      if (a.delete) {
        if (!a.name) throw new Error("delete needs name");
        if (!doc.selections.delete(a.name)) throw new Error(`no selection named "${a.name}"`);
        doc.revision++;
        session.touch();
        return text(`deleted selection "${a.name}"`);
      }
      if (a.sel === undefined && !a.name) {
        const lines = [...doc.selections].map(([k, e]) => `${k}: ${JSON.stringify(e).slice(0, 100)}`);
        if (doc.lastSelection !== undefined) lines.push(`last: ${JSON.stringify(doc.lastSelection).slice(0, 100)}`);
        return text(lines.length ? lines.join("\n") : "No stored selections. select({sel, name}) stores one.");
      }
      const expr = (a.sel ?? a.name) as SelExpr;
      if (a.sel !== undefined && a.name) checkSelectionName(a.name);
      const r = resolveSelection(expr, { doc, registry: c.registry, index: c.palette });
      if (a.sel !== undefined && a.name) {
        doc.selections.set(a.name, a.sel as SelExpr);
        doc.revision++;
        session.touch();
      }
      if (expr !== "last") doc.lastSelection = a.name ?? expr;
      return text(formatSelection(summarize(doc, r.mask), r.notes, a.sel !== undefined ? a.name : undefined, c.registry));
    },
  );
}

/** Block edits (05 L0–L2): set_blocks, fill, clear, replace. */
export function registerEditTools({ tool, session }: ToolDeps): void {
  tool(
    "set_blocks",
    {
      title: "Set blocks",
      description: "Places individual blocks: the escape hatch for details (doors, lanterns, single stairs). Use fill for anything box-shaped. One undo step. Text.",
      inputSchema: {
        blocks: z.array(z.object({ pos: vec3, block: materialSchema })).min(1).describe('e.g. [{"pos":[3,1,0],"block":"oak_door[facing=south]"}]'),
        preview: previewSchema,
      },
      readOnly: false,
    },
    (c, a) =>
      editWithPreview(c, session, a.preview, (doc) => formatEdit(doc, setBlocks(doc, env(c), a.blocks.map((b) => ({ pos: b.pos as Vec3, block: b.block as MaterialExpr }))))),
  );

  tool(
    "fill",
    {
      title: "Fill box",
      description:
        "Fills a selection (sel) or box with a material. mode: fill (solid, default) · hollow (shell of the material, inside cleared to air) · outline (shell only, inside untouched) · " +
        "walls (sides only, no floor or ceiling) — shells follow the selection's shape, so a cylinder makes a round tower. thickness sets the shell width. " +
        "as:\"name\" registers the box (a selection's bounding box) as a component. One undo step. Text.",
      inputSchema: {
        sel: selSchema.optional(),
        box: boxSchema.optional().describe("Shorthand for sel:{min,max}"),
        material: materialSchema,
        mode: z.enum(["fill", "hollow", "outline", "walls"]).optional(),
        thickness: z.number().int().min(1).max(16).optional(),
        as: z.string().optional().describe("Component id to register for this box, e.g. \"keep\""),
        kind: z.string().optional().describe('Component kind, e.g. "tower", "wall", "floor"'),
        preview: previewSchema,
      },
      readOnly: false,
    },
    (c, a) =>
      editWithPreview(c, session, a.preview, (doc) => {
        const { region, label, notes } = regionOf(c, doc, a);
        const r = fill(doc, env(c), region, a.material as MaterialExpr, {
          ...(a.mode ? { mode: a.mode } : {}),
          ...(a.thickness ? { thickness: a.thickness } : {}),
          ...(a.as ? { as: a.as } : {}),
          ...(a.kind ? { kind: a.kind } : {}),
          ...(label ? { label } : {}),
        });
        return formatEdit(doc, r, [...(a.as ? [`component: ${a.as}`] : []), ...notes.map((n) => `note: ${n}`)]);
      }),
  );

  tool(
    "clear",
    {
      title: "Clear",
      description: "Sets every block in a selection (sel) or box to air. One undo step. Text.",
      inputSchema: { sel: selSchema.optional(), box: boxSchema.optional().describe("Shorthand for sel:{min,max}"), preview: previewSchema },
      readOnly: false,
    },
    (c, a) =>
      editWithPreview(c, session, a.preview, (doc) => {
        const { region, label, notes } = regionOf(c, doc, a);
        return formatEdit(doc, clear(doc, region, label), notes.map((n) => `note: ${n}`));
      }),
  );

  tool(
    "replace",
    {
      title: "Replace blocks",
      description:
        'Replaces matching blocks with a material inside a selection (default: the whole document). from: "oak_planks" (any state), "oak_stairs[half=top]" (those states), ' +
        '"#minecraft:logs" (a tag), "*" (any non-air), "air" (fill empty space). keep_states copies facing/half/axis… onto the new block (e.g. oak_stairs → spruce_stairs). One undo step. Text.',
      inputSchema: {
        from: z.string(),
        to: materialSchema,
        sel: selSchema.optional().describe("Where to replace (default: the whole document)"),
        box: boxSchema.optional().describe("Shorthand for sel:{min,max}"),
        keep_states: z.boolean().optional(),
        preview: previewSchema,
      },
      readOnly: false,
    },
    (c, a) =>
      editWithPreview(c, session, a.preview, (doc) => {
        if (!doc.localBounds()) throw new Error("The document is empty; nothing to replace.");
        const { region, label, notes } = regionOf(c, doc, a, "all");
        const r = replace(doc, env(c), region, a.from, a.to as MaterialExpr, { ...(a.keep_states ? { keepStates: true } : {}), ...(label ? { label } : {}) });
        return formatEdit(doc, r, notes.map((n) => `note: ${n}`));
      }),
  );
}
