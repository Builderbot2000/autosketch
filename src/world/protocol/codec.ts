import type { Vec3 } from "../../core/region.js";
import {
  decodeAckBody,
  decodeDirtyBody,
  decodePatchBody,
  decodeSnapshotBody,
  decodeSurfaceBody,
  decodeUpgradeBody,
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
  ERROR_CODES,
  MAX_FRAME,
  MAX_HEADER,
  PROMPT_REFUSALS,
  REPLAY_MARKERS,
  REQUEST_MODES,
  UI_ERRORS,
  UI_MCP_TYPES,
  type ChatMessage,
  type UiFlash,
  type UiJob,
  type UiState,
  type GameContext,
  type Message,
  type McpMessage,
  type ModMessage,
  type PlayerRef,
  type Sender,
  type ScanGrant,
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
      if ("kind" in m) return { header: { type: m.type, id: m.id, dimension: m.dimension, kind: m.kind, columns: area(m.columns), ...(m.ceiling !== undefined ? { ceiling: m.ceiling } : {}) }, body: none };
      if ("boxes" in m) return { header: { type: m.type, id: m.id, dimension: m.dimension, boxes: m.boxes.map(box) }, body: none };
      return { header: { type: m.type, id: m.id, dimension: m.dimension, sections: m.sections.map((s) => [s[0], s[1], s[2]]) }, body: none };
    case "snapshot.result":
      if ("kind" in m) {
        if ((m.ceiling === undefined) !== (m.ceilings === undefined)) throw new ProtocolError("surface result: ceilings must be given exactly when ceiling is");
        return {
          header: { type: m.type, id: m.id, dimension: m.dimension, kind: m.kind, columns: area(m.columns), minY: m.minY, ...(m.ceiling !== undefined ? { ceiling: m.ceiling } : {}), missing: m.missing.map((c) => [c[0], c[1]]) },
          body: encodeSurfaceBody(m),
        };
      }
      return { header: { type: m.type, id: m.id, dimension: m.dimension, regions: m.regions.map((r) => box(r.box)) }, body: encodeSnapshotBody(m.palette, m.regions) };
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
        header: { type: m.type, id: m.id, player: player(m.player), text: m.text, context: context(m.context), ...(m.mode ? { mode: m.mode } : {}), ...(m.scan ? { scan: scanGrant(m.scan) } : {}) },
        body: none,
      };
    case "prompt.close":
      return { header: { type: m.type, player: player(m.player) }, body: none };
    case "prompt.result":
      return { header: m.delivered ? { type: m.type, id: m.id, delivered: true } : { type: m.type, id: m.id, delivered: false, reason: m.reason }, body: none };
    case "notice":
      return { header: { type: m.type, text: m.text, player: m.player }, body: none };
    case "chat":
      if (m.action && (m.kind !== "reply" || !Number.isInteger(m.action.line) || m.action.line < 0 || m.action.line >= m.lines.length)) throw new ProtocolError("chat: an action names one line of a reply");
      return {
        header: { type: m.type, request: m.request, player: m.player, kind: m.kind, lines: [...m.lines], ...(m.action ? { action: { line: m.action.line, kind: m.action.kind, args: m.action.args } } : {}) },
        body: none,
      };
    case "ui.state": {
      const changed = <T>(k: string, v: T | null | undefined) => (m.full || v !== undefined ? { [k]: v ?? null } : {});
      if (m.full && m.removed?.length) throw new ProtocolError("ui.state: a full state removes nothing");
      if (m.full && m.jobs === undefined) throw new ProtocolError("ui.state: a full state lists its jobs");
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

function uiJob(j: UiJob): UiJob {
  return { id: j.id, colour: j.colour, brief: j.brief, dimension: j.dimension, work: box(j.work), context: j.context.map(box) };
}

function uiFlash(f: UiFlash): UiFlash {
  if (!f.boxes.length) throw new ProtocolError(`ui flash for ${f.job}: no boxes`);
  return { job: f.job, colour: f.colour, dimension: f.dimension, boxes: f.boxes.map(box) };
}

function player(p: PlayerRef): PlayerRef {
  return { name: p.name, uuid: p.uuid };
}

function scanGrant(g: ScanGrant): ScanGrant {
  return { radius: g.radius, ...(g.clipped ? { clipped: true } : {}), columns: area(g.columns), box: box(g.box) };
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

const MCP_TYPES = new Set(["hello", "error", "volumes.extend", "volumes.set", "hashes", "snapshot", "patch", "registry", "upgrade", "prompt.result", "notice", "chat", ...UI_MCP_TYPES]);
const MOD_TYPES = new Set(["hello", "error", "volumes", "hashes.result", "snapshot.result", "patch.ack", "dirty", "prompt", "prompt.close", "registry.result", "upgrade.result", "ui.request"]);
const BODY_TYPES = new Set(["snapshot.result", "patch", "patch.ack", "dirty", "registry.result", "upgrade", "upgrade.result", "ui.ghost", "replay.frame", "ui.result"]);

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
      const kind = v.has("kind") ? v.oneOf("kind", ["blocks", "surface"]) : "blocks";
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
      const kind = v.has("kind") ? v.oneOf("kind", ["blocks", "surface"]) : "blocks";
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
      return { type, id: v.id("id"), dimension: v.str("dimension"), ...decodeSnapshotBody(body, regions) };
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
      let scan: { scan?: ScanGrant } = {};
      if (v.has("scan")) {
        if (mode.mode !== "scan") throw new ProtocolError("scan is sent only with mode scan");
        const g = v.obj("scan");
        scan = { scan: { radius: g.int("radius"), ...(g.has("clipped") && g.bool("clipped") ? { clipped: true } : {}), columns: g.area("columns"), box: g.box("box") } };
      }
      return { type, id: v.id("id"), player: playerRef(v.obj("player")), text: v.str("text"), context: ctx, ...mode, ...scan };
    }
    case "prompt.close":
      return { type, player: playerRef(v.obj("player")) };
    case "prompt.result": {
      const id = v.id("id");
      if (v.bool("delivered")) return { type, id, delivered: true };
      return { type, id, delivered: false, reason: v.oneOf("reason", PROMPT_REFUSALS) };
    }
    case "notice":
      return { type, text: v.str("text"), player: v.nullable("player") ? uuid(v.str("player")) : null };
    case "chat": {
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

function uiJobOf(f: Fields): UiJob {
  return { id: f.str("id"), colour: f.colour("colour"), brief: f.str("brief"), dimension: f.str("dimension"), work: f.box("work"), context: f.arr("context").map((_, i) => f.boxAt("context", i)) };
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
