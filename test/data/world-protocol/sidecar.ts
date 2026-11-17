import { gunzipSync } from "node:zlib";
import type { Compound } from "prismarine-nbt";
import type { Message, PatchAck, PatchBlock, Sender, SnapshotResult, SurfaceLayer, SurfaceResult, WireArea, WireBox, WorldBlock } from "../../../src/world/protocol/messages.js";
import { splitFrame } from "../../../src/world/protocol/codec.js";
import { decodePreviewBody } from "../../../src/world/protocol/body.js";
import { parseSnbt, toSnbt } from "../../../src/world/protocol/snbt.js";

/**
 * Golden-vector sidecars (docs/design/13-live-world.md, *Wire format*, *Golden vectors*): the
 * decoded value of each `.bin` frame as JSON. `header` is the frame's JSON header exactly;
 * `body` is the decoded body, in encoded order, with block-entity NBT as SNBT.
 */

export interface Sidecar {
  description: string;
  sender: Sender;
  header: Record<string, unknown>;
  body?: Record<string, unknown>;
  /** Large vectors describe their blocks by a rule instead of listing them. */
  generated?: string;
}

type Pos = [number, number, number];
const snbt = (c: Compound | undefined) => (c ? toSnbt(c) : undefined);
const nbt = (s: unknown) => (typeof s === "string" ? parseSnbt(s) : undefined);
const clean = <T extends object>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

function worldBlocks(list: WorldBlock[]) {
  return list.map((b) => clean({ pos: b.pos, state: b.state, nbt: snbt(b.nbt) }));
}

function palette(states: Iterable<string>): string[] {
  return [...new Set(states)];
}

export function sidecarOf(description: string, sender: Sender, m: Message, frame: Uint8Array): Sidecar {
  const { header } = splitFrame(frame.subarray(4));
  const out: Sidecar = { description, sender, header };
  switch (m.type) {
    case "patch":
      out.body = {
        palette: palette(m.blocks.flatMap((b) => [b.expected, b.state])),
        blocks: m.blocks.map((b) => clean({ pos: b.pos, expected: b.expected, expectedNbtHash: b.expectedNbtHash, state: b.state, nbt: snbt(b.nbt) })),
      };
      break;
    case "patch.ack":
      out.body = {
        palette: palette(m.skipped.map((b) => b.state)),
        skipped: worldBlocks(m.skipped),
        reasons: palette(m.rejected.map((r) => r.reason)),
        rejected: m.rejected,
        normalized: m.normalized.map((n) => clean({ pos: n.pos, nbt: snbt(n.nbt) })),
      };
      break;
    case "dirty":
      if (!m.everything) out.body = { palette: palette(m.blocks.map((b) => b.state)), blocks: worldBlocks(m.blocks) };
      break;
    case "registry.result":
      if (!("unchanged" in m)) out.body = { bytes: Buffer.from(m.report).toString("base64"), report: JSON.parse(gunzipSync(m.report).toString("utf8")) };
      break;
    case "upgrade":
    case "upgrade.result":
      out.body = m.kind === "structure" ? { structure: toSnbt(m.structure) } : { states: m.states, blockEntities: m.blockEntities.map(toSnbt), entities: m.entities.map(toSnbt) };
      break;
    case "ui.ghost":
      out.body = { palette: m.palette, sections: m.sections.map((s) => ({ section: s.section, states: Array.from(s.states) })) };
      break;
    case "replay.frame":
      out.body = m.keyframe ? { palette: m.palette, regions: m.regions.map((r) => ({ states: Array.from(r.states) })) } : { palette: palette(m.blocks.map((b) => b.state)), blocks: m.blocks };
      break;
    case "ui.result":
      if (m.ok && m.body) {
        const size = m.result.size as [number, number, number] | undefined;
        out.body = { bytes: Buffer.from(m.body).toString("base64"), ...(size ? { preview: (({ palette, states }) => ({ palette, states: Array.from(states) }))(decodePreviewBody(m.body, size)) } : {}) };
      }
      break;
    case "snapshot.result":
      if ("kind" in m) {
        const layer = (l: SurfaceLayer) => ({ heights: Array.from(l.heights), states: Array.from(l.states) });
        out.body = { palette: m.palette, surface: layer(m.surface), ...(m.ceilings ? { ceilings: layer(m.ceilings) } : {}) };
        break;
      }
      out.body = { palette: m.palette, regions: m.regions.map((r) => ({ states: Array.from(r.states), blockEntities: r.blockEntities.map((b) => ({ pos: b.pos, nbt: toSnbt(b.nbt) })) })) };
      break;
  }
  return out;
}

/** Rebuilds the message a sidecar describes (the encoder recomputes origin, size and counts). */
export function messageOf(s: Sidecar): Message {
  const h = { ...s.header } as Record<string, unknown>;
  const b = (s.body ?? {}) as Record<string, any>;
  switch (h.type) {
    case "patch": {
      const blocks: PatchBlock[] = (b.blocks as any[]).map((x) => clean({ pos: x.pos as Pos, expected: x.expected, expectedNbtHash: x.expectedNbtHash, state: x.state, nbt: nbt(x.nbt) }));
      return { type: "patch", id: h.id as number, link: h.link as number, dimension: h.dimension as string, ...(h.force ? { force: true } : {}), blocks };
    }
    case "patch.ack": {
      const m: PatchAck = {
        type: "patch.ack",
        id: h.id as number,
        applied: h.applied as number,
        overwritten: h.overwritten as number,
        skipped: (b.skipped as any[]).map((x) => clean({ pos: x.pos, state: x.state, nbt: nbt(x.nbt) })),
        rejected: b.rejected,
        normalized: (b.normalized as any[]).map((x) => clean({ pos: x.pos, nbt: nbt(x.nbt) })),
      };
      return m;
    }
    case "dirty":
      if (h.everything) return { type: "dirty", everything: true };
      return { type: "dirty", everything: false, blocks: (b.blocks as any[]).map((x) => clean({ pos: x.pos, state: x.state, nbt: nbt(x.nbt) })) };
    case "snapshot.result": {
      if (h.kind === "surface") {
        const layer = (l: { heights: number[]; states: number[] }): SurfaceLayer => ({ heights: Uint32Array.from(l.heights), states: Uint32Array.from(l.states) });
        const m: SurfaceResult = {
          type: "snapshot.result",
          id: h.id as number,
          dimension: h.dimension as string,
          kind: "surface",
          columns: h.columns as WireArea,
          minY: h.minY as number,
          ...(h.ceiling !== undefined ? { ceiling: h.ceiling as number } : {}),
          missing: h.missing as [number, number][],
          palette: b.palette,
          surface: layer(b.surface),
          ...(b.ceilings ? { ceilings: layer(b.ceilings) } : {}),
        };
        return m;
      }
      const regions = (h.regions as SnapshotResult["regions"][number]["box"][]).map((box, i) => ({
        box,
        states: Uint32Array.from(b.regions[i].states as number[]),
        blockEntities: (b.regions[i].blockEntities as any[]).map((x) => ({ pos: x.pos, nbt: parseSnbt(x.nbt) })),
      }));
      return { type: "snapshot.result", id: h.id as number, dimension: h.dimension as string, palette: b.palette, regions };
    }
    case "registry.result":
      if (h.unchanged) return h as unknown as Message;
      return { type: "registry.result", id: h.id as number, hash: h.hash as string, dataVersion: h.dataVersion as number, report: new Uint8Array(Buffer.from(b.bytes as string, "base64")) };
    case "upgrade":
    case "upgrade.result": {
      const data =
        h.kind === "structure"
          ? { kind: "structure" as const, structure: parseSnbt(b.structure as string) }
          : { kind: "elements" as const, states: b.states as string[], blockEntities: (b.blockEntities as string[]).map((x) => parseSnbt(x)), entities: (b.entities as string[]).map((x) => parseSnbt(x)) };
      if (h.type === "upgrade") return { type: "upgrade", id: h.id as number, from: h.from as number, ...data };
      return { type: "upgrade.result", id: h.id as number, to: h.to as number, ...(h.failed ? { failed: h.failed as number } : {}), ...data };
    }
    case "ui.ghost": {
      const { palette: _p, sections: _s, ...rest } = h;
      return { ...(rest as object), palette: b.palette, sections: (b.sections as { section: Pos; states: number[] }[]).map((x) => ({ section: x.section, states: Uint32Array.from(x.states) })) } as Message;
    }
    case "replay.frame":
      if (h.keyframe) {
        const { regions, ...rest } = h;
        return { ...(rest as object), palette: b.palette, regions: (regions as WireBox[]).map((box, i) => ({ box, states: Uint32Array.from(b.regions[i].states as number[]) })) } as unknown as Message;
      } else {
        const { origin: _o, size: _s, count: _c, ...rest } = h;
        return { ...(rest as object), blocks: b.blocks } as Message;
      }
    case "ui.result":
      return { ...(h as object), ...(s.body ? { body: new Uint8Array(Buffer.from(b.bytes as string, "base64")) } : {}) } as Message;
    case "hashes.result":
      return { type: "hashes.result", id: h.id as number, sections: (h.sections as [number, number, number, string][]).map(([x, y, z, hash]) => ({ section: [x, y, z], hash })) };
    default:
      return h as unknown as Message;
  }
}
