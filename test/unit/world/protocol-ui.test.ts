import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bridge } from "../../../src/world/bridge.js";
import { decodePreviewBody, encodePreviewBody } from "../../../src/world/protocol/body.js";
import { decodeFrame, decodeMessage, encodeMessage, ProtocolError } from "../../../src/world/protocol/codec.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import { CANDIDATE_FILL, CHOICES_MAX, LIBRARY_WRITE_KINDS, SAVE_FLASH_COLOUR, UI_FILL_SPANS, SAVE_FLASH_JOB, UI_ERRORS, UI_PART_BYTES, UI_REQUEST_KINDS, uiEnabled, type McpFeature, type Message, type UiGhost, type UiRequest } from "../../../src/world/protocol/messages.js";
import { FakeHost } from "../../support/fake-host.js";

/** The in-game UI messages (docs/design/13-live-world.md, *In-game UI*; feature `ui`). */

const DIR = join(import.meta.dirname, "../../data/world-protocol");
const KEV = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Re-encodes a header with one change and decodes it, as `sender` sent it. */
function tweak(vector: string, sender: "mcp" | "mod", edit: (h: Record<string, any>) => void, body?: Uint8Array): Message {
  const bin = new Uint8Array(readFileSync(join(DIR, `${vector}.bin`)));
  const hlen = new DataView(bin.buffer, bin.byteOffset).getUint32(4);
  const header = JSON.parse(Buffer.from(bin.subarray(8, 8 + hlen)).toString("utf8"));
  edit(header);
  const h = Buffer.from(JSON.stringify(header));
  const b = body ?? bin.subarray(8 + hlen);
  const payload = new Uint8Array(4 + h.length + b.length);
  new DataView(payload.buffer).setUint32(0, h.length);
  payload.set(h, 4);
  payload.set(b, 4 + h.length);
  return decodeMessage(payload, sender);
}

describe("ui codec", () => {
  it("relay-parts: rebuilds the large ghost frame from its rule and splits it into the listed parts", () => {
    const side = JSON.parse(readFileSync(join(DIR, "relay-parts.json"), "utf8"));
    const pal = ["minecraft:air", "minecraft:stone", "minecraft:glass"];
    const sections: UiGhost["sections"] = [];
    let k = 0;
    for (let sy = 0; sy < 2; sy++)
      for (let sz = 0; sz < 10; sz++)
        for (let sx = 0; sx < 13; sx++) {
          const kk = k++;
          sections.push({ section: [sx, sy, sz], states: Uint32Array.from({ length: 4096 }, (_, i) => (i + kk) % 3) });
        }
    const h = side.header;
    const frame = encodeMessage({ type: "ui.ghost", players: h.players, ghost: h.ghost, dimension: h.dimension, origin: h.origin, tint: h.tint, full: h.full, palette: pal, sections });
    expect(frame.length).toBe(side.frame.bytes);
    expect(sha(frame)).toBe(side.frame.sha256);
    expect(side.partBytes).toBe(UI_PART_BYTES);
    const parts = [];
    for (let p = 0; p < frame.length; p += UI_PART_BYTES) parts.push(frame.subarray(p, p + UI_PART_BYTES));
    expect(parts.map((p) => ({ bytes: p.length, sha256: sha(p) }))).toEqual(side.parts);
    expect(parts.length).toBeGreaterThan(1);
    const decoded = decodeFrame(frame, "mcp") as UiGhost;
    expect(decoded.sections.length).toBe(260);
    expect(decoded.sections[259]!.states[5]).toBe((5 + 259) % 3);
  });

  it("ui messages carry no id, so neither side's request matching sees them", () => {
    for (const v of ["ui-state-full", "ui-request-resync", "ui-result-conflict", "replay-frame-delta", "ui-ghost-full"]) {
      const bin = new Uint8Array(readFileSync(join(DIR, `${v}.bin`)));
      const m = decodeFrame(bin, v.startsWith("ui-request") ? "mod" : "mcp");
      expect("id" in m).toBe(false);
    }
  });

  it("refuses malformed ui headers", () => {
    const bad = (vector: string, sender: "mcp" | "mod", edit: (h: Record<string, any>) => void) => expect(() => tweak(vector, sender, edit)).toThrow(ProtocolError);
    bad("ui-state-full", "mcp", (h) => (h.players = []));
    bad("ui-state-full", "mcp", (h) => (h.players = ["Kev"]));
    bad("ui-state-full", "mcp", (h) => delete h.request); // a full state gives every field
    bad("ui-state-full", "mcp", (h) => (h.removed = ["j1"])); // a full state removes nothing
    bad("ui-state-full", "mcp", (h) => (h.jobs[0].colour = "#ABCDEF"));
    bad("ui-state-full", "mcp", (h) => (h.seq = 0));
    bad("ui-flash", "mcp", (h) => (h.flashes = []));
    bad("ui-flash", "mcp", (h) => (h.flashes[0].boxes = []));
    bad("ui-ghost-full", "mcp", (h) => h.sections.reverse()); // must be ascending
    bad("ui-ghost-full", "mcp", (h) => h.sections.pop()); // body holds two sections
    bad("replay-frame-delta", "mcp", (h) => (h.regions = [])); // regions belong to a keyframe
    bad("replay-frame-keyframe", "mcp", (h) => (h.markers[0].kind = "branch"));
    bad("ui-request-resync", "mod", (h) => {
      delete h.request; // numbered by request, never by id
      h.id = 1;
    });
    bad("ui-request-resync", "mod", (h) => (h.args = []));
    bad("ui-result-conflict", "mcp", (h) => (h.error = "stale"));
    bad("ui-result-settings-list", "mcp", (h) => (h.result = null));
  });

  it("chat: a reply may make one line clickable; anything else about the action is refused", () => {
    const m = decodeFrame(new Uint8Array(readFileSync(join(DIR, "chat-reply-action.bin"))), "mcp");
    expect(m).toMatchObject({ type: "chat", kind: "reply", action: { line: 1, kind: "candidates.open", args: { id: "c1" } } });
    expect("action" in decodeFrame(new Uint8Array(readFileSync(join(DIR, "chat-reply.bin"))), "mcp")).toBe(false);
    const bad = (edit: (h: Record<string, any>) => void) => expect(() => tweak("chat-reply-action", "mcp", edit)).toThrow(ProtocolError);
    bad((h) => (h.kind = "activity")); // only a reply carries one
    bad((h) => (h.action.line = 2)); // past the last line
    bad((h) => (h.action.line = -1));
    bad((h) => (h.action.kind = ""));
    bad((h) => (h.action.args = []));
    bad((h) => delete h.action.args);
    expect(() => encodeMessage({ type: "chat", request: 1, player: KEV, kind: "activity", lines: ["x"], action: { line: 0, kind: "candidates.open", args: {} } })).toThrow(ProtocolError);
  });

  it("candidates: the new error code answered decodes; unknown codes still don't", () => {
    expect(decodeFrame(new Uint8Array(readFileSync(join(DIR, "ui-result-answered.bin"))), "mcp")).toMatchObject({ ok: false, error: "answered" });
    expect(() => tweak("ui-result-answered", "mcp", (h) => (h.error = "already_answered"))).toThrow(ProtocolError);
  });

  it("library editors (17, piece 6): one write kind per entry kind, each with the hash it started from; a stale one is conflict", () => {
    for (const k of LIBRARY_WRITE_KINDS) expect(UI_REQUEST_KINDS).toContain(k);
    const req = (n: string) => decodeFrame(new Uint8Array(readFileSync(join(DIR, `${n}.bin`))), "mod") as UiRequest;
    expect(req("ui-request-library-write-prefab")).toMatchObject({ kind: "library.write.prefab", args: { root: "user", name: "gothic_tower_a", meta: { front: "south", anchors: { base: [3, 0, 3] } } } });
    expect(req("ui-request-library-write-prefab-new").args).toEqual({ root: "user", name: "gate_small", hash: "absent", meta: { name: "Small gate", front: null } });
    expect(req("ui-request-library-write-palette").args).toMatchObject({ notes: "", edit: { drop: ["glass"], rename: { roof: "roofing" } }, addBlocks: { accent: ["minecraft:mossy_stone_bricks"] } });
    for (const n of ["prefab", "palette", "procedure", "knowledge"]) expect(typeof req(`ui-request-library-write-${n}`).args.hash).toBe("string");
    expect(decodeFrame(new Uint8Array(readFileSync(join(DIR, "ui-result-library-write.bin"))), "mcp")).toMatchObject({ ok: true, result: { hash: expect.stringMatching(/^[0-9a-f]{64}$/) } });
    expect(decodeFrame(new Uint8Array(readFileSync(join(DIR, "ui-result-library-write-conflict.bin"))), "mcp")).toMatchObject({ ok: false, error: "conflict" });
    // `conflict` was already a code (settings): the editors add no new one. `refused` came later with request control (`19`).
    expect(UI_ERRORS).toEqual(["not_allowed", "conflict", "not_found", "bad_request", "busy", "internal", "answered", "refused"]);
  });

  it("save flash (17, piece 8): a flash record with the reserved job save in the fixed colour, beside a job's", () => {
    const m = decodeFrame(new Uint8Array(readFileSync(join(DIR, "ui-flash-save.bin"))), "mcp");
    expect(m).toMatchObject({ type: "ui.flash", flashes: [{ job: SAVE_FLASH_JOB, colour: SAVE_FLASH_COLOUR }, { job: "base" }] });
    expect(SAVE_FLASH_COLOUR).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("choices (18, piece 7): one reply per choice line, clicked as choices.pick {id, index}; answered after a choice was taken", () => {
    expect(UI_REQUEST_KINDS).toContain("choices.pick");
    expect(CHOICES_MAX).toBe(9);
    const read = (n: string, sender: "mcp" | "mod") => decodeFrame(new Uint8Array(readFileSync(join(DIR, `${n}.bin`))), sender);
    expect(read("chat-reply-choice", "mcp")).toMatchObject({ kind: "reply", lines: [expect.any(String)], action: { line: 0, kind: "choices.pick", args: { id: "q1", index: 0 } } });
    expect(read("ui-request-choices-pick", "mod")).toMatchObject({ kind: "choices.pick", args: { id: "q1", index: 1 } });
    expect(read("ui-result-choices-pick", "mcp")).toMatchObject({ ok: true, result: { request: 21 } });
    expect(read("ui-result-choices-answered", "mcp")).toMatchObject({ ok: false, error: "answered" });
  });

  it("steady fill (18, piece 8): faces flat on one axis, edges along one, alpha 1-255; full states list fills, changes add and remove them by id", () => {
    const read = (n: string) => decodeFrame(new Uint8Array(readFileSync(join(DIR, `${n}.bin`))), "mcp");
    const change = read("ui-state-fill") as Extract<Message, { type: "ui.state" }>;
    expect(change.fills).toHaveLength(1);
    expect(change.fills![0]).toMatchObject({ id: CANDIDATE_FILL, alpha: 64 });
    expect(change.fills![0]!.faces).toHaveLength(6);
    expect(change.fills![0]!.edges).toHaveLength(12);
    expect("jobs" in change).toBe(false);
    expect(read("ui-state-full-fill")).toMatchObject({ full: true, jobs: [], request: { mode: "select" }, fills: [{ id: "candidate" }] });
    expect(read("ui-state-fill-removed")).toMatchObject({ full: false, fillsRemoved: ["candidate"], request: null });
    // A full state with no fills omits the key (so ui-state-full is unchanged), and decodes without it.
    expect("fills" in read("ui-state-full")).toBe(false);
    expect(read("ui-flash-hits")).toMatchObject({ flashes: [{ job: CANDIDATE_FILL }] });

    const bad = (edit: (h: Record<string, any>) => void, vector = "ui-state-fill") => expect(() => tweak(vector, "mcp", edit)).toThrow(ProtocolError);
    bad((h) => (h.fills[0].alpha = 0));
    bad((h) => (h.fills[0].alpha = 256));
    bad((h) => (h.fills[0].alpha = 0.5));
    bad((h) => (h.fills[0].colour = "pink"));
    bad((h) => (h.fills[0].faces[0] = [128, 64, -240, 129, 80, -208])); // flat on no axis
    bad((h) => (h.fills[0].faces[0] = [128, 64, -240, 128, 64, -208])); // flat on two: an edge
    bad((h) => (h.fills[0].edges[0] = [140, 64, -230, 152, 65, -230])); // a face
    bad((h) => (h.fills[0].edges[0] = [152, 64, -230, 140, 64, -230])); // min above max
    bad((h) => (h.fills[0].edges[0] = [140, 64, -230, 152, 64]));
    bad((h) => delete h.fills[0].edges);
    bad((h) => (h.fillsRemoved = ["candidate"]), "ui-state-full-fill"); // a full state removes nothing
    const many = Array.from({ length: UI_FILL_SPANS + 1 }, (_, i): [number, number, number, number, number, number] => [i, 0, 0, i, 1, 1]);
    expect(() => encodeMessage({ type: "ui.state", players: [KEV], seq: 1, full: false, fills: [{ id: "candidate", colour: "#e84de0", alpha: 64, dimension: "minecraft:overworld", faces: many, edges: [] }] })).toThrow(ProtocolError);
  });

  it("a failed ui.result carries no body; an ok one may", () => {
    expect(() => tweak("ui-result-conflict", "mcp", () => {}, new Uint8Array([1]))).toThrow(ProtocolError);
    const ok = tweak("ui-result-settings-list", "mcp", () => {}, new Uint8Array([1, 2]));
    expect(ok).toMatchObject({ ok: true, body: new Uint8Array([1, 2]) });
  });

  it("a ui.state change omits what didn't change, and null clears", () => {
    const m = decodeFrame(new Uint8Array(readFileSync(join(DIR, "ui-state-changes.bin"))), "mcp");
    expect(m).toMatchObject({ full: false, removed: ["j2"], request: null });
    expect("tokens" in m).toBe(false);
    const only = encodeMessage({ type: "ui.state", players: [KEV], seq: 3, full: false, tokens: null });
    expect(JSON.parse(Buffer.from(only.subarray(8)).toString("utf8"))).toEqual({ type: "ui.state", players: [KEV], seq: 3, full: false, tokens: null });
  });

  it("preview bodies round-trip, palette in first-use order", () => {
    const body = encodePreviewBody(["a:x", "a:y", "a:z"], [2, 1, 1], Uint32Array.from([2, 0]));
    expect(decodePreviewBody(body, [2, 1, 1])).toEqual({ palette: ["a:z", "a:x"], states: Uint32Array.from([0, 1]) });
  });

  it("uiEnabled needs both hellos to list ui", () => {
    const mod = (features: string[]) => ({ type: "hello" as const, protocol: 3, mod: { version: "1" }, game: { version: "1.21.1", dataVersion: 3955, loader: "neoforge", loaderVersion: "21.1.249" }, singleplayer: true, host: null, features });
    expect(uiEnabled({ features: ["ui"] }, mod(["ui"]))).toBe(true);
    expect(uiEnabled({ features: ["prompt.close"] }, mod(["ui"]))).toBe(false);
    expect(uiEnabled({ features: ["ui"] }, mod(["modes"]))).toBe(false);
    expect(uiEnabled({}, undefined)).toBe(false);
  });
});

describe("ui through the bridge and the fake host", () => {
  const open: { close(): unknown }[] = [];
  afterEach(async () => {
    for (const o of open.splice(0)) await o.close();
  });
  const ALEX = { name: "Alex", uuid: "7c9e6679-7425-40de-944b-e07fc1f90ae7" };
  const state = { type: "ui.state" as const, players: [KEV], seq: 1, full: true, jobs: [], request: null, tokens: null, refusal: null };

  async function pair(hostFeatures: string[] | undefined, mcpFeatures: McpFeature[] | undefined) {
    const host = await FakeHost.start(hostFeatures ? { features: hostFeatures } : {});
    open.push(host);
    const bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE, reconnect: false, ...(mcpFeatures ? { features: mcpFeatures } : {}) });
    open.push(bridge);
    await bridge.connect();
    return { host, bridge };
  }

  it("sends ui messages only when both hellos list ui", async () => {
    const both = await pair(undefined, ["prompt.close", "ui"]);
    expect(both.bridge.ui).toBe(true);
    both.bridge.send(state);
    await both.host.waitFor(() => both.host.ui.length === 1);
    expect(both.host.uiFor(KEV)).toEqual([state]);
    expect(both.host.uiFor(ALEX.uuid)).toEqual([]);

    const mcpOld = await pair(undefined, undefined); // the default hello leaves ui out until M answers requests
    expect(mcpOld.host.mcpFeatures).toEqual(expect.arrayContaining(["prompt.close", "requests"]));
    expect(mcpOld.host.mcpFeatures).not.toContain("ui");
    expect(mcpOld.bridge.ui).toBe(false);
    const modOld = await pair(["modes", "volumes.set", "registry", "upgrade"], ["prompt.close", "ui"]);
    expect(modOld.bridge.ui).toBe(false);
    for (const { bridge, host } of [mcpOld, modOld]) {
      bridge.send(state);
      bridge.send({ type: "notice", text: "after", player: null });
      await host.waitFor(() => host.notices.length === 1);
      expect(host.ui).toEqual([]);
      expect(host.uiUngated).toEqual([]);
      expect(await host.playerUiRequest(ALEX, { kind: "resync" })).toEqual({ local: "mcp_outdated" });
    }
  });

  it("playerUiRequest sends a ui.request numbered by request and resolves with its ui.result", async () => {
    const { host, bridge } = await pair(undefined, ["prompt.close", "ui"]);
    const seen: UiRequest[] = [];
    bridge.on("ui.request", (r) => {
      seen.push(r);
      bridge.send({ type: "ui.result", request: r.request, player: r.player.uuid, ok: true, result: { echoed: r.kind } });
    });
    const a = await host.playerUiRequest(ALEX, { kind: "logs.list" });
    const b = await host.playerUiRequest(ALEX, { kind: "replay.seek", args: { replay: "r1", step: 4 } });
    expect(seen.map((r) => [r.request, r.kind, r.player.uuid])).toEqual([
      [1, "logs.list", ALEX.uuid],
      [2, "replay.seek", ALEX.uuid],
    ]);
    expect(a).toEqual({ type: "ui.result", request: 1, player: ALEX.uuid, ok: true, result: { echoed: "logs.list" } });
    expect(b).toMatchObject({ request: 2, ok: true });
    host.dropConnection();
    expect(await host.playerUiRequest(ALEX, { kind: "resync" })).toEqual({ local: "no_link" });
  });
});
