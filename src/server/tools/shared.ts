import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fromPublic, type Box, type PublicBox } from "../../core/region.js";
import type { Document } from "../../document/document.js";
import type { CommonOptions, OpEnv, Region } from "../../ops/edit.js";
import { resolveSelection, type SelExpr } from "../../ops/selection.js";
import { BlockBaker } from "../../perception/render/bake.js";
import { TextureLoader, Tinter } from "../../palette/textures.js";
import type { InstanceContext } from "../context.js";
import type { Session } from "../session.js";

/**
 * Shared plumbing for the tool modules in this folder. Each module exports one
 * `register…Tools(deps)` function; server.ts calls them in order. To add tools, add a module and
 * one line in tools/index.ts, rather than growing an existing module.
 */

export type Result = CallToolResult;
export const text = (t: string): Result => ({ content: [{ type: "text", text: t }] });
export const fail = (t: string): Result => ({ content: [{ type: "text", text: t }], isError: true });
export const image = (png: Buffer, caption: string): Result => ({
  content: [
    { type: "image", data: png.toString("base64"), mimeType: "image/png" },
    { type: "text", text: caption },
  ],
});

/** Registers one MCP tool. Errors thrown by `run` become error results; the instance is awaited first. */
export type ToolFn = <S extends z.ZodRawShape>(
  name: string,
  config: { title: string; description: string; inputSchema: S; readOnly?: boolean },
  run: (c: InstanceContext, args: z.infer<z.ZodObject<S>>) => Promise<Result> | Result,
) => unknown;

/** One readable entry of a resource, as resources/list shows it. */
export interface ResourceListing {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

/** What reading a resource returns: text (markdown, JSON…), with an optional mime type. */
export interface ResourceContent {
  text: string;
  mimeType?: string;
}

/**
 * Registers one MCP resource (07: knowledge packs; 05: script API docs). A `uri` with `{var}`
 * parts is an RFC 6570 template, and `list` enumerates its concrete entries for resources/list;
 * a plain `uri` is one fixed resource. `read` gets the requested URI and the template variables.
 * Resources don't wait on the Minecraft instance: they serve files and static text. Errors thrown
 * by `read` reach the client as resource-read errors.
 */
export type ResourceFn = (
  name: string,
  config: { title: string; description: string; uri: string; mimeType?: string; list?: () => Promise<ResourceListing[]> | ResourceListing[] },
  read: (uri: URL, vars: Record<string, string>) => Promise<ResourceContent> | ResourceContent,
) => unknown;

export interface ToolDeps {
  tool: ToolFn;
  resource: ResourceFn;
  session: Session;
}

// ---- schemas -------------------------------------------------------------------------------------

export const vec3 = z.tuple([z.number().int(), z.number().int(), z.number().int()]);
export const boxSchema = z
  .object({ min: vec3, max: vec3 })
  .describe("Inclusive box {min:[x,y,z], max:[x,y,z]}; corners in any order. {min:[0,0,0],max:[0,0,0]} is one block.");
export const materialSchema = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe(
    'Material: "stone_bricks", "oak_stairs[facing=east]", "stone_bricks 70%, mossy_stone_bricks 30%", "palette:<name>.<role>", ' +
      '{"gradient":[...],"axis":"y","range":[0,12]}, {"noise":[...],"scale":6}, {"pattern":"checker|stripes_x|stripes_y|stripes_z","blocks":[...],"size":1}. Entries nest.',
  );
export const selSchema = z
  .union([z.string(), z.record(z.string(), z.unknown())])
  .describe(
    'Selection: {"min":[x,y,z],"max":[x,y,z]} box · "all" · "last" · "<name>" · {"component":"id"} · {"cylinder":{"center":[x,y,z],"radius":r,"height":h,"axis":"y"}} (center = base centre) · ' +
      '{"sphere":{"center","radius"}} · {"ellipsoid":{"center","radii"}} · {"polygon":{"points":[[x,z],...],"y":[y0,y1]}} · {"plane":{"axis","at","within"?}} · ' +
      '{"connected":{"seed":[x,y,z],"match":"block|state|family|solid|air","connectivity":6|18|26,"within"?}} (flood fill) · {"similar":{"seed","by":"block|state|family","within"?}} · ' +
      '{"union":[a,b]} {"intersect":[a,b]} {"subtract":[a,b]} {"xor":[a,b]} {"invert":a,"within"?} · {"expand":a,"by":n|[dx,dy,dz]|{"up":n,...}} {"contract":a,"by":..} {"offset":a,"by":[dx,dy,dz]} · ' +
      '{"shell":a,"thickness"?,"walls_only"?} {"layer":a,"y":n|"min"|"max"} {"surface":a} {"bbox":a} {"filter":a,"block"?:"oak_planks|#tag|*","air"?:bool} · ' +
      '{"rotate":a,"turns":n,"pivot"?:[x,y,z]} (clockwise from above) {"mirror":a,"axis":"x|y|z","about"?:n} · ' +
      '{"grow":a,"by"?:n,"match"?:"solid|same|any"} {"shrink":a,"by"?:n} (along connected blocks) {"edges":a} {"slab":a,"axis","from","to"} {"convex":a} {"fill_holes":a} · ' +
      '{"checker":a,"size"?} {"random":a,"ratio":0.3,"seed"?} {"every":a,"n":4,"along":"x"} {"freeze":a} (a stored selection keeps today\'s voxels) · ' +
      '{"hull":[[x,y,z],...]} {"tube":{"path":[[x,y,z],...],"radius":r}}. Nest freely.',
  );

/** Arguments every op takes (05): raw skips auto-connection; as/kind register a component. */
export const commonSchema = {
  raw: z.boolean().optional().describe("Write states exactly as given: skip auto-connection of fences, walls, panes, stairs, redstone and chests (they and their neighbours are otherwise recomputed)"),
  as: z.string().optional().describe('Register the affected bounding box as a component, e.g. "keep"'),
  kind: z.string().optional().describe('Component kind, e.g. "tower", "wall", "floor"'),
};

export const common = (a: { raw?: boolean | undefined; as?: string | undefined; kind?: string | undefined }): CommonOptions => ({
  ...(a.raw ? { raw: true } : {}),
  ...(a.as ? { as: a.as } : {}),
  ...(a.kind ? { kind: a.kind } : {}),
});

export const componentLine = (a: { as?: string | undefined }): string[] => (a.as ? [`component: ${a.as}`] : []);

// ---- helpers -------------------------------------------------------------------------------------

export const env = (c: InstanceContext): OpEnv => ({ registry: c.registry, index: c.palette, plugins: c.plugins });
export const box = (b: PublicBox): Box => fromPublic(b);

/**
 * The region an op works on, from `sel` (any selection) or `box` (the older shorthand). Records it
 * as "last". Returns notes from resolution (e.g. a flood fill whose seed didn't match).
 */
export function regionOf(
  c: InstanceContext,
  doc: Document,
  a: { sel?: unknown; box?: unknown },
  fallback?: SelExpr,
): { region: Region; label?: string; notes: string[] } {
  if (a.sel !== undefined && a.box !== undefined) throw new Error("give sel or box, not both");
  if (a.box !== undefined) {
    doc.lastSelection = a.box as SelExpr;
    return { region: box(a.box as PublicBox), notes: [] };
  }
  const expr = (a.sel ?? fallback) as SelExpr | undefined;
  if (expr === undefined) throw new Error('give sel (a selection, e.g. {"min":[0,0,0],"max":[4,3,4]}) or box');
  const r = resolveSelection(expr, { doc, registry: c.registry, index: c.palette });
  if (expr !== "last") doc.lastSelection = expr;
  if (r.mask.isEmpty()) throw new Error(["the selection is empty", ...r.notes].join("; "));
  return { region: r.mask, ...(typeof expr === "string" && expr !== "all" ? { label: `sel "${expr}"` } : {}), notes: r.notes };
}

/** Runs an edit on the open document and schedules the autosave. */
export function editWith(session: Session, run: (doc: Document) => string): Result {
  const doc = session.require();
  const out = run(doc);
  session.touch();
  return text(out);
}

/** One block baker per loaded instance (models and textures are cached inside it). */
const bakers = new WeakMap<InstanceContext, Promise<BlockBaker>>();
export function bakerFor(c: InstanceContext): Promise<BlockBaker> {
  let p = bakers.get(c);
  if (!p) {
    p = (async () => {
      const loader = new TextureLoader(c.stack);
      const tinter = new Tinter(loader);
      await tinter.init();
      return new BlockBaker(c.stack, loader, tinter, c.registry, c.plugins);
    })();
    bakers.set(c, p);
  }
  return p;
}
