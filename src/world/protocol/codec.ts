import type { Vec3 } from "../../core/region.js";
import {
  decodeAckBody,
  decodeDirtyBody,
  decodePatchBody,
  decodeSnapshotBody,
  decodeSurfaceBody,
  decodeUpgradeBody,
  decodeCoarseBody,
  decodeFillBody,
  decodeSearchBody,
  encodeCoarseBody,
  encodeFillBody,
  encodeSearchBody,
  encodeAckBody,
  encodeDirtyBody,
  encodePatchBody,
  encodeSnapshotBody,
  encodeSurfaceBody,
  encodeUpgradeBody,
  decodeStatesBody,
  encodeStatesBody,
  sectionBox,
  type Grid,
} from "./body.js";
import {
  COARSE_CELLS,
  ERROR_CODES,
  FILL_STOPS,
  MATCH_SOLID,
  MAX_FRAME,
  MAX_HEADER,
  PROMPT_REFUSALS,
  REPLAY_MARKERS,
  REQUEST_CONTROL_ACTIONS,
  REQUEST_MODES,
  REQUEST_STATES,
  UI_ERRORS,
  UI_FILL_SPANS,
  UI_MCP_TYPES,
  type ChatMessage,
  type ExpandBy,
  type SearchCluster,
  type UiFill,
  type UiFlash,
  type UiJob,
  type UiSpan,
  type UiState,
  type GameContext,
  type Message,
  type McpMessage,
  type ModMessage,
  type PlayerRef,
  type Sender,
  type StatusAction,
  type StatusMessage,
  type VolatileList,
  type WireArea,
  type WireBox,
} from "./messages.js";

/**
 * Message codec (docs/design/13-live-world.md, *Wire format*). A frame is a u32 big-endian length
 * of the rest, a u32 big-endian header length, the JSON header (UTF-8) and the binary body.
 * Headers are written compact, keys in the order the spec's tables list them; decoding validates
 * every field and throws `ProtocolError` on anything malformed.
 */

export class ProtocolError extends Error {
  override readonly name = "ProtocolError";
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function box(b: WireBox): WireBox {
  return { min: [b.min[0], b.min[1], b.min[2]], max: [b.max[0], b.max[1], b.max[2]] };
}

function area(a: WireArea): WireArea {
  return { min: [a.min[0], a.min[1]], max: [a.max[0], a.max[1]] };
}

function grid(g: Grid): { origin: Vec3; size: Vec3 } {
  return { origin: g.origin, size: g.size };
}

/** The JSON header object for a message, with keys in spec order, plus its body. */
function split(m: Message): { header: Record<string, unknown>; body: Uint8Array } {
  const none = new Uint8Array(0);
  switch (m.type) {
    case "hello":
      if ("token" in m)
        return {
          header: { type: m.type, protocol: m.protocol, token: m.token, client: { name: m.client.name, version: m.client.version }, volatile: m.volatile, ...(m.modes ? { modes: [...m.modes] } : {}), ...(m.features ? { features: [...m.features] } : {}) },
          body: none,
        };
      return {
        header: {
          type: m.type,
          protocol: m.protocol,
          mod: { version: m.mod.version },
          game: { version: m.game.version, dataVersion: m.game.dataVersion, loader: m.game.loader, loaderVersion: m.game.loaderVersion },
          singleplayer: m.singleplayer,
          host: m.host && player(m.host),
          ...(m.features ? { features: [...m.features] } : {}),
        },
        body: none,
      };
    case "error":
      return { header: { type: m.type, id: m.id, code: m.code, message: m.message, ...(m.protocol !== undefined ? { protocol: m.protocol } : {}) }, body: none };
    case "volumes":
      if (m.work === null) return { header: { type: m.type, link: m.link, work: null }, body: none };
      return {
        header: { type: m.type, ...(m.id !== undefined ? { id: m.id } : {}), link: m.link, dimension: m.dimension, work: box(m.work), context: m.context.map(box), ...(m.extended ? { extended: box(m.extended) } : {}) },
        body: none,
      };
    case "volumes.extend":
      return { header: { type: m.type, id: m.id, link: m.link, work: box(m.work) }, body: none };
    case "volumes.set":
      return { header: { type: m.type, id: m.id, dimension: m.dimension, work: box(m.work), ...(m.context ? { context: m.context.map(box) } : {}) }, body: none };
    case "hashes":
      return { header: { type: m.type, id: m.id, dimension: m.dimension, boxes: m.boxes.map(box) }, body: none };
    case "hashes.result":
      return { header: { type: m.type, id: m.id, sections: m.sections.map((s) => [s.section[0], s.section[1], s.section[2], s.hash]) }, body: none };
    case "snapshot":
      if ("kind" in m && m.kind === "surface") return { header: { type: m.type, id: m.id, dimension: m.dimension, kind: m.kind, columns: area(m.columns), ...(m.ceiling !== undefined ? { ceiling: m.ceiling } : {}) }, body: none };
      if ("kind" in m && m.kind === "mask") return { header: { type: m.type, id: m.id, dimension: m.dimension, kind: m.kind, sections: m.sections.map((s) => [s[0], s[1], s[2]]), ...(m.margin !== undefined ? { margin: m.margin } : {}) }, body: none };
      if ("kind" in m && m.kind === "coarse") return { header: { type: m.type, id: m.id, dimension: m.dimension, kind: m.kind, cell: m.cell, boxes: m.boxes.map(box) }, body: none };
      if ("boxes" in m) return { header: { type: m.type, id: m.id, dimension: m.dimension, boxes: m.boxes.map(box) }, body: none };
      return { header: { type: m.type, id: m.id, dimension: m.dimension, sections: m.sections.map((s) => [s[0], s[1], s[2]]) }, body: none };
    case "snapshot.result":
      if ("kind" in m && m.kind === "coarse")
        return {
          header: { type: m.type, id: m.id, dimension: m.dimension, kind: m.kind, cell: m.cell, regions: m.regions.map((r) => box(r.box)), ...(m.missing?.length ? { missing: chunkList(m.missing) } : {}) },
          body: encodeCoarseBody(m.palette, m.regions, m.cell),
        };
      if ("kind" in m) {
        if ((m.ceiling === undefined) !== (m.ceilings === undefined)) throw new ProtocolError("surface result: ceilings must be given exactly when ceiling is");
        return {
          header: { type: m.type, id: m.id, dimension: m.dimension, kind: m.kind, columns: area(m.columns), minY: m.minY, ...(m.ceiling !== undefined ? { ceiling: m.ceiling } : {}), missing: m.missing.map((c) => [c[0], c[1]]) },
          body: encodeSurfaceBody(m),
        };
      }
      return {
        header: { type: m.type, id: m.id, dimension: m.dimension, regions: m.regions.map((r) => box(r.box)), ...(m.missing?.length ? { missing: chunkList(m.missing) } : {}) },
        body: encodeSnapshotBody(m.palette, m.regions),
      };
    case "search":
      if ("continue" in m) return { header: { type: m.type, id: m.id, dimension: m.dimension, continue: true, ...(m.stop !== undefined ? { stop: m.stop } : {}) }, body: none };
      return {
        header: {
          type: m.type,
          id: m.id,
          dimension: m.dimension,
          materials: [...m.materials],
          ...(m.radius !== undefined ? { radius: m.radius } : {}),
          ...(m.around ? { around: [...m.around] } : {}),
          ...(m.gap !== undefined ? { gap: m.gap } : {}),
          ...(m.stop !== undefined ? { stop: m.stop } : {}),
        },
        body: none,
      };
    case "search.result":
      return {
        header: {
          type: m.type,
          id: m.id,
          dimension: m.dimension,
          materials: [...m.materials],
          centre: [m.centre[0], m.centre[1]],
          radius: m.radius,
          ...(m.clipped ? { clipped: true } : {}),
          reached: m.reached,
          minSection: m.minSection,
          clusters: m.clusters.map((c) => ({ min: [c.min[0], c.min[1]], max: [c.max[0], c.max[1]], chunks: c.chunks, blocks: c.blocks, closed: c.closed })),
          chunks: m.chunks.length,
          missing: m.missing.length,
        },
        body: encodeSearchBody(m),
      };
    case "fill":
      return {
        header: {
          type: m.type,
          id: m.id,
          dimension: m.dimension,
          seed: [...m.seed],
          match: [...m.match],
          ...(m.connectivity !== undefined ? { connectivity: m.connectivity } : {}),
          ...(m.budget !== undefined ? { budget: m.budget } : {}),
          ...(m.area !== undefined ? { area: m.area } : {}),
        },
        body: none,
      };
    case "expand":
      return { header: { type: m.type, id: m.id, dimension: m.dimension, by: expandBy(m.by), ...(m.budget !== undefined ? { budget: m.budget } : {}) }, body: none };
    case "fill.result": {
      if ((m.box === null) !== (m.count === 0)) throw new ProtocolError("fill.result: box is null exactly when count is 0");
      const e = encodeFillBody(m);
      return {
        header: {
          type: m.type,
          id: m.id,
          dimension: m.dimension,
          seed: [...m.seed],
          count: m.count,
          box: m.box && box(m.box),
          stopped: m.stopped,
          ...(m.delta ? { delta: true } : {}),
          missing: chunkList(m.missing),
          ...grid(e.grid),
          sections: m.sections.length,
          frontier: m.frontier.length,
        },
        body: e.body,
      };
    }
    case "patch": {
      const e = encodePatchBody(m.blocks);
      return { header: { type: m.type, id: m.id, link: m.link, dimension: m.dimension, ...(m.force ? { force: true } : {}), ...grid(e.grid), count: m.blocks.length }, body: e.body };
    }
    case "patch.ack": {
      const e = encodeAckBody(m);
      if (m.applied < m.overwritten) throw new ProtocolError(`ack: overwritten ${m.overwritten} exceeds applied ${m.applied}`);
      return {
        header: { type: m.type, id: m.id, applied: m.applied, overwritten: m.overwritten, skipped: m.skipped.length, rejected: m.rejected.length, normalized: m.normalized.length, ...grid(e.grid) },
        body: e.body,
      };
    }
    case "dirty": {
      if (m.everything) return { header: { type: m.type, everything: true }, body: none };
      const e = encodeDirtyBody(m.blocks);
      return { header: { type: m.type, everything: false, ...grid(e.grid), count: m.blocks.length }, body: e.body };
    }
    case "registry":
      return { header: { type: m.type, id: m.id, ...(m.have !== undefined ? { have: m.have } : {}) }, body: none };
    case "registry.result":
      if ("unchanged" in m) return { header: { type: m.type, id: m.id, hash: m.hash, dataVersion: m.dataVersion, unchanged: true }, body: none };
      if (!m.report.length) throw new ProtocolError("registry.result: a report that isn't unchanged needs a body");
      return { header: { type: m.type, id: m.id, hash: m.hash, dataVersion: m.dataVersion }, body: m.report };
    case "upgrade":
      return { header: { type: m.type, id: m.id, from: m.from, kind: m.kind }, body: encodeUpgradeBody(m) };
    case "upgrade.result":
      return { header: { type: m.type, id: m.id, to: m.to, kind: m.kind, ...(m.failed ? { failed: m.failed } : {}) }, body: encodeUpgradeBody(m) };
    case "prompt":
      return {
        header: { type: m.type, id: m.id, player: player(m.player), text: m.text, context: context(m.context), ...(m.mode ? { mode: m.mode } : {}) },
        body: none,
      };
    case "prompt.close":
      return { header: { type: m.type, player: player(m.player) }, body: none };
    case "prompt.result":
      if (m.delivered) return { header: { type: m.type, id: m.id, delivered: true }, body: none };
      if ("queued" in m) {
        if (!Number.isInteger(m.position) || m.position < 1) throw new ProtocolError("prompt.result: a queued position is 1 or more");
        return { header: { type: m.type, id: m.id, delivered: false, queued: true, request: m.request, position: m.position }, body: none };
      }
      return { header: { type: m.type, id: m.id, delivered: false, reason: m.reason }, body: none };
    case "request.control":
      if ((m.action === "queue.cancel") !== (m.position !== undefined)) throw new ProtocolError("request.control: position goes exactly with queue.cancel");
      return { header: { type: m.type, player: player(m.player), action: m.action, ...(m.position !== undefined ? { position: m.position } : {}) }, body: none };
    case "canvas":
      if (m.box === null) return { header: { type: m.type, box: null }, body: none };
      return { header: { type: m.type, ...(m.id !== undefined ? { id: m.id } : {}), dimension: m.dimension, box: box(m.box) }, body: none };
    case "canvas.set":
      return { header: { type: m.type, id: m.id, dimension: m.dimension, box: box(m.box) }, body: none };
    case "notice":
      return { header: { type: m.type, text: m.text, player: m.player }, body: none };
    case "chat":
      if (m.kind === "status") return { header: statusHeader(m), body: none };
      if (m.action && (m.kind !== "reply" || !Number.isInteger(m.action.line) || m.action.line < 0 || m.action.line >= m.lines.length)) throw new ProtocolError("chat: an action names one line of a reply");
      return {
        header: { type: m.type, request: m.request, player: m.player, kind: m.kind, lines: [...m.lines], ...(m.action ? { action: { line: m.action.line, kind: m.action.kind, args: m.action.args } } : {}) },
        body: none,
      };
    case "ui.state": {
      const changed = <T>(k: string, v: T | null | undefined) => (m.full || v !== undefined ? { [k]: v ?? null } : {});
      if (m.full && m.removed?.length) throw new ProtocolError("ui.state: a full state removes nothing");
      if (m.full && m.jobs === undefined) throw new ProtocolError("ui.state: a full state lists its jobs");
      if (m.full && m.fillsRemoved?.length) throw new ProtocolError("ui.state: a full state removes no fills");
      return {
        header: {
          type: m.type,
          players: [...m.players],
          seq: m.seq,
          full: m.full,
          ...(m.full || m.jobs?.length ? { jobs: (m.jobs ?? []).map(uiJob) } : {}),
          ...(!m.full && m.removed?.length ? { removed: [...m.removed] } : {}),
          ...changed("request", m.request && { id: m.request.id, mode: m.request.mode, text: m.request.text }),
          ...changed("tokens", m.tokens && { input: m.tokens.input, output: m.tokens.output, cacheRead: m.tokens.cacheRead, cacheCreation: m.tokens.cacheCreation, ...(m.tokens.cost !== undefined ? { cost: m.tokens.cost } : {}) }),
          ...changed("refusal", m.refusal && { code: m.refusal.code, text: m.refusal.text }),
          ...(m.fills?.length ? { fills: m.fills.map(uiFill) } : {}),
          ...(!m.full && m.fillsRemoved?.length ? { fillsRemoved: [...m.fillsRemoved] } : {}),
        },
        body: none,
      };
    }
    case "ui.flash":
      if (!m.flashes.length) throw new ProtocolError("ui.flash: no flashes");
      return { header: { type: m.type, players: [...m.players], flashes: m.flashes.map(uiFlash) }, body: none };
    case "ui.ghost":
      return {
        header: { type: m.type, players: [...m.players], ghost: m.ghost, dimension: m.dimension, origin: [...m.origin], tint: m.tint, full: m.full, sections: m.sections.map((s) => [s.section[0], s.section[1], s.section[2]]) },
        body: encodeStatesBody(
          m.palette,
          m.sections.map((s) => ({ box: sectionBox(s.section), states: s.states })),
        ),
      };
    case "ui.ghost.clear":
      return { header: { type: m.type, players: [...m.players], ghost: m.ghost }, body: none };
    case "replay.frame": {
      const head = { type: m.type, players: [...m.players], replay: m.replay, step: m.step, steps: m.steps, keyframe: m.keyframe };
      const tail = { time: m.time, hud: { call: m.hud.call, brief: m.hud.brief, ...(m.hud.note !== undefined ? { note: m.hud.note } : {}) }, jobs: m.jobs.map(uiJob), flashes: m.flashes.map(uiFlash) };
      if (m.keyframe)
        return {
          header: { ...head, dimension: m.dimension, regions: m.regions.map((r) => box(r.box)), ...tail, markers: m.markers.map((k) => ({ step: k.step, kind: k.kind, label: k.label })) },
          body: encodeStatesBody(m.palette, m.regions),
        };
      const e = encodeDirtyBody(m.blocks);
      return { header: { ...head, from: m.from, dimension: m.dimension, ...grid(e.grid), count: m.blocks.length, ...tail }, body: e.body };
    }
    case "ui.request":
      return { header: { type: m.type, request: m.request, player: player(m.player), kind: m.kind, args: m.args }, body: none };
    case "ui.result":
      if (m.ok) return { header: { type: m.type, request: m.request, player: m.player, ok: true, result: m.result }, body: m.body ?? none };
      return { header: { type: m.type, request: m.request, player: m.player, ok: false, error: m.error, message: m.message }, body: none };
  }
}

/** A status line's header (`19`, *Status line*), checked as the decoder checks it. */
function statusHeader(m: StatusMessage): Record<string, unknown> {
  if (m.lines.length !== 1) throw new ProtocolError("chat status: exactly one line");
  if ((m.state === "queued") !== (m.queuePos !== undefined)) throw new ProtocolError("chat status: queuePos goes exactly with state queued");
  if (m.noTurnSignal && m.state !== "done") throw new ProtocolError("chat status: noTurnSignal only on done");
  return {
    type: m.type,
    request: m.request,
    player: m.player,
    kind: m.kind,
    lines: [m.lines[0]],
    state: m.state,
    text: m.text,
    calls: m.calls,
    elapsedMs: m.elapsedMs,
    ...(m.queuePos !== undefined ? { queuePos: m.queuePos } : {}),
    ...(m.noTurnSignal ? { noTurnSignal: true } : {}),
    actions: m.actions.map((a) => statusAction(a)),
  };
}

function statusAction(a: StatusAction): StatusAction {
  if (!a.label || !a.kind) throw new ProtocolError("chat status: an action has a label and a kind");
  return { label: a.label, kind: a.kind, args: a.args };
}

function chunkList(list: readonly [number, number][]): [number, number][] {
  return list.map((c) => [c[0], c[1]]);
}

function expandBy(b: ExpandBy): ExpandBy {
  if (b === "frontier") return b;
  if ("box" in b) return { box: box(b.box) };
  return { direction: b.direction, chunks: b.chunks };
}

function uiJob(j: UiJob): UiJob {
  return { id: j.id, colour: j.colour, brief: j.brief, dimension: j.dimension, work: box(j.work), context: j.context.map(box) };
}

function uiFlash(f: UiFlash): UiFlash {
  if (!f.boxes.length) throw new ProtocolError(`ui flash for ${f.job}: no boxes`);
  return { job: f.job, colour: f.colour, dimension: f.dimension, boxes: f.boxes.map(box) };
}

function uiFill(f: UiFill): UiFill {
  const out = { id: f.id, colour: f.colour, alpha: f.alpha, dimension: f.dimension, faces: f.faces.map((s) => span(s, 1, "faces")), edges: f.edges.map((s) => span(s, 2, "edges")) };
  if (!Number.isInteger(f.alpha) || f.alpha < 1 || f.alpha > 255) throw new ProtocolError(`ui fill ${f.id}: alpha must be an integer from 1 to 255`);
  if (f.faces.length + f.edges.length > UI_FILL_SPANS) throw new ProtocolError(`ui fill ${f.id}: more than ${UI_FILL_SPANS} faces and edges`);
  return out;
}

/**
 * A face (`flat` 1) or an edge (`flat` 2) on block boundaries: six integers, each min ≤ max, with
 * exactly `flat` axes where min = max (`13`, *In-game UI*, Fill).
 */
function span(v: unknown, flat: 1 | 2, name: string): UiSpan {
  if (!Array.isArray(v) || v.length !== 6 || !v.every(Number.isSafeInteger)) throw new ProtocolError(`${name}: [x1, y1, z1, x2, y2, z2] integers`);
  const s = v as UiSpan;
  let equal = 0;
  for (let a = 0; a < 3; a++) {
    if (s[a]! > s[a + 3]!) throw new ProtocolError(`${name}: min must not exceed max on any axis`);
    if (s[a] === s[a + 3]) equal++;
  }
  if (equal !== flat) throw new ProtocolError(`${name}: ${flat === 1 ? "a face is flat on exactly one axis" : "an edge runs along exactly one axis"}`);
  return [s[0], s[1], s[2], s[3], s[4], s[5]];
}

function player(p: PlayerRef): PlayerRef {
  return { name: p.name, uuid: p.uuid };
}

function context(c: GameContext): GameContext {
  return {
    dimension: c.dimension,
    position: [c.position[0], c.position[1], c.position[2]],
    eye: [c.eye[0], c.eye[1], c.eye[2]],
    yaw: c.yaw,
    pitch: c.pitch,
    facing: c.facing,
    ...(c.target ? { target: { pos: [c.target.pos[0], c.target.pos[1], c.target.pos[2]], state: c.target.state, face: c.target.face } } : {}),
    ...(c.focus ? { focus: box(c.focus) } : {}),
    ...(c.focusClipped ? { focusClipped: true } : {}),
  };
}

/** Encodes one message as a complete frame, length prefix included. */
export function encodeMessage(m: Message): Uint8Array {
  const { header, body } = split(m);
  const h = utf8.encode(JSON.stringify(header));
  if (h.length > MAX_HEADER) throw new ProtocolError(`header of ${h.length} bytes exceeds ${MAX_HEADER}`);
  const len = 4 + h.length + body.length;
  if (len > MAX_FRAME) throw new ProtocolError(`frame of ${len} bytes exceeds ${MAX_FRAME}; split the request`);
  const out = new Uint8Array(4 + len);
  const v = new DataView(out.buffer);
  v.setUint32(0, len);
  v.setUint32(4, h.length);
  out.set(h, 8);
  out.set(body, 8 + h.length);
  return out;
}

/** Splits a frame payload (the bytes after the length prefix) into its header object and body. */
export function splitFrame(payload: Uint8Array): { header: Record<string, unknown>; body: Uint8Array } {
  if (payload.length < 4) throw new ProtocolError(`frame of ${payload.length} bytes has no header length`);
  const hlen = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0);
  if (hlen > MAX_HEADER || hlen > payload.length - 4) throw new ProtocolError(`header length ${hlen} doesn't fit a frame of ${payload.length}`);
  let header: unknown;
  try {
    header = JSON.parse(utf8Decoder.decode(payload.subarray(4, 4 + hlen)));
  } catch (e) {
    throw new ProtocolError(`header is not UTF-8 JSON: ${(e as Error).message}`);
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) throw new ProtocolError("header must be a JSON object");
  return { header: header as Record<string, unknown>, body: payload.subarray(4 + hlen) };
}

/** Decodes a frame payload sent by `sender`. */
export function decodeMessage(payload: Uint8Array, sender: "mcp"): McpMessage;
export function decodeMessage(payload: Uint8Array, sender: "mod"): ModMessage;
export function decodeMessage(payload: Uint8Array, sender: Sender): Message;
export function decodeMessage(payload: Uint8Array, sender: Sender): Message {
  const { header, body } = splitFrame(payload);
  const v = new Fields(header);
  const type = v.str("type");
  try {
    return decode(type, v, body, sender);
  } catch (e) {
    if (e instanceof ProtocolError) throw e;
    throw new ProtocolError(`${type}: ${(e as Error).message}`);
  }
}

/** Decodes a complete frame, length prefix included (golden vectors, tests). */
export function decodeFrame(frame: Uint8Array, sender: Sender): Message {
  if (frame.length < 4) throw new ProtocolError("frame shorter than its length prefix");
  const len = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0);
  if (len !== frame.length - 4) throw new ProtocolError(`length prefix ${len}, frame holds ${frame.length - 4}`);
  return decodeMessage(frame.subarray(4), sender);
}

const MCP_TYPES = new Set(["hello", "error", "volumes.extend", "volumes.set", "hashes", "snapshot", "search", "fill", "expand", "patch", "registry", "upgrade", "prompt.result", "notice", "chat", "canvas.set", ...UI_MCP_TYPES]);
const MOD_TYPES = new Set(["hello", "error", "volumes", "hashes.result", "snapshot.result", "search.result", "fill.result", "patch.ack", "dirty", "prompt", "prompt.close", "registry.result", "upgrade.result", "ui.request", "request.control", "canvas"]);
const BODY_TYPES = new Set(["snapshot.result", "search.result", "fill.result", "patch", "patch.ack", "dirty", "registry.result", "upgrade", "upgrade.result", "ui.ghost", "replay.frame", "ui.result"]);

function decode(type: string, v: Fields, body: Uint8Array, sender: Sender): Message {
  if (!(sender === "mcp" ? MCP_TYPES : MOD_TYPES).has(type)) throw new ProtocolError(`unknown message type "${type}" from the ${sender === "mcp" ? "MCP" : "mod"}`);
  if (!BODY_TYPES.has(type) && body.length) throw new ProtocolError(`${type} carries no body, got ${body.length} bytes`);
  switch (type) {
    case "hello":
      if (sender === "mcp") {
        const client = v.obj("client");
        const modes = v.has("modes") ? { modes: v.arr("modes").map((_, i) => v.oneOfAt("modes", i, REQUEST_MODES)) } : {};
        return { type, protocol: v.int("protocol"), token: v.str("token"), client: { name: client.str("name"), version: client.str("version") }, volatile: volatile(v.raw("volatile")), ...modes, ...(v.has("features") ? { features: v.strings("features") } : {}) };
      } else {
        const game = v.obj("game");
        return {
          type,
          protocol: v.int("protocol"),
          mod: { version: v.obj("mod").str("version") },
          game: { version: game.str("version"), dataVersion: game.int("dataVersion"), loader: game.str("loader"), loaderVersion: game.str("loaderVersion") },
          singleplayer: v.bool("singleplayer"),
          host: v.nullable("host") ? playerRef(v.obj("host")) : null,
          ...(v.has("features") ? { features: v.strings("features") } : {}),
        };
      }
    case "error": {
      const code = v.str("code");
      if (!(ERROR_CODES as readonly string[]).includes(code)) throw new ProtocolError(`unknown error code "${code}"`);
      const protocol = v.has("protocol") ? v.int("protocol") : undefined;
      return { type, id: v.nullable("id") ? v.id("id") : null, code: code as never, message: v.str("message"), ...(protocol !== undefined ? { protocol } : {}) };
    }
    case "volumes": {
      const link = v.int("link");
      if (!v.nullable("work")) return { type, link, work: null };
      const extended = v.has("extended") ? { extended: v.box("extended") } : {};
      const id = v.has("id") ? { id: v.id("id") } : {};
      return { type, ...id, link, dimension: v.str("dimension"), work: v.box("work"), context: v.arr("context").map((_, i) => v.boxAt("context", i)), ...extended };
    }
    case "volumes.extend":
      return { type, id: v.id("id"), link: v.int("link"), work: v.box("work") };
    case "volumes.set": {
      const id = v.id("id"), dimension = v.str("dimension"), work = v.box("work");
      return { type, id, dimension, work, ...(v.has("context") ? { context: v.boxes("context") } : {}) };
    }
    case "hashes":
      return { type, id: v.id("id"), dimension: v.str("dimension"), boxes: v.boxes("boxes") };
    case "hashes.result":
      return {
        type,
        id: v.id("id"),
        sections: v.arr("sections").map((s, i) => {
          if (!Array.isArray(s) || s.length !== 4 || !s.slice(0, 3).every(Number.isSafeInteger) || typeof s[3] !== "string" || !/^[0-9a-f]{16}$/.test(s[3])) throw new ProtocolError(`sections[${i}] must be [sx, sy, sz, "16 hex digits"]`);
          return { section: [s[0], s[1], s[2]] as Vec3, hash: s[3] as string };
        }),
      };
    case "snapshot": {
      const id = v.id("id"), dimension = v.str("dimension");
      const kind = v.has("kind") ? v.oneOf("kind", ["blocks", "surface", "mask", "coarse"]) : "blocks";
      if (kind === "mask") {
        if (v.has("boxes") || v.has("columns") || v.has("ceiling") || v.has("cell")) throw new ProtocolError("a mask snapshot takes sections and margin only");
        const sections = v.arr("sections").map((_, i) => v.vec3At("sections", i));
        if (!sections.length) throw new ProtocolError("sections must not be empty");
        if (new Set(sections.map((s) => s.join(","))).size !== sections.length) throw new ProtocolError("sections must be unique");
        const margin = v.has("margin") ? v.int("margin") : undefined;
        if (margin !== undefined && margin > 16) throw new ProtocolError("margin must be 0 to 16");
        return { type, id, dimension, kind, sections, ...(margin !== undefined ? { margin } : {}) };
      }
      if (kind === "coarse") {
        if (v.has("sections") || v.has("columns") || v.has("ceiling") || v.has("margin")) throw new ProtocolError("a coarse snapshot takes cell and boxes only");
        const cell = v.int("cell");
        if (!(COARSE_CELLS as readonly number[]).includes(cell)) throw new ProtocolError(`cell must be one of ${COARSE_CELLS.join(", ")}`);
        return { type, id, dimension, kind, cell: cell as 2 | 4, boxes: v.boxes("boxes") };
      }
      if (v.has("margin") || v.has("cell")) throw new ProtocolError("margin and cell belong to mask and coarse snapshots");
      if (kind === "surface") {
        if (v.has("boxes") || v.has("sections")) throw new ProtocolError("a surface snapshot takes columns, not boxes or sections");
        return { type, id, dimension, kind, columns: v.area("columns"), ...(v.has("ceiling") ? { ceiling: v.y("ceiling") } : {}) };
      }
      if (v.has("columns") || v.has("ceiling")) throw new ProtocolError("columns and ceiling belong to a surface snapshot");
      if (v.has("boxes") === v.has("sections")) throw new ProtocolError("snapshot takes exactly one of boxes or sections");
      if (v.has("boxes")) return { type, id, dimension, boxes: v.boxes("boxes") };
      return { type, id, dimension, sections: v.arr("sections").map((_, i) => v.vec3At("sections", i)) };
    }
    case "snapshot.result": {
      const kind = v.has("kind") ? v.oneOf("kind", ["blocks", "surface", "coarse"]) : "blocks";
      const missing = v.has("missing") && kind !== "surface" ? { missing: v.chunks("missing") } : {};
      if (missing.missing && !missing.missing.length) throw new ProtocolError("missing is omitted when empty");
      if (kind === "coarse") {
        const id = v.id("id"), dimension = v.str("dimension"), cell = v.int("cell");
        if (!(COARSE_CELLS as readonly number[]).includes(cell)) throw new ProtocolError(`cell must be one of ${COARSE_CELLS.join(", ")}`);
        const regions = v.boxes("regions", true);
        return { type, id, dimension, kind, cell: cell as 2 | 4, ...decodeCoarseBody(body, regions, cell), ...missing };
      }
      if (kind === "surface") {
        const id = v.id("id"), dimension = v.str("dimension"), columns = v.area("columns"), minY = v.y("minY");
        const ceiling = v.has("ceiling") ? v.y("ceiling") : undefined;
        const missing = v.arr("missing").map((c, i) => {
          if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isSafeInteger)) throw new ProtocolError(`missing[${i}] must be [cx, cz] integers`);
          return [c[0], c[1]] as [number, number];
        });
        return { type, id, dimension, kind, columns, minY, ...(ceiling !== undefined ? { ceiling } : {}), missing, ...decodeSurfaceBody(body, columns, ceiling !== undefined) };
      }
      const regions = v.boxes("regions", true);
      return { type, id: v.id("id"), dimension: v.str("dimension"), ...decodeSnapshotBody(body, regions), ...missing };
    }
    case "search": {
      const id = v.id("id"), dimension = v.str("dimension");
      const stop = v.has("stop") ? { stop: v.positive("stop") } : {};
      if (v.has("continue")) {
        if (v.raw("continue") !== true) throw new ProtocolError("continue is true or omitted");
        if (["materials", "radius", "around", "gap"].some((k) => v.has(k))) throw new ProtocolError("a continuing search takes only stop");
        return { type, id, dimension, continue: true, ...stop };
      }
      return {
        type,
        id,
        dimension,
        materials: v.materials("materials", false),
        ...(v.has("radius") ? { radius: v.int("radius") } : {}),
        ...(v.has("around") ? { around: v.vec3("around") } : {}),
        ...(v.has("gap") ? { gap: v.positive("gap") } : {}),
        ...stop,
      };
    }
    case "search.result": {
      const id = v.id("id"), dimension = v.str("dimension"), materials = v.materials("materials", false);
      const centre = v.pair("centre"), radius = v.int("radius");
      const clipped = v.has("clipped") ? v.raw("clipped") : undefined;
      if (clipped !== undefined && clipped !== true) throw new ProtocolError("clipped is true or omitted");
      const reached = v.int("reached");
      if (reached > radius) throw new ProtocolError(`reached ${reached} is past the radius ${radius}`);
      const minSection = v.y("minSection");
      const clusters: SearchCluster[] = v.arr("clusters").map((_, i) => {
        const c = v.objAt("clusters", i);
        const min = c.pair("min"), max = c.pair("max");
        if (min[0] > max[0] || min[1] > max[1]) throw new ProtocolError(`clusters[${i}]: min must not exceed max`);
        return { min, max, chunks: c.positive("chunks"), blocks: c.int("blocks"), closed: c.bool("closed") };
      });
      const body2 = decodeSearchBody(body, { centre, radius, materials: materials.length, minSection, clusters: clusters.length, chunks: v.int("chunks"), missing: v.int("missing") });
      return { type, id, dimension, materials, centre, radius, ...(clipped ? { clipped: true as const } : {}), reached, minSection, clusters, ...body2 };
    }
    case "fill": {
      const id = v.id("id"), dimension = v.str("dimension"), seed = v.vec3("seed"), match = v.materials("match", true);
      const connectivity = v.has("connectivity") ? v.int("connectivity") : undefined;
      if (connectivity !== undefined && ![6, 18, 26].includes(connectivity)) throw new ProtocolError("connectivity must be 6, 18 or 26");
      return {
        type,
        id,
        dimension,
        seed,
        match,
        ...(connectivity !== undefined ? { connectivity: connectivity as 6 | 18 | 26 } : {}),
        ...(v.has("budget") ? { budget: v.positive("budget") } : {}),
        ...(v.has("area") ? { area: v.int("area") } : {}),
      };
    }
    case "expand": {
      const id = v.id("id"), dimension = v.str("dimension");
      let by: ExpandBy;
      if (v.raw("by") === "frontier") by = "frontier";
      else {
        const b = v.obj("by");
        if (b.has("box")) {
          if (b.has("direction") || b.has("chunks")) throw new ProtocolError("by takes a box, or a direction and chunks");
          by = { box: b.box("box") };
        } else by = { direction: b.oneOf("direction", ["north", "south", "west", "east"]), chunks: b.positive("chunks") };
      }
      return { type, id, dimension, by, ...(v.has("budget") ? { budget: v.positive("budget") } : {}) };
    }
    case "fill.result": {
      const id = v.id("id"), dimension = v.str("dimension"), seed = v.vec3("seed"), count = v.int("count");
      const box = v.nullable("box") ? v.box("box") : null;
      if ((box === null) !== (count === 0)) throw new ProtocolError("box is null exactly when count is 0");
      const stopped = v.oneOf("stopped", FILL_STOPS);
      const delta = v.has("delta") ? v.raw("delta") : undefined;
      if (delta !== undefined && delta !== true) throw new ProtocolError("delta is true or omitted");
      const missing = v.chunks("missing");
      const lists = decodeFillBody(body, v.grid(), { sections: v.int("sections"), frontier: v.int("frontier") });
      return { type, id, dimension, seed, count, box, stopped, ...(delta ? { delta: true as const } : {}), missing, ...lists };
    }
    case "patch": {
      const id = v.id("id"), link = v.int("link"), dimension = v.str("dimension");
      const force = v.has("force") ? v.bool("force") : false;
      const blocks = decodePatchBody(body, v.grid(), v.int("count"));
      return { type, id, link, dimension, ...(force ? { force } : {}), blocks };
    }
    case "patch.ack": {
      const id = v.id("id"), applied = v.int("applied"), overwritten = v.int("overwritten");
      if (overwritten > applied) throw new ProtocolError(`overwritten ${overwritten} exceeds applied ${applied}`);
      const lists = decodeAckBody(body, v.grid(), { skipped: v.int("skipped"), rejected: v.int("rejected"), normalized: v.int("normalized") });
      return { type, id, applied, overwritten, ...lists };
    }
    case "dirty":
      if (v.bool("everything")) {
        if (body.length) throw new ProtocolError("dirty with everything carries no body");
        return { type, everything: true };
      }
      return { type, everything: false, blocks: decodeDirtyBody(body, v.grid(), v.int("count")) };
    case "registry":
      return { type, id: v.id("id"), ...(v.has("have") ? { have: v.hash("have") } : {}) };
    case "registry.result": {
      const id = v.id("id"), hash = v.hash("hash"), dataVersion = v.int("dataVersion");
      if (v.has("unchanged")) {
        if (!v.bool("unchanged")) throw new ProtocolError("unchanged is true or omitted");
        if (body.length) throw new ProtocolError("an unchanged registry.result carries no body");
        return { type, id, hash, dataVersion, unchanged: true };
      }
      if (!body.length) throw new ProtocolError("registry.result needs the report as its body");
      return { type, id, hash, dataVersion, report: body };
    }
    case "upgrade": {
      const id = v.id("id"), from = v.int("from"), kind = v.oneOf("kind", ["elements", "structure"]);
      return { type, id, from, ...decodeUpgradeBody(body, kind) };
    }
    case "upgrade.result": {
      const id = v.id("id"), to = v.int("to"), kind = v.oneOf("kind", ["elements", "structure"]);
      const failed = v.has("failed") ? v.int("failed") : 0;
      return { type, id, to, ...(failed ? { failed } : {}), ...decodeUpgradeBody(body, kind) };
    }
    case "prompt": {
      const c = v.obj("context");
      const facing = c.oneOf("facing", ["north", "south", "west", "east"]);
      const ctx: GameContext = { dimension: c.str("dimension"), position: c.num3("position"), eye: c.num3("eye"), yaw: c.num("yaw"), pitch: c.num("pitch"), facing };
      if (c.has("target")) {
        const t = c.obj("target");
        ctx.target = { pos: t.vec3("pos"), state: t.str("state"), face: t.oneOf("face", ["down", "up", "north", "south", "west", "east"]) };
      }
      if (c.has("focus")) ctx.focus = c.box("focus");
      if (c.has("focusClipped") && c.bool("focusClipped")) ctx.focusClipped = true;
      const mode = v.has("mode") ? { mode: v.oneOf("mode", REQUEST_MODES) } : {};
      return { type, id: v.id("id"), player: playerRef(v.obj("player")), text: v.str("text"), context: ctx, ...mode };
    }
    case "prompt.close":
      return { type, player: playerRef(v.obj("player")) };
    case "prompt.result": {
      const id = v.id("id");
      if (v.bool("delivered")) return { type, id, delivered: true };
      if (v.has("queued")) {
        if (v.raw("queued") !== true) throw new ProtocolError("queued is true or omitted");
        if (v.has("reason")) throw new ProtocolError("a queued prompt has no refusal reason");
        return { type, id, delivered: false, queued: true, request: v.id("request"), position: v.positive("position") };
      }
      return { type, id, delivered: false, reason: v.oneOf("reason", PROMPT_REFUSALS) };
    }
    case "request.control": {
      const action = v.oneOf("action", REQUEST_CONTROL_ACTIONS);
      const position = v.has("position") ? v.positive("position") : undefined;
      if ((action === "queue.cancel") !== (position !== undefined)) throw new ProtocolError("position goes exactly with queue.cancel");
      return { type, player: playerRef(v.obj("player")), action, ...(position !== undefined ? { position } : {}) };
    }
    case "canvas": {
      if (!v.nullable("box")) {
        if (v.has("id") || v.has("dimension")) throw new ProtocolError("a canvas without a box has no id or dimension");
        return { type, box: null };
      }
      const id = v.has("id") ? { id: v.id("id") } : {};
      return { type, ...id, dimension: v.str("dimension"), box: v.box("box") };
    }
    case "canvas.set":
      return { type, id: v.id("id"), dimension: v.str("dimension"), box: v.box("box") };
    case "notice":
      return { type, text: v.str("text"), player: v.nullable("player") ? uuid(v.str("player")) : null };
    case "chat": {
      if (v.raw("kind") === "status") return statusOf(v);
      const out: ChatMessage = {
        type,
        request: v.nullable("request") ? v.id("request") : null,
        player: v.nullable("player") ? uuid(v.str("player")) : null,
        kind: v.oneOf("kind", ["activity", "reply"]),
        lines: v.arr("lines").map((l, i) => {
          if (typeof l !== "string") throw new ProtocolError(`lines[${i}] must be a string`);
          return l;
        }),
      };
      if (v.has("action")) {
        const a = v.obj("action");
        const line = a.int("line"), kind = a.str("kind"), args = a.raw("args");
        if (out.kind !== "reply") throw new ProtocolError("chat: only a reply carries an action");
        if (line < 0 || line >= out.lines.length) throw new ProtocolError(`chat: action.line ${line} names no line`);
        if (!kind) throw new ProtocolError("chat: action.kind must be non-empty");
        if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ProtocolError("chat: action.args must be an object");
        out.action = { line, kind, args: args as Record<string, unknown> };
      }
      return out;
    }
    case "ui.state": {
      const players = v.players(), seq = v.id("seq"), full = v.bool("full");
      const out: UiState = { type, players, seq, full };
      if (full || v.has("jobs")) out.jobs = v.arr("jobs").map((_, i) => uiJobOf(v.objAt("jobs", i)));
      if (v.has("removed")) {
        if (full) throw new ProtocolError("ui.state: a full state removes nothing");
        out.removed = v.strings("removed");
      }
      if (full || v.has("request")) {
        if (v.nullable("request")) {
          const r = v.obj("request");
          out.request = { id: r.id("id"), mode: r.oneOf("mode", REQUEST_MODES), text: r.str("text") };
        } else out.request = null;
      }
      if (full || v.has("tokens")) {
        if (v.nullable("tokens")) {
          const t = v.obj("tokens");
          out.tokens = { input: t.int("input"), output: t.int("output"), cacheRead: t.int("cacheRead"), cacheCreation: t.int("cacheCreation"), ...(t.has("cost") ? { cost: t.num("cost") } : {}) };
        } else out.tokens = null;
      }
      if (full || v.has("refusal")) {
        if (v.nullable("refusal")) {
          const r = v.obj("refusal");
          out.refusal = { code: r.str("code"), text: r.str("text") };
        } else out.refusal = null;
      }
      if (v.has("fills")) out.fills = v.arr("fills").map((_, i) => uiFillOf(v.objAt("fills", i)));
      if (v.has("fillsRemoved")) {
        if (full) throw new ProtocolError("ui.state: a full state removes no fills");
        out.fillsRemoved = v.strings("fillsRemoved");
      }
      return out;
    }
    case "ui.flash": {
      const flashes = v.arr("flashes").map((_, i) => uiFlashOf(v.objAt("flashes", i)));
      if (!flashes.length) throw new ProtocolError("ui.flash: flashes must not be empty");
      return { type, players: v.players(), flashes };
    }
    case "ui.ghost": {
      const players = v.players(), ghost = v.str("ghost"), dimension = v.str("dimension"), origin = v.vec3("origin"), tint = v.colour("tint"), full = v.bool("full");
      const sections = v.arr("sections").map((_, i) => v.vec3At("sections", i));
      for (let i = 1; i < sections.length; i++) {
        const a = sections[i - 1]!, b = sections[i]!;
        const cmp = a[1] - b[1] || a[2] - b[2] || a[0] - b[0];
        if (cmp >= 0) throw new ProtocolError("ui.ghost: sections must be unique and ascending by sy, then sz, then sx");
      }
      const { palette, regions } = decodeStatesBody(body, sections.map(sectionBox), "ui.ghost");
      return { type, players, ghost, dimension, origin, tint, full, palette, sections: sections.map((s, i) => ({ section: s, states: regions[i]!.states })) };
    }
    case "ui.ghost.clear":
      return { type, players: v.players(), ghost: v.str("ghost") };
    case "replay.frame": {
      const players = v.players(), replay = v.str("replay"), step = v.int("step"), steps = v.int("steps"), keyframe = v.bool("keyframe");
      const dimension = v.str("dimension");
      const h = v.obj("hud");
      const hud = { call: h.str("call"), brief: h.nullable("brief") ? h.str("brief") : null, ...(h.has("note") ? { note: h.str("note") } : {}) };
      const tail = { time: v.str("time"), hud, jobs: v.arr("jobs").map((_, i) => uiJobOf(v.objAt("jobs", i))), flashes: v.arr("flashes").map((_, i) => uiFlashOf(v.objAt("flashes", i))) };
      if (keyframe) {
        if (v.has("from") || v.has("origin")) throw new ProtocolError("replay.frame: a keyframe has regions, not from, origin or size");
        const { palette, regions } = decodeStatesBody(body, v.boxes("regions"), "replay.frame");
        const markers = v.arr("markers").map((_, i) => {
          const k = v.objAt("markers", i);
          return { step: k.int("step"), kind: k.oneOf("kind", REPLAY_MARKERS), label: k.str("label") };
        });
        return { type, players, replay, step, steps, keyframe, dimension, palette, regions, ...tail, markers };
      }
      if (v.has("regions") || v.has("markers")) throw new ProtocolError("replay.frame: regions and markers belong to a keyframe");
      const from = v.int("from");
      const blocks = decodeDirtyBody(body, v.grid(), v.int("count"));
      if (blocks.some((b) => b.nbt)) throw new ProtocolError("replay.frame: carries no NBT");
      return { type, players, replay, step, steps, keyframe, from, dimension, blocks: blocks.map((b) => ({ pos: b.pos, state: b.state })), ...tail };
    }
    case "ui.request": {
      const args = v.raw("args");
      if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ProtocolError("args must be an object");
      return { type, request: v.id("request"), player: playerRef(v.obj("player")), kind: v.str("kind"), args: args as Record<string, unknown> };
    }
    case "ui.result": {
      const request = v.id("request"), player = uuid(v.str("player"));
      if (v.bool("ok")) {
        const result = v.raw("result");
        if (typeof result !== "object" || result === null || Array.isArray(result)) throw new ProtocolError("result must be an object");
        return { type, request, player, ok: true, result: result as Record<string, unknown>, ...(body.length ? { body } : {}) };
      }
      if (body.length) throw new ProtocolError("a failed ui.result carries no body");
      return { type, request, player, ok: false, error: v.oneOf("error", UI_ERRORS), message: v.str("message") };
    }
  }
  throw new ProtocolError(`unknown message type "${type}"`);
}

/** `chat` kind `status` (`19`, *Status line*). */
function statusOf(v: Fields): StatusMessage {
  const lines = v.strings("lines");
  if (lines.length !== 1) throw new ProtocolError("chat status: lines must hold exactly one line");
  const state = v.oneOf("state", REQUEST_STATES);
  const queuePos = v.has("queuePos") ? v.positive("queuePos") : undefined;
  if ((state === "queued") !== (queuePos !== undefined)) throw new ProtocolError("chat status: queuePos goes exactly with state queued");
  const noTurnSignal = v.has("noTurnSignal") ? v.raw("noTurnSignal") : undefined;
  if (noTurnSignal !== undefined && (noTurnSignal !== true || state !== "done")) throw new ProtocolError("chat status: noTurnSignal is true, only on done, or omitted");
  if (v.has("action")) throw new ProtocolError("chat status: buttons go in actions, not action");
  const actions = v.arr("actions").map((_, i) => {
    const a = v.objAt("actions", i);
    const label = a.str("label"), kind = a.str("kind"), args = a.raw("args");
    if (!label || !kind) throw new ProtocolError(`actions[${i}]: label and kind must be non-empty`);
    if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ProtocolError(`actions[${i}].args must be an object`);
    return { label, kind, args: args as Record<string, unknown> };
  });
  return {
    type: "chat",
    request: v.id("request"),
    player: uuid(v.str("player")),
    kind: "status",
    lines: [lines[0]!],
    state,
    text: v.str("text"),
    calls: v.int("calls"),
    elapsedMs: v.int("elapsedMs"),
    ...(queuePos !== undefined ? { queuePos } : {}),
    ...(noTurnSignal ? { noTurnSignal: true as const } : {}),
    actions,
  };
}

function uiJobOf(f: Fields): UiJob {
  return { id: f.str("id"), colour: f.colour("colour"), brief: f.str("brief"), dimension: f.str("dimension"), work: f.box("work"), context: f.arr("context").map((_, i) => f.boxAt("context", i)) };
}

function uiFillOf(f: Fields): UiFill {
  const alpha = f.int("alpha");
  if (alpha < 1 || alpha > 255) throw new ProtocolError(`alpha must be an integer from 1 to 255 (got ${alpha})`);
  return uiFill({ id: f.str("id"), colour: f.colour("colour"), alpha, dimension: f.str("dimension"), faces: f.arr("faces") as UiSpan[], edges: f.arr("edges") as UiSpan[] });
}

function uiFlashOf(f: Fields): UiFlash {
  const boxes = f.boxes("boxes");
  return { job: f.str("job"), colour: f.colour("colour"), dimension: f.str("dimension"), boxes };
}

function uuid(s: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)) throw new ProtocolError(`"${s}" is not a lowercase hyphenated UUID`);
  return s;
}

function playerRef(f: Fields): PlayerRef {
  return { name: f.str("name"), uuid: uuid(f.str("uuid")) };
}

function volatile(raw: unknown): VolatileList {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ProtocolError("volatile must be an object");
  const out: VolatileList = {};
  for (const [k, val] of Object.entries(raw)) {
    if (val === "state_only") out[k] = "state_only";
    else if (Array.isArray(val) && val.every((s) => typeof s === "string" && s.length > 0)) out[k] = val as string[];
    else throw new ProtocolError(`volatile["${k}"] must be a list of key paths or "state_only"`);
  }
  return out;
}

/** Typed access to a header object, throwing `ProtocolError` with the field's path. */
class Fields {
  constructor(
    private readonly o: Record<string, unknown>,
    private readonly path = "",
  ) {}

  private name(k: string): string {
    return this.path ? `${this.path}.${k}` : k;
  }

  private fail(k: string, want: string): never {
    throw new ProtocolError(`${this.name(k)} must be ${want} (got ${JSON.stringify(this.o[k]) ?? "nothing"})`);
  }

  has(k: string): boolean {
    return this.o[k] !== undefined;
  }

  raw(k: string): unknown {
    if (!this.has(k)) this.fail(k, "present");
    return this.o[k];
  }

  nullable(k: string): boolean {
    if (!(k in this.o)) this.fail(k, "present (null allowed)");
    return this.o[k] !== null;
  }

  str(k: string): string {
    const v = this.o[k];
    if (typeof v !== "string") this.fail(k, "a string");
    return v;
  }

  bool(k: string): boolean {
    const v = this.o[k];
    if (typeof v !== "boolean") this.fail(k, "true or false");
    return v;
  }

  num(k: string): number {
    const v = this.o[k];
    if (typeof v !== "number" || !Number.isFinite(v)) this.fail(k, "a number");
    return v;
  }

  int(k: string): number {
    const v = this.o[k];
    if (!Number.isSafeInteger(v) || (v as number) < 0) this.fail(k, "a non-negative integer");
    return v as number;
  }

  id(k: string): number {
    const v = this.int(k);
    if (v < 1) this.fail(k, "an integer ≥ 1");
    return v;
  }

  oneOf<T extends string>(k: string, values: readonly T[]): T {
    const v = this.o[k];
    if (!values.includes(v as T)) this.fail(k, `one of ${values.join(", ")}`);
    return v as T;
  }

  oneOfAt<T extends string>(k: string, i: number, values: readonly T[]): T {
    const v = this.arr(k)[i];
    if (!values.includes(v as T)) throw new ProtocolError(`${this.name(k)}[${i}] must be one of ${values.join(", ")} (got ${JSON.stringify(v)})`);
    return v as T;
  }

  strings(k: string): string[] {
    return this.arr(k).map((s, i) => {
      if (typeof s !== "string") throw new ProtocolError(`${this.name(k)}[${i}] must be a string`);
      return s;
    });
  }

  hash(k: string): string {
    const v = this.o[k];
    if (typeof v !== "string" || !/^[0-9a-f]{16}$/.test(v)) this.fail(k, "16 lowercase hex digits");
    return v;
  }

  /** A y coordinate (may be negative). */
  y(k: string): number {
    const v = this.o[k];
    if (!Number.isSafeInteger(v)) this.fail(k, "an integer");
    return v as number;
  }

  area(k: string): WireArea {
    const o = this.o[k] as { min?: unknown; max?: unknown } | null;
    const pair = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every(Number.isSafeInteger);
    if (typeof o !== "object" || o === null || !pair(o.min) || !pair(o.max)) this.fail(k, '{"min": [x, z], "max": [x, z]}');
    const { min, max } = o as WireArea;
    if (min[0] > max[0] || min[1] > max[1]) throw new ProtocolError(`${this.name(k)}: min must not exceed max on either axis`);
    return { min: [min[0], min[1]], max: [max[0], max[1]] };
  }

  /** An integer ≥ 1. */
  positive(k: string): number {
    const v = this.int(k);
    if (v < 1) this.fail(k, "an integer ≥ 1");
    return v;
  }

  /** A pair of integers, `[cx, cz]`. */
  pair(k: string): [number, number] {
    const v = this.o[k];
    if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isSafeInteger)) this.fail(k, "[a, b] integers");
    return [v[0], v[1]];
  }

  /** Chunks `[cx, cz]`, unique and ascending by cz, then cx. */
  chunks(k: string): [number, number][] {
    const list = this.arr(k).map((c, i) => {
      if (!Array.isArray(c) || c.length !== 2 || !c.every(Number.isSafeInteger)) throw new ProtocolError(`${this.name(k)}[${i}] must be [cx, cz] integers`);
      return [c[0], c[1]] as [number, number];
    });
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!, b = list[i]!;
      if ((a[1] - b[1] || a[0] - b[0]) >= 0) throw new ProtocolError(`${this.name(k)} must be unique and ascending by cz, then cx`);
    }
    return list;
  }

  /** A non-empty material list (`18`): block ids, canonical states, tags `#ns:path`, and with `solid` allowed, `solid`. */
  materials(k: string, solid: boolean): string[] {
    const list = this.strings(k);
    if (!list.length) this.fail(k, "a non-empty list of materials");
    for (const m of list) if (!(solid && m === MATCH_SOLID) && !MATERIAL.test(m)) throw new ProtocolError(`${this.name(k)}: "${m}" is not a block id, a state or a #tag${solid ? ` (or "${MATCH_SOLID}")` : ""}`);
    if (new Set(list).size !== list.length) throw new ProtocolError(`${this.name(k)} must be unique`);
    return list;
  }

  /** A `players` list: non-empty, lowercase hyphenated UUIDs (*In-game UI*). */
  players(): string[] {
    const list = this.strings("players");
    if (!list.length) this.fail("players", "a non-empty list of UUIDs");
    return list.map(uuid);
  }

  colour(k: string): string {
    const v = this.o[k];
    if (typeof v !== "string" || !/^#[0-9a-f]{6}$/.test(v)) this.fail(k, '"#rrggbb", lowercase');
    return v;
  }

  objAt(k: string, i: number): Fields {
    const v = this.arr(k)[i];
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ProtocolError(`${this.name(k)}[${i}] must be an object`);
    return new Fields(v as Record<string, unknown>, `${this.name(k)}[${i}]`);
  }

  obj(k: string): Fields {
    const v = this.o[k];
    if (typeof v !== "object" || v === null || Array.isArray(v)) this.fail(k, "an object");
    return new Fields(v as Record<string, unknown>, this.name(k));
  }

  arr(k: string): unknown[] {
    const v = this.o[k];
    if (!Array.isArray(v)) this.fail(k, "an array");
    return v;
  }

  vec3(k: string): Vec3 {
    const v = this.o[k];
    if (!isVec3(v)) this.fail(k, "[x, y, z] integers");
    return [v[0], v[1], v[2]];
  }

  num3(k: string): [number, number, number] {
    const v = this.o[k];
    if (!Array.isArray(v) || v.length !== 3 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) this.fail(k, "[x, y, z] numbers");
    return [v[0], v[1], v[2]];
  }

  vec3At(k: string, i: number): Vec3 {
    const v = this.arr(k)[i];
    if (!isVec3(v)) throw new ProtocolError(`${this.name(k)}[${i}] must be [x, y, z] integers`);
    return [v[0], v[1], v[2]];
  }

  box(k: string): WireBox {
    return toBox(this.o[k], this.name(k));
  }

  boxAt(k: string, i: number): WireBox {
    return toBox(this.arr(k)[i], `${this.name(k)}[${i}]`);
  }

  boxes(k: string, allowEmpty = false): WireBox[] {
    const a = this.arr(k);
    if (!allowEmpty && a.length === 0) this.fail(k, "a non-empty array of boxes");
    return a.map((_, i) => this.boxAt(k, i));
  }

  grid(): Grid {
    const origin = this.vec3("origin");
    const v = this.o.size;
    if (!isVec3(v) || v.some((n) => n < 0)) this.fail("size", "[sx, sy, sz] non-negative integers");
    return { origin, size: [v[0], v[1], v[2]] };
  }
}

/** A block id or canonical state (`ns:path`, `ns:path[k=v,…]`), or a tag `#ns:path`. */
const MATERIAL = /^(#[a-z0-9_.-]+:[a-z0-9_./-]+|[a-z0-9_.-]+:[a-z0-9_./-]+(\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\])?)$/;

function isVec3(v: unknown): v is Vec3 {
  return Array.isArray(v) && v.length === 3 && v.every((n) => Number.isSafeInteger(n));
}

function toBox(v: unknown, name: string): WireBox {
  const o = v as { min?: unknown; max?: unknown } | null;
  if (typeof o !== "object" || o === null || !isVec3(o.min) || !isVec3(o.max)) throw new ProtocolError(`${name} must be {"min": [x, y, z], "max": [x, y, z]}`);
  const min = o.min, max = o.max;
  if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) throw new ProtocolError(`${name}: min must not exceed max on any axis`);
  return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
}
