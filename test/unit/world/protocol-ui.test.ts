import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePreviewBody, encodePreviewBody } from "../../../src/world/protocol/body.js";
import { decodeFrame, decodeMessage, encodeMessage, ProtocolError } from "../../../src/world/protocol/codec.js";
import { UI_PART_BYTES, uiEnabled, type Message, type UiGhost } from "../../../src/world/protocol/messages.js";

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
