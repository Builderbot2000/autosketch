import { z } from "zod";
import type { Box, Vec3 } from "../../core/region.js";
import { getCamera, listCameras, removeCamera, saveCamera, type SavedCamera } from "../../document/cameras.js";
import type { Document } from "../../document/document.js";
import { resolveAnchor, type AtSpec } from "../../ops/anchors.js";
import { resolveSelection, type SelExpr } from "../../ops/selection.js";
import { perspectiveSetup, type PerspectiveView } from "../../perception/render/render.js";
import type { InstanceContext } from "../context.js";
import { atSchema } from "./anchor.js";
import { env, selSchema, text, type ToolDeps } from "./shared.js";

/**
 * Saved cameras (docs/design/06-perception.md, *Cameras*): the `camera` tool and the resolution of
 * a perspective camera's target (a position, an anchor, or a selection, which is framed), shared
 * with the `render` tool.
 */

/** Block units: an integer is the block's centre; fractions are allowed. */
export const pointSchema = z.tuple([z.number(), z.number(), z.number()]);

export const targetSchema = z
  .union([pointSchema, atSchema, z.object({ sel: selSchema })])
  .describe('What the camera looks at: [x,y,z] · an anchor ("comp.anchor", {anchor, offset}, {face, u, v}) · {sel: <selection>} (aimed at its centre and framed: without fov, the fov fits it)');

export const perspectiveSchema = {
  eye: pointSchema.describe("Eye position in blocks (an integer is the block's centre; fractions allowed). May be inside the build"),
  target: targetSchema,
  fov: z.number().min(5).max(150).optional().describe("Vertical field of view in degrees, as in Minecraft (default 70)"),
};

export interface PerspectiveInput {
  eye: Vec3;
  target: unknown;
  fov?: number | undefined;
}

/** Resolves a camera target to a point in block units (and a frame box for a selection). Notes come from selection resolution. */
export function resolveTarget(c: InstanceContext, doc: Document, t: unknown): { point: Vec3; frame?: Box; notes: string[]; desc: string } {
  if (t && typeof t === "object" && !Array.isArray(t) && "sel" in t) {
    const r = resolveSelection((t as { sel: unknown }).sel as SelExpr, { doc, registry: c.registry, index: c.palette });
    const box = r.mask.bbox();
    if (!box) throw new Error(["the camera's target selection is empty", ...r.notes].join("; "));
    const point: Vec3 = [0, 1, 2].map((i) => (box.min[i]! + box.max[i]!) / 2 - 0.5) as Vec3;
    return { point, frame: box, notes: r.notes, desc: "the selection's centre" };
  }
  if (Array.isArray(t) && t.length === 3 && t.every((n) => typeof n === "number")) return { point: [...t] as Vec3, notes: [], desc: "" };
  const at = resolveAnchor(doc, t as AtSpec, env(c));
  return { point: at.pos, notes: [], desc: at.desc };
}

/** Resolves a perspective camera's target (see resolveTarget). */
export function resolvePerspective(c: InstanceContext, doc: Document, a: PerspectiveInput): { view: PerspectiveView; notes: string[]; desc: string } {
  const t = resolveTarget(c, doc, a.target);
  const view: PerspectiveView = { eye: [...a.eye] as Vec3, target: t.point, ...(a.fov !== undefined ? { fov: a.fov } : {}), ...(t.frame ? { frame: t.frame } : {}) };
  return { view, notes: t.notes, desc: t.desc };
}

const fmt = (p: Vec3) => `(${p.map((n) => +n.toFixed(2)).join(",")})`;
const line = (name: string, cam: SavedCamera) => `${name}: eye ${fmt(cam.eye)} target ${fmt(cam.target)} fov ${+cam.fov.toFixed(1)}°`;

export function registerCameraTools({ tool, session }: ToolDeps): void {
  tool(
    "camera",
    {
      title: "Cameras",
      description:
        "Saves a named perspective camera on the document (name + eye + target, fov? default 70°), for render({views:[{camera:\"<name>\"}]}). " +
        "eye and target are in blocks (an integer is the block's centre); the eye may sit inside a room. target is a position, an anchor, or {sel: <selection>} (aimed at its centre; " +
        "without fov the fov is fitted to it, for a square view). Saved cameras are kept with the document, not journaled. name alone shows one; delete:true removes it; " +
        "no arguments lists them. A linked document saves the requesting player's view as \"player\". Text, <100 tokens.",
      inputSchema: {
        name: z.string().optional(),
        eye: perspectiveSchema.eye.optional(),
        target: targetSchema.optional(),
        fov: perspectiveSchema.fov,
        delete: z.boolean().optional(),
      },
      readOnly: false,
    },
    (c, a) => {
      const doc = session.require();
      if (a.delete) {
        if (!a.name) throw new Error("delete needs name");
        if (!removeCamera(doc, a.name)) throw new Error(`no saved camera "${a.name}"`);
        session.touch();
        return text(`removed camera "${a.name}"`);
      }
      if (a.eye !== undefined || a.target !== undefined) {
        if (!a.name) throw new Error("give name to save a camera");
        if (a.eye === undefined || a.target === undefined) throw new Error("a camera needs both eye and target");
        const r = resolvePerspective(c, doc, { eye: a.eye as Vec3, target: a.target, fov: a.fov });
        const fov = perspectiveSetup(r.view, 1, 1).fov;
        saveCamera(doc, a.name, { eye: r.view.eye, target: r.view.target, fov });
        session.touch();
        const cam = getCamera(doc, a.name)!;
        return text([`saved camera ${line(a.name, cam)}${r.desc ? ` (target: ${r.desc})` : ""}`, `render({views:[{camera:"${a.name}"}]}) draws it.`, ...r.notes.map((n) => `note: ${n}`)].join("\n"));
      }
      if (a.name) {
        const cam = getCamera(doc, a.name);
        if (!cam) throw new Error(`no saved camera "${a.name}"${doc.cameras.size ? ` (have: ${[...doc.cameras.keys()].sort().join(", ")})` : ""}`);
        return text(line(a.name, cam));
      }
      const all = listCameras(doc);
      return text(all.length ? all.map(([k, v]) => line(k, v)).join("\n") : "No saved cameras. camera({name, eye, target}) saves one.");
    },
  );
}
