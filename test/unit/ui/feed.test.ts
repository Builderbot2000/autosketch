import { describe, expect, it } from "vitest";
import type { LoggedEvent, ObserveEvent } from "../../../src/core/events.js";
import type { PublicBox } from "../../../src/core/region.js";
import { Mask } from "../../../src/core/mask.js";
import { mergeBoxes } from "../../../src/ui/boxes.js";
import { CANDIDATE_COLOUR, candidateFill } from "../../../src/ui/candidate-outline.js";
import { jobColour } from "../../../src/ui/colours.js";
import { UiFeed } from "../../../src/ui/feed.js";
import type { WorldFrame } from "../../../src/ui/frame.js";
import { CANDIDATE_FILL, SAVE_FLASH_COLOUR, SAVE_FLASH_JOB, type UiFlashMessage, type UiMcpMessage, type UiRequestInfo, type UiState } from "../../../src/world/protocol/messages.js";

/** The overlay feed (16, *MCP side*, Feed; 13, *In-game UI*): coalescing, resync, job colours. */

const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const B = (min: [number, number, number], max: [number, number, number]): PublicBox => ({ min, max });

class FakeBridge {
  ui = true;
  sent: UiMcpMessage[] = [];
  private fns: ((s: "up" | "down") => void)[] = [];
  send(m: UiMcpMessage) {
    if (this.ui) this.sent.push(m);
  }
  onConnection(fn: (s: "up" | "down") => void) {
    this.fns.push(fn);
    return () => void (this.fns = this.fns.filter((f) => f !== fn));
  }
  emit(s: "up" | "down") {
    for (const f of this.fns) f(s);
  }
}

function setup(opts: { frame?: WorldFrame | undefined; players?: string[]; linked?: boolean } = {}) {
  const bridge = new FakeBridge();
  const state = { frame: "frame" in opts ? opts.frame : { dimension: "minecraft:overworld", origin: [100, 64, -200] as [number, number, number] }, players: opts.players ?? [P1], request: null as UiRequestInfo | null, linked: opts.linked ?? true };
  const feed = new UiFeed({ bridge, frame: () => state.frame, players: () => state.players, request: () => state.request, linked: () => state.linked, intervalMs: 1e9 });
  let seq = 0;
  const pub = (doc: string, e: ObserveEvent) => feed.onEvent({ v: 1, seq: ++seq, t: seq * 10, doc, ...e } as LoggedEvent);
  const states = () => bridge.sent.filter((m): m is UiState => m.type === "ui.state");
  const flashes = () => bridge.sent.filter((m): m is UiFlashMessage => m.type === "ui.flash");
  return { bridge, state, feed, pub, states, flashes };
}

const fork = (scope: string, work: PublicBox, brief = "tower"): ObserveEvent => ({ kind: "scope.fork", scope, parent: "base", depth: 1, work, context: B([work.min[0] - 1, work.min[1], work.min[2] - 1], [work.max[0] + 1, work.max[1], work.max[2] + 1]), translation: work.min, brief });
const op = (box: PublicBox): ObserveEvent => ({ kind: "doc.op", jseq: 1, op: "fill", summary: "", changed: 1, box, counts: { placed: {}, removed: 0 } });

describe("ui feed", () => {
  it("sends a full state on connect, then numbered changes: a job at fork, removed at merge", () => {
    const { feed, pub, states } = setup();
    expect(states()).toEqual([{ type: "ui.state", players: [P1], seq: 1, full: true, jobs: [], request: null, tokens: null, refusal: null }]);
    feed.tick();
    expect(states()).toHaveLength(1); // nothing changed: nothing sent
    pub("base", fork("j1", B([0, 0, 0], [3, 3, 3]), "west tower"));
    feed.tick();
    expect(states()[1]).toEqual({
      type: "ui.state", players: [P1], seq: 2, full: false,
      jobs: [{ id: "j1", colour: jobColour("j1"), brief: "west tower", dimension: "minecraft:overworld", work: { min: [100, 64, -200], max: [103, 67, -197] }, context: [{ min: [99, 64, -201], max: [104, 67, -196] }] }],
    });
    pub("base", { kind: "scope.merge", scope: "j1", report: "done", jseq: 2 });
    feed.tick();
    expect(states()[2]).toEqual({ type: "ui.state", players: [P1], seq: 3, full: false, removed: ["j1"] });
    feed.close();
  });

  it("coalesces every edit of a window into one flash per job, sandbox boxes in world coordinates, at most 64 boxes", () => {
    const { feed, pub, flashes } = setup();
    pub("base", fork("j1", B([10, 0, 0], [40, 9, 9])));
    for (let x = 0; x < 200; x++) pub("base", op(B([x, 20, 0], [x, 20, 0])));
    pub("j1", op(B([0, 0, 0], [1, 1, 1]))); // sandbox frame: + translation (10,0,0)
    expect(flashes()).toHaveLength(0); // nothing is sent from the subscriber
    feed.tick();
    expect(flashes()).toHaveLength(1);
    const [base, j1] = flashes()[0]!.flashes;
    expect(base!.job).toBe("base");
    expect(base!.colour).toBe(jobColour("base"));
    expect(base!.boxes.length).toBeLessThanOrEqual(64);
    // Every changed position is still covered.
    for (let x = 0; x < 200; x++) expect(base!.boxes.some((b) => b.min[0] <= x + 100 && b.max[0] >= x + 100 && b.min[1] === 84)).toBe(true);
    expect(j1).toEqual({ job: "j1", colour: jobColour("j1"), dimension: "minecraft:overworld", boxes: [{ min: [110, 64, -200], max: [111, 65, -199] }] });
    feed.tick();
    expect(flashes()).toHaveLength(1); // flashes are not repeated
    feed.close();
  });

  it("save flash (17, piece 8): the saved box in white with job save, beside a job's in the same window, sandbox boxes translated; nothing unlinked", () => {
    const { feed, pub, flashes, state } = setup();
    pub("base", fork("j1", B([10, 0, 0], [40, 9, 9])));
    pub("base", op(B([0, 0, 0], [0, 0, 0])));
    feed.saveFlash(B([0, 0, 0], [3, 2, 1]));
    feed.saveFlash(B([0, 0, 0], [1, 1, 1]), "j1");
    feed.tick();
    expect(flashes()).toHaveLength(1);
    expect(flashes()[0]!.flashes).toEqual([
      { job: "base", colour: jobColour("base"), dimension: "minecraft:overworld", boxes: [{ min: [100, 64, -200], max: [100, 64, -200] }] },
      { job: SAVE_FLASH_JOB, colour: SAVE_FLASH_COLOUR, dimension: "minecraft:overworld", boxes: [{ min: [100, 64, -200], max: [103, 66, -199] }, { min: [110, 64, -200], max: [111, 65, -199] }] },
    ]);
    state.linked = false; // an unlinked document (anchored or not) sends no save flash
    feed.saveFlash(B([0, 0, 0], [3, 2, 1]));
    feed.tick();
    expect(flashes()).toHaveLength(1);
    feed.close();
  });

  it("answers resync with the whole state to that player under the current seq", () => {
    const { feed, pub, states, bridge } = setup({ players: [P1, P2] });
    pub("base", fork("j1", B([0, 0, 0], [3, 3, 3])));
    feed.tick();
    expect(states().map((s) => s.seq)).toEqual([1, 2]);
    bridge.sent.length = 0;
    feed.resync(P2);
    expect(states()).toEqual([{ type: "ui.state", players: [P2], seq: 2, full: true, jobs: [expect.objectContaining({ id: "j1" })], request: null, tokens: null, refusal: null }]);
    // Changes pending at the resync go to everyone first, then the full state (same seq as that change).
    bridge.sent.length = 0;
    pub("base", fork("j2", B([8, 0, 0], [9, 3, 3])));
    feed.resync(P2);
    expect(states().map((s) => [s.players, s.seq, s.full])).toEqual([[[P1, P2], 3, false], [[P2], 3, true]]);
    feed.close();
  });

  it("restarts the count on each connection and sends nothing while the mod lacks ui", () => {
    const { feed, pub, states, bridge } = setup();
    bridge.emit("down");
    bridge.ui = false;
    pub("base", op(B([0, 0, 0], [0, 0, 0])));
    feed.tick();
    expect(states()).toHaveLength(1);
    bridge.ui = true;
    bridge.emit("up");
    expect(states().map((s) => [s.seq, s.full])).toEqual([[1, true], [1, true]]);
    feed.close();
  });

  it("sends a full state again when the overlay player set changes, and nothing to an empty set", () => {
    const { feed, state, states } = setup({ players: [] });
    expect(states()).toHaveLength(0);
    state.players = [P1];
    feed.tick();
    state.players = [P1, P2];
    feed.tick();
    expect(states().map((s) => [s.players, s.seq, s.full])).toEqual([[[P1], 1, true], [[P1, P2], 2, true]]);
    feed.close();
  });

  it("lists no jobs and no flashes without a world frame, and the request, tokens and refusal as they change", () => {
    const { feed, pub, state, states, flashes } = setup({ frame: undefined });
    pub("base", fork("j1", B([0, 0, 0], [3, 3, 3])));
    pub("base", op(B([0, 0, 0], [0, 0, 0])));
    state.request = { id: 4, mode: "plan", text: "a tower" };
    pub("base", { kind: "call.refused", call: 1, tool: "fill", code: "request_mode", message: "plan mode: no edits\nmore" });
    const otel = (name: string, attrs: Record<string, string | number>) => ({ kind: "otel" as const, record: { attributes: Object.entries({ "event.name": name, ...attrs }).map(([key, v]) => ({ key, value: typeof v === "number" ? { intValue: String(v) } : { stringValue: v } })) } });
    pub("base", otel("api_request", { "prompt.id": "p1", input_tokens: 100, output_tokens: 20, cache_read_tokens: 5, cache_creation_tokens: 1 }));
    feed.tick();
    expect(states()[1]).toEqual({
      type: "ui.state", players: [P1], seq: 2, full: false,
      request: { id: 4, mode: "plan", text: "a tower" },
      tokens: { input: 100, output: 20, cacheRead: 5, cacheCreation: 1 },
      refusal: { code: "request_mode", text: "fill: plan mode: no edits" },
    });
    expect(flashes()).toHaveLength(0);
    state.request = null;
    feed.tick();
    expect(states()[2]).toEqual({ type: "ui.state", players: [P1], seq: 3, full: false, request: null });
    feed.close();
  });
});

describe("job colours and box merging", () => {
  it("gives each job id one lowercase #rrggbb colour, the same every time", () => {
    for (const id of ["base", "j1", "j2", "j10"]) {
      expect(jobColour(id)).toMatch(/^#[0-9a-f]{6}$/);
      expect(jobColour(id)).toBe(jobColour(id));
    }
    expect(new Set(["j1", "j2", "j3", "j4"].map(jobColour)).size).toBe(4);
  });

  it("merges into at most the limit, covering every input", () => {
    const boxes = Array.from({ length: 130 }, (_, i) => B([i * 2, 0, 0], [i * 2, 0, 0]));
    const m = mergeBoxes([...boxes, boxes[0]!], 64);
    expect(m.length).toBeLessThanOrEqual(64);
    for (const b of boxes) expect(m.some((c) => c.min[0] <= b.min[0] && c.max[0] >= b.max[0])).toBe(true);
    expect(mergeBoxes([boxes[0]!, boxes[0]!], 64)).toEqual([boxes[0]]);
  });
});

describe("ui feed: the select candidate (18, piece 8)", () => {
  const D = "minecraft:overworld";
  function withCandidate() {
    const bridge = new FakeBridge();
    const cand = { current: undefined as { key: unknown; dimension: string; mask(): Mask } | undefined, built: 0 };
    const set = (...ps: [number, number, number][]) => {
      const m = new Mask();
      for (const p of ps) m.add(...p);
      cand.current = { key: {}, dimension: D, mask: () => (cand.built++, m) };
    };
    const feed = new UiFeed({ bridge, frame: () => undefined, players: () => [P1], request: () => null, candidate: () => cand.current, intervalMs: 1e9 });
    const states = () => bridge.sent.filter((m): m is UiState => m.type === "ui.state");
    const flashes = () => bridge.sent.filter((m): m is UiFlashMessage => m.type === "ui.flash");
    return { bridge, feed, cand, set, states, flashes };
  }

  it("sends the candidate as a fill record, rebuilt only when the shape changes, removed when it goes", () => {
    const { feed, cand, set, states } = withCandidate();
    expect(states()[0]!.fills).toBeUndefined(); // no candidate: the full state has no fills
    set([5, 70, -3]);
    feed.tick();
    expect(states()[1]).toEqual({ type: "ui.state", players: [P1], seq: 2, full: false, fills: [candidateFill(cand.current!.mask(), D)] });
    const built = cand.built;
    feed.tick();
    feed.tick();
    expect(states()).toHaveLength(2); // unchanged: nothing sent, nothing rebuilt
    expect(cand.built).toBe(built);
    set([5, 70, -3], [6, 70, -3]); // an expand
    feed.tick();
    expect(states()[2]!.fills![0]!.edges).toHaveLength(12);
    cand.current = undefined; // the request ended (the view emptied)
    feed.tick();
    expect(states()[3]).toEqual({ type: "ui.state", players: [P1], seq: 4, full: false, fillsRemoved: [CANDIDATE_FILL] });
    feed.close();
  });

  it("puts the candidate in a full state, as to a player who resyncs", () => {
    const { feed, set, states } = withCandidate();
    set([0, 0, 0]);
    feed.resync(P1);
    const full = states().filter((s) => s.full);
    expect(full.at(-1)!.fills!.map((f) => f.id)).toEqual([CANDIDATE_FILL]);
    feed.close();
  });

  it("pulses proposed hits as one flash record with job candidate, in world coordinates, without a frame", () => {
    const { feed, flashes } = withCandidate();
    expect(feed.pulseHits([{ min: [10, 60, 10], max: [20, 70, 20] }, { min: [-300, 64, 5], max: [-280, 80, 30] }], D)).toBe(true);
    feed.tick();
    expect(flashes()).toEqual([
      { type: "ui.flash", players: [P1], flashes: [{ job: CANDIDATE_FILL, colour: CANDIDATE_COLOUR, dimension: D, boxes: [{ min: [10, 60, 10], max: [20, 70, 20] }, { min: [-300, 64, 5], max: [-280, 80, 30] }] }] },
    ]);
    feed.tick();
    expect(flashes()).toHaveLength(1); // pulsed once
    feed.close();
    expect(feed.pulseHits([{ min: [0, 0, 0], max: [1, 1, 1] }], D)).toBe(false); // no UI connection
  });
});
