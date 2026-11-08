import { canonicalState, stateId } from "../../core/blockstate.js";
import type { Vec3 } from "../../core/region.js";
import type { Document } from "../../document/document.js";
import { faceIndex, facePoint, resolveFace, storeyLevel, type Face } from "../anchors.js";
import { opEdit, type OpEnv } from "../edit.js";
import type { MaterialExpr } from "../material.js";
import { checkInt, componentId, Writer, type GenOptions, type GenResult } from "./shared.js";

/**
 * Openings in a component's face (docs/design/05-operations.md, Generators): `window` and `door`.
 * `on` names the face ("keep.front", "keep.east"…, 05 Anchors) and `u`/`v` place the opening's
 * bottom-centre on it with the face coordinates of `ops/anchors.ts` (default: centred, one block
 * above the bottom for windows, at the bottom for doors; `v: "storey:2"` sits on storey 2).
 * `depth` cuts through that many layers of the wall, inward from the face.
 */

export interface OpeningPlacement {
  on: string;
  u?: number | string;
  v?: number | string;
  /** Layers cut inward from the face (default 1). */
  depth?: number;
}

function place(doc: Document, env: OpEnv, p: OpeningPlacement, w: number, vDefault: number | string, notes: string[]): { face: Face; iu: number; iv: number } {
  const face = resolveFace(doc, p.on);
  const centre = faceIndex(p.u ?? 0.5, face.width, "u");
  const iu = centre - Math.floor((w - 1) / 2);
  const v = p.v ?? vDefault;
  const iv = typeof v === "string" && /^storey[:_]/.test(v) ? storeyLevel(doc, face.component, Number(v.slice(7)), env) - face.origin[1] : faceIndex(v, face.height, "v");
  const bc = facePoint(face, centre, iv);
  notes.push(`on ${p.on} (${face.dir} face), bottom centre ${bc.join(",")}`);
  if (iu < 0 || iu + w > face.width) notes.push(`the opening runs past the face's edge (face is ${face.width} wide)`);
  return { face, iu, iv };
}

/** Local position of face cell (iu, iv) pushed `k` layers inward (k < 0: outward). */
function cell(f: Face, iu: number, iv: number, k = 0): Vec3 {
  const p = facePoint(f, iu, iv);
  return [p[0] - f.normal[0] * k, p[1] - f.normal[1] * k, p[2] - f.normal[2] * k];
}

export interface WindowOptions extends GenOptions, OpeningPlacement {
  w?: number;
  h?: number;
  /** plain (default) · arched (top corners filled) · cross (mullion and transom in the frame material). */
  style?: "plain" | "arched" | "cross";
  /** Glazing (default glass_pane). */
  glass?: MaterialExpr;
  /** A ring around the opening on the face, and the arched/cross infill. */
  frame?: MaterialExpr;
  /** A block under the opening, one out from the face (e.g. an upside-down stair or a slab). */
  sill?: MaterialExpr;
}

export function window(doc: Document, env: OpEnv, opts: WindowOptions): GenResult {
  const notes: string[] = [];
  const w = checkInt(opts.w ?? 1, "w", 1, 32), h = checkInt(opts.h ?? 2, "h", 1, 32);
  const depth = checkInt(opts.depth ?? 1, "depth", 1, 8);
  const style = opts.style ?? "plain";
  if (!["plain", "arched", "cross"].includes(style)) throw new Error(`unknown window style "${style}" (plain, arched, cross)`);
  const { face, iu, iv } = place(doc, env, opts, w, "1", notes);
  if (face.dir === "top" || face.dir === "bottom") throw new Error("windows go on a side face (front, back, left, right, or a compass side)");
  const id = componentId(doc, opts, "window");
  const r = opEdit(doc, env, "window", `window ${w}×${h} on ${opts.on} as ${id}`, opts, (tx) => {
    const W = new Writer(doc, env, tx);
    const glass = W.material(opts.glass ?? "minecraft:glass_pane");
    const frame = opts.frame !== undefined ? W.material(opts.frame) : undefined;
    const midU = iu + Math.floor((w - 1) / 2), midV = iv + Math.floor(h / 2);
    for (let a = 0; a < w; a++)
      for (let b = 0; b < h; b++) {
        const u = iu + a, v = iv + b;
        const corner = style === "arched" && w > 2 && b === h - 1 && (a === 0 || a === w - 1);
        const bar = style === "cross" && ((w >= 3 && u === midU) || (h >= 3 && v === midV));
        for (let k = 0; k < depth; k++) {
          const p = cell(face, u, v, k);
          if ((corner || bar) && frame) W.set(p, frame(...p));
          else if (corner) continue;
          else if (k === depth - 1) W.set(p, glass(...p));
          else W.clear(p);
        }
      }
    if (frame)
      for (let a = -1; a <= w; a++)
        for (let b = -1; b <= h; b++) {
          if (a >= 0 && a < w && b >= 0 && b < h) continue;
          const p = cell(face, iu + a, iv + b);
          W.set(p, frame(...p));
        }
    if (opts.sill !== undefined) {
      const sill = W.material(opts.sill);
      for (let a = 0; a < w; a++) {
        const p = cell(face, iu + a, iv - 1, -1);
        W.set(p, W.shaped(sill, p, { facing: oppositeDir(face.dir), half: "top", type: "top" }));
      }
    }
    W.register(id, "window", opts, { bottom: cell(face, midU, iv), top: cell(face, midU, iv + h - 1) });
  });
  return { ...r, component: id, notes };
}

export interface DoorOptions extends GenOptions, OpeningPlacement {
  /** The door block (default oak_door). Both halves are placed; facing is the face's outward direction. */
  block?: string;
  /** 1 or 2 (a double door, hinges on the outside). */
  w?: number;
  /** Opening height (default 2); above the door is cleared. */
  h?: number;
  /** A ring around the opening on the face. */
  frame?: MaterialExpr;
}

export function door(doc: Document, env: OpEnv, opts: DoorOptions): GenResult {
  const notes: string[] = [];
  const w = checkInt(opts.w ?? 1, "w", 1, 2), h = checkInt(opts.h ?? 2, "h", 2, 8);
  const depth = checkInt(opts.depth ?? 1, "depth", 1, 8);
  const { face, iu, iv } = place(doc, env, opts, w, 0, notes);
  if (face.dir === "top" || face.dir === "bottom") throw new Error("doors go on a side face (front, back, left, right, or a compass side)");
  const block = stateId(canonicalState(opts.block ?? "minecraft:oak_door", env.registry).state);
  const info = env.registry?.get(block);
  if (info && !info.properties.half?.includes("lower")) throw new Error(`${block} is not a door (no half=lower/upper)`);
  const facing = face.dir;
  const id = componentId(doc, opts, "door");
  const r = opEdit(doc, env, "door", `door ${block} on ${opts.on} as ${id}`, opts, (tx) => {
    const W = new Writer(doc, env, tx);
    for (let a = 0; a < w; a++) {
      // Seen from outside, the left leaf (u = 0) hinges on the outer edge: hinge "right" from the facing side.
      const hinge = w === 2 ? (a === 0 ? "right" : "left") : "left";
      for (let b = 0; b < h; b++)
        for (let k = 0; k < depth; k++) {
          const p = cell(face, iu + a, iv + b, k);
          if (k === 0 && b < 2) {
            const half = b === 0 ? "lower" : "upper";
            W.set(p, tx.intern(canonicalState(`${block}[facing=${facing},half=${half},hinge=${hinge},open=false]`, env.registry).state));
          } else W.clear(p);
        }
    }
    if (opts.frame !== undefined) {
      const frame = W.material(opts.frame);
      for (let a = -1; a <= w; a++)
        for (let b = 0; b <= h; b++) {
          if (a >= 0 && a < w && b < h) continue;
          const p = cell(face, iu + a, iv + b);
          W.set(p, frame(...p));
        }
    }
    const outside = cell(face, iu, iv, -1);
    W.register(id, "door", opts, { bottom: cell(face, iu, iv), outside, inside: cell(face, iu, iv, depth) });
  });
  return { ...r, component: id, notes };
}

function oppositeDir(d: string): string {
  return ({ north: "south", south: "north", east: "west", west: "east" } as Record<string, string>)[d] ?? d;
}
