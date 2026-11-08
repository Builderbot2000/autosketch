import type { Vec3 } from "../core/region.js";
import type { Document } from "./document.js";

/**
 * Saved cameras (docs/design/06-perception.md, *Cameras*): named perspective cameras stored on the
 * document like saved selections, saved with it and not journaled. `render({ views: [{ camera:
 * "<name>" }] })` reuses one. A linked document saves the requesting player's view as `player`
 * (13, *Prompting from the game*).
 *
 * Positions are in block units, document-local, where an integer names the centre of that block
 * (so rounding gives the block the point lies in): an eye at [5, 2, 5] sits in the middle of block
 * (5,2,5). Fractions are allowed. The document keeps them in store coordinates (04), so a
 * re-origin moves saved cameras with the blocks.
 */

export interface SavedCamera {
  eye: Vec3;
  /** The point looked at (always a resolved position: anchors and selections are resolved when saved). */
  target: Vec3;
  /** Vertical field of view in degrees, as in Minecraft. */
  fov: number;
}

/** Minecraft's default vertical field of view. */
export const DEFAULT_FOV = 70;
const NAME = /^[a-z][a-z0-9_.-]*$/i;

function checkCamera(name: string, cam: SavedCamera): void {
  if (!NAME.test(name)) throw new Error(`camera name must start with a letter and use letters, digits, _ . or - (got "${name}")`);
  if (![...cam.eye, ...cam.target, cam.fov].every(Number.isFinite)) throw new Error("camera eye, target and fov must be finite numbers");
  if (cam.eye.every((v, i) => Math.abs(v - cam.target[i]!) < 1e-9)) throw new Error("camera target must differ from the eye");
  if (!(cam.fov > 0 && cam.fov < 180)) throw new Error(`camera fov must be between 0 and 180 degrees (got ${cam.fov})`);
}

const shift = (p: Vec3, o: Vec3, sign: 1 | -1): Vec3 => [p[0] + sign * o[0], p[1] + sign * o[1], p[2] + sign * o[2]];

/**
 * Saves (or replaces) a named camera, given in document-local block units (see above). Not
 * journaled; bumps the revision so the document autosaves. `fov` defaults to 70°. Used by the `camera` tool and by the
 * world link for the `player` camera (13).
 */
export function saveCamera(doc: Document, name: string, camera: { eye: Vec3; target: Vec3; fov?: number }): void {
  const cam: SavedCamera = { eye: [...camera.eye], target: [...camera.target], fov: camera.fov ?? DEFAULT_FOV };
  checkCamera(name, cam);
  doc.cameras.set(name, { eye: shift(cam.eye, doc.origin, 1), target: shift(cam.target, doc.origin, 1), fov: cam.fov });
  doc.revision++;
}

/** A saved camera in document-local block units, or undefined. */
export function getCamera(doc: Document, name: string): SavedCamera | undefined {
  const c = doc.cameras.get(name);
  return c && { eye: shift(c.eye, doc.origin, -1), target: shift(c.target, doc.origin, -1), fov: c.fov };
}

/** Removes a saved camera; false when there was none. */
export function removeCamera(doc: Document, name: string): boolean {
  if (!doc.cameras.delete(name)) return false;
  doc.revision++;
  return true;
}

/** Every saved camera, local, by name. */
export function listCameras(doc: Document): [string, SavedCamera][] {
  return [...doc.cameras.keys()].sort().map((k) => [k, getCamera(doc, k)!]);
}

/**
 * The point 16 blocks ahead of an eye facing Minecraft's yaw and pitch (degrees; yaw 0 faces south
 * (+Z) and 90 west, pitch is positive looking down), for saving a player's view as a camera (13).
 */
export function lookTarget(eye: Vec3, yaw: number, pitch: number): Vec3 {
  const y = (yaw * Math.PI) / 180, p = (pitch * Math.PI) / 180;
  const d: Vec3 = [-Math.sin(y) * Math.cos(p), -Math.sin(p), Math.cos(y) * Math.cos(p)];
  return [eye[0] + 16 * d[0], eye[1] + 16 * d[1], eye[2] + 16 * d[2]];
}
