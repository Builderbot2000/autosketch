import { fromPublic, toPublic, type Box, type PublicBox } from "../core/region.js";
import type { Document } from "../document/document.js";
import { RECORD_BYTES } from "./deltas.js";
import type { StateIds } from "./states.js";

/**
 * Voxel payloads for the viewer's `/doc/<doc>/snapshot` and `/doc/<doc>/region` endpoints
 * (docs/design/12-observability.md, *Endpoints*).
 *
 *   "ASVX"  u32 header length  header JSON (utf8)  records…
 *
 * The header is `{ v: 1, doc, seq, bounds?, box?, count, states: { "<id>": "<state>" } }`: the
 * bus `seq` the voxels are current as of, the document's local bounds, the requested box, and the
 * log-wide ids used by the records. Records are the `deltas.bin` format (`deltas.ts`): one per
 * non-air block, in the document's local frame. The viewer decodes both with one reader.
 */

export const VOXELS_MAGIC = "ASVX";

export interface VoxelHeader {
  v: 1;
  doc: string;
  seq: number;
  bounds?: PublicBox;
  box?: PublicBox;
  count: number;
  states: Record<string, string>;
}

/** Encodes the non-air blocks of `doc` (inside `box`, local inclusive, when given). */
export function encodeVoxels(doc: Document, tag: string, table: StateIds, seq: number, box?: PublicBox): Buffer[] {
  const map = new Int32Array(doc.states.size).fill(-1);
  const states: Record<string, string> = {};
  const chunks: Buffer[] = [];
  let chunk = Buffer.alloc(RECORD_BYTES * 4096);
  let used = 0;
  let count = 0;
  const [ox, oy, oz] = doc.toLocal(0, 0, 0);
  const visit = (x: number, y: number, z: number, v: number) => {
    let id = map[v]!;
    if (id < 0) {
      const s = doc.states.get(v);
      map[v] = id = table.id(s);
      states[id] = s;
    }
    if (used === chunk.length) {
      chunks.push(chunk);
      chunk = Buffer.alloc(chunk.length);
      used = 0;
    }
    chunk.writeInt32LE(x + ox, used);
    chunk.writeInt32LE(y + oy, used + 4);
    chunk.writeInt32LE(z + oz, used + 8);
    chunk.writeUInt32LE(id, used + 12);
    used += RECORD_BYTES;
    count++;
  };
  if (box) doc.voxels.forEachInBox(doc.boxToStore(fromPublic(box)), visit);
  else doc.voxels.forEach(visit);
  chunks.push(chunk.subarray(0, used));
  const bounds = doc.localBounds();
  const header: VoxelHeader = { v: 1, doc: tag, seq, ...(bounds ? { bounds: toPublic(bounds) } : {}), ...(box ? { box } : {}), count, states };
  const json = Buffer.from(JSON.stringify(header));
  const head = Buffer.alloc(8);
  head.write(VOXELS_MAGIC, 0, "latin1");
  head.writeUInt32LE(json.length, 4);
  return [head, json, ...chunks];
}

/** Parses `x0,y0,z0,x1,y1,z1` (inclusive) into a public box, or undefined. */
export function parseBoxParam(raw: string | null): PublicBox | undefined {
  if (!raw) return undefined;
  const n = raw.split(",").map((s) => Number(s.trim()));
  if (n.length !== 6 || n.some((v) => !Number.isInteger(v))) return undefined;
  const box: Box = fromPublic({ min: [n[0]!, n[1]!, n[2]!], max: [n[3]!, n[4]!, n[5]!] });
  if (box.max.some((v, i) => v <= box.min[i]!)) return undefined;
  return toPublic(box);
}

/** Decodes a voxel payload (for tests). */
export function decodeVoxels(buf: Buffer): { header: VoxelHeader; records: Buffer } {
  if (buf.toString("latin1", 0, 4) !== VOXELS_MAGIC) throw new Error("not a voxel payload");
  const len = buf.readUInt32LE(4);
  return { header: JSON.parse(buf.toString("utf8", 8, 8 + len)) as VoxelHeader, records: buf.subarray(8 + len) };
}
