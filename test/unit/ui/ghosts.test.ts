import { describe, expect, it } from "vitest";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { EventBus } from "../../../src/observe/bus.js";
import { fill } from "../../../src/ops/edit.js";
import { ScopeManager } from "../../../src/scope/scopes.js";
import { jobColour } from "../../../src/ui/colours.js";
import type { WorldFrame } from "../../../src/ui/frame.js";
import { DOC_GHOST, GhostRegions } from "../../../src/ui/ghosts.js";
import type { UiGhost, UiMcpMessage } from "../../../src/world/protocol/messages.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

/** Ghost regions (16, *MCP side*, Ghosts; 13, `ui.ghost`): from scope documents, after deltas, anchored documents. */

const env = { registry: vanillaRegistry() };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const P1 = "00000000-0000-4000-8000-000000000001";

class FakeBridge {
  ui = true;
  sent: UiMcpMessage[] = [];
  send(m: UiMcpMessage) {
    this.sent.push(m);
  }
  onConnection() {
    return () => {};
  }
}

/** Every non-air block of a ghost message as [world x, y, z, state]. */
function blocksOf(m: UiGhost): [number, number, number, string][] {
  const out: [number, number, number, string][] = [];
  for (const s of m.sections)
    for (let i = 0; i < 4096; i++) {
      const p = s.states[i]!;
      if (!p) continue;
      out.push([m.origin[0] + s.section[0] * 16 + (i & 15), m.origin[1] + s.section[1] * 16 + (i >> 8), m.origin[2] + s.section[2] * 16 + ((i >> 4) & 15), m.palette[p]!.replace("minecraft:", "")]);
    }
  return out.sort();
}

function setup(linked: WorldFrame | null = { dimension: "minecraft:overworld", origin: [100, 64, -200] }) {
  const bus = new EventBus();
  const doc = Document.create({ name: "g", dataVersion: 3955, seed: 1, size: [32, 16, 32] });
  const scopes = new ScopeManager(() => doc, { events: (d) => bus.sink(d) });
  scopes.attach(doc);
  doc.events = bus.sink("base");
  fill(doc, env, B([0, 0, 0], [31, 0, 31]), "stone");
  const bridge = new FakeBridge();
  const ghosts = new GhostRegions({
    bridge,
    linkFrame: () => linked ?? undefined,
    players: () => [P1],
    baseDoc: () => doc,
    scope: (id) => scopes.scopes.get(id),
    baseOffset: (id) => scopes.baseOffset(id),
    scopeIds: () => [...scopes.scopes.keys()],
    intervalMs: 1e9,
  });
  bus.subscribe(ghosts.onEvent);
  const msgs = () => bridge.sent.filter((m) => m.type === "ui.ghost" || m.type === "ui.ghost.clear");
  return { bus, doc, scopes, bridge, ghosts, msgs };
}

describe("sandbox ghosts", () => {
  it("shows a job's blocks that differ from the base, where they land; resends only touched sections; clears on merge", () => {
    const { doc, scopes, ghosts, msgs, bridge } = setup();
    const f = scopes.fork("base", { work: Mask.fromBox(B([8, 1, 8], [23, 8, 23])), brief: "tower", env });
    const id = f.scope.id;
    fill(f.scope.doc, env, B([0, 0, 0], [1, 0, 0]), "oak_planks"); // sandbox (0,0,0) is base (8,1,8)
    fill(f.scope.doc, env, B([3, 0, 0], [3, 0, 0]), "air"); // nothing to remove there: no ghost block
    ghosts.tick();
    expect(msgs()).toHaveLength(1);
    const full = msgs()[0] as UiGhost;
    expect(full).toMatchObject({ ghost: id, dimension: "minecraft:overworld", origin: [108, 65, -192], tint: jobColour(id), full: true });
    expect(full.sections.map((s) => s.section)).toEqual([[0, 0, 0]]); // only non-empty sections
    expect(blocksOf(full)).toEqual([[108, 65, -192, "oak_planks"], [109, 65, -192, "oak_planks"]]);

    // An edit in another section: only that section, not full.
    bridge.sent.length = 0;
    fill(f.scope.doc, env, B([15, 7, 15], [15, 7, 15]), "glass");
    ghosts.tick();
    const part = msgs()[0] as UiGhost;
    expect(part.full).toBe(false);
    expect(part.sections.map((s) => s.section)).toEqual([[0, 0, 0]]);
    fill(f.scope.doc, env, B([0, 0, 0], [0, 0, 0]), "stone"); // back to what the base has: the ghost block goes
    fill(f.scope.doc, env, B([12, 2, 12], [15, 2, 15]), "glass");
    bridge.sent.length = 0;
    ghosts.tick();
    const next = msgs()[0] as UiGhost;
    expect(next.full).toBe(false);
    expect(blocksOf(next).filter((b) => b[3] === "oak_planks")).toEqual([[109, 65, -192, "oak_planks"]]);
    expect(blocksOf(next).filter((b) => b[3] === "glass")).toHaveLength(17);

    // The ghost equals the scope document at every position (whole rebuild after the deltas).
    const whole = ghosts.build(id, [P1], true)!;
    const expected: [number, number, number, string][] = [];
    f.scope.workLocal.forEach((x, y, z) => {
      const s = f.scope.doc.getState(x, y, z);
      if (s !== doc.getState(x + 8, y + 1, z + 8)) expected.push([x + 108, y + 65, z - 192, s.replace("minecraft:", "")]);
    });
    expect(blocksOf(whole)).toEqual(expected.sort());

    bridge.sent.length = 0;
    scopes.merge(id, "done", env);
    expect(msgs()).toEqual([{ type: "ui.ghost.clear", players: [P1], ghost: id }]);
    ghosts.tick();
    expect(msgs()).toHaveLength(1);
    ghosts.close();
  });

  it("clears on abandon, resends every ghost whole on resync, and nothing without a frame", () => {
    const { scopes, ghosts, msgs, bridge } = setup();
    const a = scopes.fork("base", { work: Mask.fromBox(B([0, 1, 0], [7, 8, 7])), brief: "a", env });
    fill(a.scope.doc, env, B([0, 0, 0], [0, 0, 0]), "glass");
    ghosts.tick();
    bridge.sent.length = 0;
    ghosts.resync(["p2"]);
    expect(msgs()).toMatchObject([{ type: "ui.ghost", players: ["p2"], ghost: a.scope.id, full: true }]);
    bridge.sent.length = 0;
    scopes.abandon(a.scope.id);
    expect(msgs()).toEqual([{ type: "ui.ghost.clear", players: [P1], ghost: a.scope.id }]);

    const unlinked = setup(null);
    const b = unlinked.scopes.fork("base", { work: Mask.fromBox(B([0, 1, 0], [7, 8, 7])), brief: "b", env });
    fill(b.scope.doc, env, B([0, 0, 0], [0, 0, 0]), "glass");
    unlinked.ghosts.tick();
    expect(unlinked.msgs()).toHaveLength(0);
    ghosts.close();
    unlinked.ghosts.close();
  });
});

describe("anchored document ghosts", () => {
  it("draws an unlinked document with its minimum corner at the anchor, updates from deltas, places jobs, clears", () => {
    const { doc, ghosts, msgs, bridge } = setup(null);
    fill(doc, env, B([-2, 1, 0], [-2, 1, 0]), "glass"); // the document now starts at x = -2
    expect(ghosts.anchorAt("minecraft:the_nether", [10, 70, 10])).toBe(DOC_GHOST);
    const m = msgs()[0] as UiGhost;
    expect(m).toMatchObject({ ghost: DOC_GHOST, dimension: "minecraft:the_nether", origin: [12, 70, 10], full: true });
    expect(ghosts.frame()).toEqual({ dimension: "minecraft:the_nether", origin: [12, 70, 10] });
    const blocks = blocksOf(m);
    expect(blocks).toHaveLength(32 * 32 + 1);
    expect(blocks).toContainEqual([10, 71, 10, "glass"]);
    expect(blocks).toContainEqual([12, 70, 10, "stone"]);

    bridge.sent.length = 0;
    fill(doc, env, B([5, 3, 5], [5, 3, 5]), "gold_block");
    ghosts.tick();
    const part = msgs()[0] as UiGhost;
    expect(part.full).toBe(false);
    expect(part.sections.map((s) => s.section)).toEqual([[0, 0, 0]]);
    expect(blocksOf(part)).toContainEqual([17, 73, 15, "gold_block"]);

    bridge.sent.length = 0;
    expect(ghosts.clear(DOC_GHOST)).toBe(true);
    expect(msgs()).toEqual([{ type: "ui.ghost.clear", players: [P1], ghost: DOC_GHOST }]);
    expect(ghosts.frame()).toBeUndefined();
    expect(ghosts.clear(DOC_GHOST)).toBe(false);
    ghosts.close();
  });
});
