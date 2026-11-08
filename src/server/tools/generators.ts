import { z } from "zod";
import type { Vec3 } from "../../core/region.js";
import { componentAnchors, resolveAnchor, type AtSpec } from "../../ops/anchors.js";
import { arch, column, door, roof, staircase, tower, wallRun, window, type GenResult } from "../../ops/generators/index.js";
import type { MaterialExpr } from "../../ops/material.js";
import { formatEdit } from "../format.js";
import { boxSchema, editWith, env, materialSchema, regionOf, selSchema, text, vec3, type ToolDeps } from "./shared.js";

/** Generators (05 L3) and anchors (05, Anchors & relative placement). */

export const atSchema = z
  .union([
    vec3,
    z.string(),
    z.object({ anchor: z.string(), offset: vec3.optional() }),
    z.object({ face: z.string(), u: z.union([z.number(), z.string()]).optional(), v: z.union([z.number(), z.string()]).optional(), offset: vec3.optional() }),
  ])
  .describe(
    '[x,y,z] · "comp.anchor" (named, or implicit min/max/center/bottom/top/front/back/left/right/storey:n) · {anchor:"gate.top", offset:[0,0,3]} · ' +
      '{face:"keep.front", u:0.5, v:"storey:2"} (u left→right, v bottom→up; 0..1 = fraction, larger = blocks, negative = from the far end)',
  );

const gen = {
  as: z.string().optional().describe("Component id (default: the generator's name, numbered when taken)"),
  kind: z.string().optional(),
  raw: z.boolean().optional().describe("Skip auto-connection"),
};
const genOpts = (a: { as?: string | undefined; kind?: string | undefined; raw?: boolean | undefined }) => ({ ...(a.as ? { as: a.as } : {}), ...(a.kind ? { kind: a.kind } : {}), ...(a.raw ? { raw: true } : {}) });
const faceSchema = z.string().describe('Face: "comp.front|back|left|right|north|south|east|west"');
const uvSchema = z.union([z.number(), z.string()]).optional();

/** Strips undefined values so optional zod fields fit exactOptionalPropertyTypes. */
function defined<T extends Record<string, unknown>>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}

const out = (doc: Parameters<typeof formatEdit>[0], r: GenResult) => formatEdit(doc, r, [...r.notes, `component: ${r.component}`]);
const tail = "Registers a component. One undo step. Text, <150 tokens.";

export function registerGeneratorTools({ tool, session }: ToolDeps): void {
  tool(
    "roof",
    {
      title: "Roof",
      description:
        "Builds a roof over a footprint (sel, box, or {\"component\":\"keep\"}; its projection, so round and L-shaped footprints work), on top of it. " +
        "style gable (default) · hip · pyramid · shed · mansard · dome · flat. pitch = rise per run (1 = stairs, 0.5 = slabs, 2 = steep). " +
        'Stairs and slabs come from the material\'s family or palette role ("palette:castle.roof"); without them it falls back to full blocks and warns. ' +
        `overhang extends past the walls; gables fills the gable ends. ${tail}`,
      inputSchema: {
        sel: selSchema.optional(),
        box: boxSchema.optional(),
        material: materialSchema,
        style: z.enum(["gable", "hip", "pyramid", "shed", "mansard", "dome", "flat"]).optional(),
        pitch: z.number().optional(),
        overhang: z.number().int().min(0).max(8).optional(),
        axis: z.enum(["x", "z"]).optional().describe("Gable ridge axis (default the longer side)"),
        high: z.enum(["north", "south", "east", "west"]).optional().describe("Shed: the high side"),
        break: z.number().int().min(1).optional().describe("Mansard: steps at the steep lower pitch"),
        base: z.number().int().optional().describe("y of the lowest course at the wall line (default one above the footprint)"),
        stairs: materialSchema.optional(),
        slab: materialSchema.optional(),
        gables: z.union([z.boolean(), materialSchema]).optional(),
        ...gen,
      },
      readOnly: false,
    },
    (c, a) =>
      editWith(session, (doc) => {
        const { region } = regionOf(c, doc, a);
        const r = roof(doc, env(c), region, a.material as MaterialExpr, {
          ...defined({ style: a.style, pitch: a.pitch, overhang: a.overhang, axis: a.axis, high: a.high, break: a.break, base: a.base }),
          ...(a.stairs !== undefined ? { stairs: a.stairs as MaterialExpr } : {}),
          ...(a.slab !== undefined ? { slab: a.slab as MaterialExpr } : {}),
          ...(a.gables !== undefined ? { gables: a.gables as boolean | MaterialExpr } : {}),
          ...genOpts(a),
        });
        return out(doc, r);
      }),
  );

  tool(
    "arch",
    {
      title: "Arch",
      description: `Builds an arch: at = bottom centre of the opening; width; height (crown); axis the wall runs along; style round|pointed|segmental|flat; ring thickness; depth through the wall. Clears the opening unless clear:false. ${tail}`,
      inputSchema: {
        at: atSchema,
        material: materialSchema,
        width: z.number().int().min(1).max(64),
        height: z.number().int().min(1).optional(),
        axis: z.enum(["x", "z"]).optional(),
        style: z.enum(["round", "pointed", "segmental", "flat"]).optional(),
        ring: z.number().int().min(1).max(8).optional(),
        depth: z.number().int().min(1).max(16).optional(),
        jambs: z.boolean().optional(),
        clear: z.boolean().optional(),
        ...gen,
      },
      readOnly: false,
    },
    (c, a) =>
      editWith(session, (doc) =>
        out(doc, arch(doc, env(c), a.material as MaterialExpr, { at: a.at as AtSpec, width: a.width, ...defined({ height: a.height, axis: a.axis, style: a.style, ring: a.ring, depth: a.depth, jambs: a.jambs, clear: a.clear }), ...genOpts(a) })),
      ),
  );

  tool(
    "staircase",
    {
      title: "Staircase",
      description: `Builds a straight staircase from its lowest step: dir + height, or to (the top step, a 45° run). width extends right of the climb; support solid (default) or none. Stairs from the material's family, or stairs:. ${tail}`,
      inputSchema: {
        from: atSchema,
        material: materialSchema,
        dir: z.enum(["north", "south", "east", "west"]).optional(),
        height: z.number().int().min(1).max(256).optional(),
        to: atSchema.optional(),
        width: z.number().int().min(1).max(32).optional(),
        stairs: materialSchema.optional(),
        support: z.enum(["solid", "none"]).optional(),
        ...gen,
      },
      readOnly: false,
    },
    (c, a) =>
      editWith(session, (doc) =>
        out(
          doc,
          staircase(doc, env(c), a.material as MaterialExpr, {
            from: a.from as AtSpec,
            ...defined({ dir: a.dir, height: a.height, width: a.width, support: a.support }),
            ...(a.to !== undefined ? { to: a.to as AtSpec } : {}),
            ...(a.stairs !== undefined ? { stairs: a.stairs as MaterialExpr } : {}),
            ...genOpts(a),
          }),
        ),
      ),
  );

  tool(
    "wall_run",
    {
      title: "Wall run",
      description: `Builds a wall along a path of points (any at: form; y = base): height, thickness (centred), crenellation (true or {every, height, material}), buttresses {every, depth, side left|right|both}, cap (top course material). ${tail}`,
      inputSchema: {
        path: z.array(atSchema).min(2),
        material: materialSchema,
        height: z.number().int().min(1).max(384),
        thickness: z.number().int().min(1).max(16).optional(),
        crenellation: z.union([z.boolean(), z.object({ every: z.number().int().optional(), height: z.number().int().optional(), material: materialSchema.optional() })]).optional(),
        buttresses: z.object({ every: z.number().int(), depth: z.number().int().optional(), side: z.enum(["left", "right", "both"]).optional(), material: materialSchema.optional() }).optional(),
        cap: materialSchema.optional(),
        ...gen,
      },
      readOnly: false,
    },
    (c, a) =>
      editWith(session, (doc) =>
        out(
          doc,
          wallRun(doc, env(c), a.material as MaterialExpr, {
            path: a.path as AtSpec[],
            height: a.height,
            ...defined({ thickness: a.thickness }),
            ...(a.crenellation !== undefined ? { crenellation: typeof a.crenellation === "boolean" ? a.crenellation : (defined(a.crenellation) as never) } : {}),
            ...(a.buttresses ? { buttresses: defined(a.buttresses) as never } : {}),
            ...(a.cap !== undefined ? { cap: a.cap as MaterialExpr } : {}),
            ...genOpts(a),
          }),
        ),
      ),
  );

  tool(
    "tower",
    {
      title: "Tower",
      description:
        'Builds a tower: at = base centre; shape round (default) | square | number of sides | [[dx,dz],…]; radius; height; thickness (0 = solid); floors {every, material}; roof: a style ("pyramid" default, "dome", "flat"…), {style, material, pitch, overhang}, or false. ' +
        `Walls, floors and roof are one undo step; the roof is a child component <id>_roof. ${tail}`,
      inputSchema: {
        at: atSchema,
        material: materialSchema,
        shape: z.union([z.enum(["round", "square"]), z.number().int().min(3).max(64), z.array(z.tuple([z.number().int(), z.number().int()]))]).optional(),
        radius: z.number().int().min(1).max(64).optional(),
        height: z.number().int().min(1).max(384),
        thickness: z.number().int().min(0).max(16).optional(),
        floors: z.object({ every: z.number().int(), material: materialSchema.optional() }).optional(),
        roof: z
          .union([z.literal(false), z.enum(["gable", "hip", "pyramid", "shed", "mansard", "dome", "flat"]), z.object({ style: z.enum(["gable", "hip", "pyramid", "shed", "mansard", "dome", "flat"]).optional(), material: materialSchema.optional(), pitch: z.number().optional(), overhang: z.number().int().optional(), stairs: materialSchema.optional(), slab: materialSchema.optional() })])
          .optional(),
        ...gen,
      },
      readOnly: false,
    },
    (c, a) =>
      editWith(session, (doc) =>
        out(
          doc,
          tower(doc, env(c), a.material as MaterialExpr, {
            at: a.at as AtSpec,
            height: a.height,
            ...defined({ radius: a.radius, thickness: a.thickness }),
            ...(a.shape !== undefined ? { shape: a.shape as never } : {}),
            ...(a.floors ? { floors: defined(a.floors) as never } : {}),
            ...(a.roof !== undefined ? { roof: (typeof a.roof === "object" ? defined(a.roof) : a.roof) as never } : {}),
            ...genOpts(a),
          }),
        ),
      ),
  );

  tool(
    "window",
    {
      title: "Window",
      description: `Cuts a window into a component face (on:"keep.front"): u, v place its bottom centre (default centred, v "1" = one block up; "storey:2" sits on storey 2); w, h; style plain|arched|cross; glass (default glass_pane); frame; sill (one block out, e.g. a stair, turned upside-down); depth = layers cut inward. ${tail}`,
      inputSchema: {
        on: faceSchema,
        u: uvSchema,
        v: uvSchema,
        w: z.number().int().min(1).max(32).optional(),
        h: z.number().int().min(1).max(32).optional(),
        style: z.enum(["plain", "arched", "cross"]).optional(),
        glass: materialSchema.optional(),
        frame: materialSchema.optional(),
        sill: materialSchema.optional(),
        depth: z.number().int().min(1).max(8).optional(),
        ...gen,
      },
      readOnly: false,
    },
    (c, a) =>
      editWith(session, (doc) =>
        out(
          doc,
          window(doc, env(c), {
            on: a.on,
            ...defined({ u: a.u, v: a.v, w: a.w, h: a.h, style: a.style, depth: a.depth }),
            ...(a.glass !== undefined ? { glass: a.glass as MaterialExpr } : {}),
            ...(a.frame !== undefined ? { frame: a.frame as MaterialExpr } : {}),
            ...(a.sill !== undefined ? { sill: a.sill as MaterialExpr } : {}),
            ...genOpts(a),
          }),
        ),
      ),
  );

  tool(
    "door",
    {
      title: "Door",
      description: `Places a door in a component face (on:"keep.front"): both halves, facing out of the face; u, v place it (default centred, at the bottom); w 1 or 2 (double door); h = opening height (cleared above the door); block (default oak_door); frame. ${tail}`,
      inputSchema: {
        on: faceSchema,
        u: uvSchema,
        v: uvSchema,
        block: z.string().optional(),
        w: z.number().int().min(1).max(2).optional(),
        h: z.number().int().min(2).max(8).optional(),
        frame: materialSchema.optional(),
        depth: z.number().int().min(1).max(8).optional(),
        ...gen,
      },
      readOnly: false,
    },
    (c, a) =>
      editWith(session, (doc) =>
        out(doc, door(doc, env(c), { on: a.on, ...defined({ u: a.u, v: a.v, block: a.block, w: a.w, h: a.h, depth: a.depth }), ...(a.frame !== undefined ? { frame: a.frame as MaterialExpr } : {}), ...genOpts(a) })),
      ),
  );

  tool(
    "column",
    {
      title: "Column",
      description: `Builds a column up from at: height; radius 0 (one block, default) or more (round); base and capital materials for the end layers. ${tail}`,
      inputSchema: {
        at: atSchema,
        material: materialSchema,
        height: z.number().int().min(1).max(384),
        radius: z.number().int().min(0).max(16).optional(),
        base: materialSchema.optional(),
        capital: materialSchema.optional(),
        ...gen,
      },
      readOnly: false,
    },
    (c, a) =>
      editWith(session, (doc) =>
        out(
          doc,
          column(doc, env(c), a.material as MaterialExpr, {
            at: a.at as AtSpec,
            height: a.height,
            ...defined({ radius: a.radius }),
            ...(a.base !== undefined ? { base: a.base as MaterialExpr } : {}),
            ...(a.capital !== undefined ? { capital: a.capital as MaterialExpr } : {}),
            ...genOpts(a),
          }),
        ),
      ),
  );

  tool(
    "anchor",
    {
      title: "Anchors",
      description:
        'Resolves an at: form to coordinates (at), lists a component\'s anchors (component), or sets a named anchor on it (component + name + at; delete:true removes it). ' +
        'Name "storey:n" anchors to fix storey levels. Setting is one undo step. Text, <100 tokens.',
      inputSchema: { at: atSchema.optional(), component: z.string().optional(), name: z.string().optional(), delete: z.boolean().optional() },
      readOnly: false,
    },
    (c, a) => {
      const doc = session.require();
      if (a.component && a.name) {
        const comp = doc.componentLocal(a.component);
        if (!comp) throw new Error(`no component "${a.component}"`);
        if (!/^[a-z0-9_:.-]+$/i.test(a.name)) throw new Error("anchor name must be letters, digits, _ : . or -");
        const anchors = { ...comp.anchors };
        let desc: string;
        if (a.delete) {
          if (!anchors[a.name]) throw new Error(`component "${a.component}" has no named anchor "${a.name}"`);
          delete anchors[a.name];
          desc = `removed anchor ${a.component}.${a.name}`;
        } else {
          if (a.at === undefined) throw new Error("give at to set the anchor");
          const r = resolveAnchor(doc, a.at as AtSpec, env(c));
          anchors[a.name] = r.pos;
          desc = `anchor ${a.component}.${a.name} = ${r.pos.join(",")}${Array.isArray(a.at) ? "" : ` (from ${r.desc})`}`;
        }
        return editWith(session, () => {
          doc.edit("anchor", desc, (tx) => tx.setComponent({ ...comp, anchors }));
          return desc;
        });
      }
      if (a.component) {
        const all = componentAnchors(doc, a.component);
        const named = new Set(Object.keys(doc.componentLocal(a.component)!.anchors));
        return text(`${a.component}: ${Object.entries(all).map(([k, v]) => `${k}${named.has(k) ? "*" : ""} (${(v as Vec3).join(",")})`).join(" · ")}\n* = named`);
      }
      if (a.at === undefined) throw new Error("give at, or component");
      return text(resolveAnchor(doc, a.at as AtSpec, env(c)).desc);
    },
  );
}
