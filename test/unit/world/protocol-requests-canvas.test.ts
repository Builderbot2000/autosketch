import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Bridge, type BridgeError } from "../../../src/world/bridge.js";
import { decodeFrame, decodeMessage, encodeMessage, ProtocolError } from "../../../src/world/protocol/codec.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import {
  bothHave,
  MCP_FEATURES,
  MCP_WIRE_FEATURES,
  MOD_FEATURES,
  PROMPT_REFUSALS,
  REQUEST_MODES,
  REQUEST_UI_KINDS,
  UI_ERRORS,
  UI_REQUEST_KINDS,
  type CanvasMessage,
  type McpFeature,
  type Message,
  type PlayerRef,
  type RequestControl,
  type StatusMessage,
} from "../../../src/world/protocol/messages.js";
import { FakeHost } from "../../support/fake-host.js";

/** Request control and canvas on the wire (docs/design/19-canvas-and-requests.md; `13`, *Request control and canvas*). */

const DIR = join(import.meta.dirname, "../../data/world-protocol");
const OW = "minecraft:overworld";
const KEV: PlayerRef = { name: "Kev", uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
const BRICK = "minecraft:stone_bricks";

const vector = (name: string) => new Uint8Array(readFileSync(join(DIR, `${name}.bin`)));
const headerOf = (name: string): Record<string, any> => JSON.parse(readFileSync(join(DIR, `${name}.json`), "utf8")).header;

/** Decodes a header (no body) as `sender` sent it. */
function decodeHeader(header: object, sender: "mcp" | "mod"): Message {
  const h = Buffer.from(JSON.stringify(header));
  const payload = new Uint8Array(4 + h.length);
  new DataView(payload.buffer).setUint32(0, h.length);
  payload.set(h, 4);
  return decodeMessage(payload, sender);
}

const edited = (name: string, edit: (h: Record<string, any>) => void) => {
  const h = structuredClone(headerOf(name));
  edit(h);
  return h;
};

describe("requests and canvas: codec", () => {
  it("names the features, kinds, refusal and error the wire adds", () => {
    expect(MOD_FEATURES).toContain("requests");
    expect(MOD_FEATURES).toContain("canvas");
    expect(MCP_WIRE_FEATURES).toEqual([...MCP_FEATURES, "requests", "canvas"]);
    // This MCP lists them only once their behaviour is built (Q1, F1).
    expect(MCP_FEATURES as readonly string[]).not.toContain("requests");
    expect(MCP_FEATURES as readonly string[]).not.toContain("canvas");
    for (const k of REQUEST_UI_KINDS) expect(UI_REQUEST_KINDS).toContain(k);
    expect(PROMPT_REFUSALS).toContain("busy");
    expect(UI_ERRORS).toContain("refused");
  });

  it("decodes a status line with its measurements and buttons", () => {
    const m = decodeFrame(vector("chat-status-working"), "mcp") as StatusMessage;
    expect(m).toEqual({
      type: "chat",
      request: 14,
      player: KEV.uuid,
      kind: "status",
      lines: ['⏳ Working · "build a gatehouse on the east wall" · 14 calls · 0:42'],
      state: "working",
      text: "build a gatehouse on the east wall",
      calls: 14,
      elapsedMs: 42_310,
      actions: [{ label: "Stop", kind: "request.stop", args: { request: 14 } }],
    });
    expect(decodeFrame(vector("chat-status-queued"), "mcp")).toMatchObject({ state: "queued", queuePos: 1, actions: [{ kind: "queue.send" }, { kind: "queue.cancel" }] });
    expect(decodeFrame(vector("chat-status-done-no-turn-signal"), "mcp")).toMatchObject({ state: "done", noTurnSignal: true });
  });

  it("refuses malformed status lines", () => {
    const bad: [string, (h: Record<string, any>) => void, RegExp][] = [
      ["chat-status-working", (h) => (h.lines = ["one", "two"]), /exactly one line/],
      ["chat-status-working", (h) => (h.state = "running"), /state must be one of/],
      ["chat-status-working", (h) => (h.request = null), /request must be/],
      ["chat-status-working", (h) => (h.player = null), /player must be a string/],
      ["chat-status-working", (h) => (h.queuePos = 1), /queuePos goes exactly with state queued/],
      ["chat-status-queued", (h) => delete h.queuePos, /queuePos goes exactly with state queued/],
      ["chat-status-working", (h) => (h.noTurnSignal = true), /noTurnSignal/],
      ["chat-status-working", (h) => (h.action = { line: 0, kind: "request.stop", args: {} }), /buttons go in actions/],
      ["chat-status-working", (h) => (h.actions = [{ label: "", kind: "request.stop", args: {} }]), /label and kind must be non-empty/],
      ["chat-status-working", (h) => (h.actions = [{ label: "Stop", kind: "request.stop", args: [] }]), /args must be an object/],
      ["chat-status-working", (h) => delete h.calls, /calls must be/],
    ];
    for (const [name, edit, msg] of bad) expect(() => decodeHeader(edited(name, edit), "mcp"), msg.source).toThrow(msg);
    // An unknown chat kind stays a bad request.
    expect(() => decodeHeader(edited("chat-status-working", (h) => (h.kind = "progress")), "mcp")).toThrow(/kind must be one of activity, reply/);
  });

  it("encodes only well-formed status lines", () => {
    const m = decodeFrame(vector("chat-status-working"), "mcp") as StatusMessage;
    expect(() => encodeMessage({ ...m, lines: ["a", "b"] as unknown as [string] })).toThrow(ProtocolError);
    expect(() => encodeMessage({ ...m, queuePos: 2 })).toThrow(/queuePos/);
    expect(() => encodeMessage({ ...m, noTurnSignal: true })).toThrow(/noTurnSignal/);
  });

  it("decodes a queued prompt.result and the busy refusal", () => {
    expect(decodeFrame(vector("prompt-result-queued"), "mcp")).toEqual({ type: "prompt.result", id: 15, delivered: false, queued: true, request: 14, position: 1 });
    expect(decodeFrame(vector("prompt-result-busy"), "mcp")).toEqual({ type: "prompt.result", id: 23, delivered: false, reason: "busy" });
    expect(() => decodeHeader(edited("prompt-result-queued", (h) => (h.position = 0)), "mcp")).toThrow(/position/);
    expect(() => decodeHeader(edited("prompt-result-queued", (h) => (h.reason = "busy")), "mcp")).toThrow(/no refusal reason/);
    expect(() => decodeHeader(edited("prompt-result-queued", (h) => (h.queued = false)), "mcp")).toThrow(/queued is true/);
  });

  it("decodes request.control and checks position against the action", () => {
    expect(decodeFrame(vector("request-control-stop"), "mod")).toEqual({ type: "request.control", player: KEV, action: "stop" });
    expect(decodeFrame(vector("request-control-queue-cancel"), "mod")).toEqual({ type: "request.control", player: KEV, action: "queue.cancel", position: 2 });
    expect(() => decodeHeader(edited("request-control-queue-cancel", (h) => delete h.position), "mod")).toThrow(/position goes exactly with queue.cancel/);
    expect(() => decodeHeader(edited("request-control-stop", (h) => (h.position = 1)), "mod")).toThrow(/position goes exactly with queue.cancel/);
    expect(() => decodeHeader(edited("request-control-stop", (h) => (h.action = "pause")), "mod")).toThrow(/action must be one of/);
    const m: RequestControl = { type: "request.control", player: KEV, action: "queue.cancel" };
    expect(() => encodeMessage(m)).toThrow(ProtocolError);
    // Only the mod sends it.
    expect(() => decodeFrame(vector("request-control-stop"), "mcp")).toThrow(/unknown message type "request.control" from the MCP/);
  });

  it("decodes canvas and canvas.set, and each only from its sender", () => {
    expect(decodeFrame(vector("canvas"), "mod")).toEqual({ type: "canvas", dimension: OW, box: { min: [0, -64, -512], max: [1023, 319, 511] } });
    expect(decodeFrame(vector("canvas-none"), "mod")).toEqual({ type: "canvas", box: null });
    expect(decodeFrame(vector("canvas-confirm"), "mod")).toMatchObject({ id: 31 });
    expect(decodeFrame(vector("canvas-set"), "mcp")).toEqual({ type: "canvas.set", id: 31, dimension: OW, box: { min: [5, 60, -500], max: [1020, 120, 500] } });
    expect(() => decodeHeader(edited("canvas-none", (h) => (h.id = 3)), "mod")).toThrow(/without a box/);
    expect(() => decodeHeader(edited("canvas", (h) => delete h.dimension), "mod")).toThrow(/dimension/);
    expect(() => decodeHeader(edited("canvas-set", (h) => (h.box = { min: [9, 0, 0], max: [0, 0, 0] })), "mcp")).toThrow(/min must not exceed max/);
    expect(() => decodeFrame(vector("canvas"), "mcp")).toThrow(/unknown message type "canvas"/);
    expect(() => decodeFrame(vector("canvas-set"), "mod")).toThrow(/unknown message type "canvas.set"/);
  });

  it("needs both hellos for requests and canvas", () => {
    const mod = { type: "hello", protocol: 4, mod: { version: "x" }, game: { version: "1.21.1", dataVersion: 3955, loader: "neoforge", loaderVersion: "x" }, singleplayer: true, host: null } as const;
    const all = (f: readonly McpFeature[]) => ({ features: [...f] });
    expect(bothHave(all(MCP_WIRE_FEATURES), { ...mod, features: ["canvas"] }, "canvas")).toBe(true);
    expect(bothHave(all(MCP_WIRE_FEATURES), { ...mod, features: ["canvas"] }, "requests")).toBe(false);
    expect(bothHave(all(MCP_FEATURES), { ...mod, features: [...MOD_FEATURES] }, "canvas")).toBe(false);
  });
});

describe("requests and canvas: fake host", () => {
  let host: FakeHost | undefined;
  let bridge: Bridge | undefined;
  afterEach(async () => {
    bridge?.close();
    await host?.close();
    host = bridge = undefined;
  });

  async function pair(opts: Parameters<typeof FakeHost.start>[0] = {}, features: McpFeature[] = [...MCP_WIRE_FEATURES]) {
    host = await FakeHost.start(opts);
    bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE, reconnect: false, modes: [...REQUEST_MODES], features });
    const canvases: CanvasMessage[] = [];
    bridge.on("canvas", (m) => canvases.push(m));
    await bridge.connect();
    return { host, bridge, canvases };
  }

  const status = (over: Partial<StatusMessage> = {}): StatusMessage => ({ ...(decodeFrame(vector("chat-status-working"), "mcp") as StatusMessage), ...over });

  it("sends canvas after the hello and on each change, only when both hellos list it", async () => {
    const { host, canvases } = await pair({ volumes: { work: { min: [0, 64, 0], max: [15, 79, 15] } }, canvas: { box: { min: [3, 70, -20], max: [40, 80, 40] } } });
    await host.waitFor(() => canvases.length === 1);
    expect(canvases[0]).toEqual({ type: "canvas", dimension: OW, box: { min: [0, -64, -32], max: [47, 319, 47] } });
    expect(host.sent.map((m) => m.type).slice(0, 3)).toEqual(["hello", "volumes", "canvas"]);
    host.setCanvas(null);
    await host.waitFor(() => canvases.length === 2);
    expect(canvases[1]).toEqual({ type: "canvas", box: null });
  });

  it("sends no canvas to an MCP that doesn't list it, and the bridge sends no canvas.set to a mod without it", async () => {
    const a = await pair({ canvas: { box: { min: [0, 0, 0], max: [15, 15, 15] } } }, ["prompt.close"]);
    host!.setCanvas({ box: { min: [0, 0, 0], max: [31, 15, 15] } });
    await new Promise((r) => setTimeout(r, 20));
    expect(a.canvases).toEqual([]);
    expect(host!.sent.some((m) => m.type === "canvas")).toBe(false);
    bridge!.close();
    await host!.close();
    const b = await pair({ features: ["modes", "volumes.set", "select"] });
    const e = (await b.bridge.request({ type: "canvas.set", dimension: OW, box: { min: [0, 0, 0], max: [15, 15, 15] } }).catch((x: unknown) => x)) as BridgeError;
    expect(e.refusal).toBe("world_mod_outdated");
    expect(e.message).toContain("the canvas");
    expect(b.host.received.some((m) => m.type === "canvas.set")).toBe(false);
  });

  it("answers canvas.set with the widened canvas, or bad_volumes past canvasChunks, or wrong_dimension", async () => {
    const { host, bridge } = await pair({ canvasChunks: 8 });
    const ok = await bridge.request({ type: "canvas.set", dimension: OW, box: { min: [5, 60, -20], max: [100, 120, 30] } });
    expect(ok).toEqual({ type: "canvas", id: expect.any(Number), dimension: OW, box: { min: [0, -64, -32], max: [111, 319, 31] } });
    expect(host.canvas).toEqual({ dimension: OW, box: { min: [0, -64, -32], max: [111, 319, 31] } });
    const wide = (await bridge.request({ type: "canvas.set", dimension: OW, box: { min: [0, 0, 0], max: [16 * 9 - 1, 0, 0] } }).catch((x: unknown) => x)) as BridgeError;
    expect(wide.refusal).toBe("bad_volumes");
    expect(wide.message).toContain("canvasChunks (8)");
    const dim = (await bridge.request({ type: "canvas.set", dimension: "mod:nowhere", box: { min: [0, 0, 0], max: [1, 1, 1] } }).catch((x: unknown) => x)) as BridgeError;
    expect(dim.refusal).toBe("wrong_dimension");
    expect(host.canvas!.box.max[0]).toBe(111); // the refusals changed nothing
  });

  it("serves reads inside the canvas without a select request, and refuses outside it", async () => {
    const { host, bridge } = await pair({ volumes: { work: { min: [0, 64, 0], max: [15, 79, 15] } }, canvas: { box: { min: [0, 0, 0], max: [16 * 6 - 1, 0, 16 * 6 - 1] } }, missingChunks: new Set(["5,5"]) });
    host.set([70, 64, 70], BRICK);
    const snap = await bridge.request({ type: "snapshot", dimension: OW, boxes: [{ min: [70, 64, 70], max: [70, 64, 70] }] });
    expect(snap.palette).toEqual([BRICK]);
    const missing = await bridge.request({ type: "snapshot", dimension: OW, boxes: [{ min: [80, 64, 80], max: [81, 64, 81] }] });
    expect(missing.missing).toEqual([[5, 5]]);
    const coarse = await bridge.request({ type: "snapshot", dimension: OW, kind: "coarse", cell: 4, boxes: [{ min: [68, 64, 68], max: [71, 67, 71] }] });
    expect(coarse.palette).toEqual([BRICK]);
    const surface = await bridge.request({ type: "snapshot", dimension: OW, kind: "surface", columns: { min: [70, 70], max: [70, 70] } });
    expect(surface.surface.heights[0]).toBe(64 + 64 + 1);
    const found = await bridge.request({ type: "search", dimension: OW, materials: [BRICK], radius: 8 });
    expect(found.centre).toEqual([2, 2]); // the canvas's middle chunk, with no select request
    expect(found.chunks.map((c) => c.chunk)).toEqual([[4, 4]]);
    const fill = await bridge.request({ type: "fill", dimension: OW, seed: [70, 64, 70], match: [BRICK] });
    expect(fill.count).toBe(1);
    const out = (await bridge.request({ type: "snapshot", dimension: OW, boxes: [{ min: [200, 64, 0], max: [200, 64, 0] }] }).catch((x: unknown) => x)) as BridgeError;
    expect(out.refusal).toBe("outside_volumes");
    const dim = (await bridge.request({ type: "fill", dimension: "minecraft:the_nether", seed: [70, 64, 70], match: [BRICK] }).catch((x: unknown) => x)) as BridgeError;
    expect(dim.refusal).toBe("wrong_dimension");
    host.setCanvas(null);
    const none = (await bridge.request({ type: "fill", dimension: OW, seed: [70, 64, 70], match: [BRICK] }).catch((x: unknown) => x)) as BridgeError;
    expect(none.refusal).toBe("no_grant");
  });

  it("caps a canvas read per call by contextCap", async () => {
    const { bridge } = await pair({ contextCap: 1000, canvas: { box: { min: [0, 0, 0], max: [63, 0, 63] } } });
    const e = (await bridge.request({ type: "snapshot", dimension: OW, boxes: [{ min: [0, 0, 0], max: [31, 0, 31] }] }).catch((x: unknown) => x)) as BridgeError;
    expect(e.refusal).toBe("too_large");
  });

  it("serves no canvas reads from a mod without the feature", async () => {
    const { bridge } = await pair({ features: ["modes", "volumes.set", "select"], volumes: { work: { min: [0, 64, 0], max: [15, 79, 15] } }, canvas: { box: { min: [0, 0, 0], max: [95, 0, 95] } } });
    const e = (await bridge.request({ type: "snapshot", dimension: OW, boxes: [{ min: [70, 64, 70], max: [70, 64, 70] }] }).catch((x: unknown) => x)) as BridgeError;
    expect(e.refusal).toBe("outside_volumes");
  });

  it("records status lines only when both hellos list requests; the bridge drops them otherwise", async () => {
    const a = await pair();
    a.bridge.send(status());
    await a.host.waitFor(() => a.host.statuses.length === 1);
    expect(a.host.statusOf(14)).toMatchObject({ state: "working", calls: 14 });
    a.bridge.send(status({ state: "done", calls: 31, actions: [], lines: ["✔ Done"] }));
    await a.host.waitFor(() => a.host.statusOf(14)?.state === "done");
    expect(a.host.chats).toEqual([]); // status lines aren't activity or replies
    bridge!.close();
    await host!.close();
    const b = await pair({ features: ["modes", "ui"] }, [...MCP_WIRE_FEATURES]);
    b.bridge.send(status());
    b.bridge.send({ type: "notice", text: "after", player: null });
    await b.host.waitFor(() => b.host.notices.length === 1);
    expect(b.host.statuses).toEqual([]);
    expect(b.host.requestsUngated).toEqual([]); // the bridge never sent it
  });

  it("runs /autosketch stop, queue and queue cancel as request.control, and only to an MCP listing requests", async () => {
    const { host, bridge } = await pair();
    const got: RequestControl[] = [];
    bridge.on("request.control", (m) => {
      got.push(m);
      if (m.action === "queue") bridge.send({ type: "chat", request: null, player: m.player.uuid, kind: "reply", lines: ["Queue: empty."] });
      else bridge.send({ type: "notice", text: `Autosketch: ${m.action}`, player: m.player.uuid });
    });
    expect(await host.playerControl(KEV, "stop")).toMatchObject({ type: "notice", text: "Autosketch: stop" });
    expect(await host.playerControl(KEV, "queue")).toMatchObject({ type: "chat", lines: ["Queue: empty."] });
    expect(await host.playerControl(KEV, "queue.cancel", 2)).toMatchObject({ type: "notice", text: "Autosketch: queue.cancel" });
    expect(got).toEqual([
      { type: "request.control", player: KEV, action: "stop" },
      { type: "request.control", player: KEV, action: "queue" },
      { type: "request.control", player: KEV, action: "queue.cancel", position: 2 },
    ]);
    bridge.close();
    await host.close();
    const old = await pair({}, ["prompt.close", "ui"]);
    expect(await old.host.playerControl(KEV, "stop")).toEqual({ local: "mcp_outdated" });
    expect(old.host.sent.some((m) => m.type === "request.control")).toBe(false);
  });

  it("clicks a status line's button as its ui.request", async () => {
    const { host, bridge } = await pair();
    bridge.on("ui.request", (m) => bridge.send({ type: "ui.result", request: m.request, player: m.player.uuid, ok: true, result: { request: m.args.request, state: "stopping" } }));
    const r = await host.playerClickStatus(KEV, status(), 0);
    expect(host.sent.at(-1)).toMatchObject({ type: "ui.request", player: KEV, kind: "request.stop", args: { request: 14 } });
    expect(r).toMatchObject({ type: "ui.result", ok: true, result: { request: 14, state: "stopping" } });
    expect(() => host.playerClickStatus(KEV, status({ actions: [] }), 0)).toThrow(/no button 0/);
  });
});
