import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NO_EVENTS, refusalCode, type ObserveEvent } from "../../../src/core/events.js";
import { EventFanout } from "../../../src/core/fanout.js";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill } from "../../../src/ops/edit.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { ScopeManager } from "../../../src/scope/scopes.js";
import { Session } from "../../../src/server/session.js";
import { tapJournal, type JournalStep } from "../../../src/world/journal-tap.js";
import { NO_PUSH_OPS, pushes, WORLD_SYNC_OP } from "../../../src/world/no-push.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

const env = { registry: vanillaRegistry() };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const M = (min: Vec3, max: Vec3) => Mask.fromBox(B(min, max));

const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-link-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function refused(fn: () => unknown): { code?: string; message: string } {
  try {
    fn();
  } catch (e) {
    return { code: refusalCode(e), message: (e as Error).message };
  }
  throw new Error("expected a refusal");
}

describe("event fan-out (13, Event fan-out)", () => {
  it("is the observability sink exactly while nothing listens", () => {
    let down = NO_EVENTS;
    const f = new EventFanout(() => down);
    const s = f.sink("base");
    expect(s.enabled).toBe(false);
    const seen: ObserveEvent[] = [];
    down = { enabled: true, emit: (e) => void seen.push(e) };
    expect(s.enabled).toBe(true);
    s.emit({ kind: "doc.checkpoint", name: "a", jseq: 1 });
    expect(seen).toHaveLength(1);
    expect(f.sink("base")).toBe(s); // stable object, so documents can keep it
  });

  it("stays enabled while a listener is subscribed, tags events by document, and isolates a throwing listener", () => {
    const errors: string[] = [];
    const f = new EventFanout(() => NO_EVENTS, (e) => errors.push(e.message));
    const got: [string, string][] = [];
    f.subscribe(() => {
      throw new Error("boom");
    });
    const off = f.subscribe((e, doc) => got.push([e.kind, doc]));
    expect(f.sink("s1").enabled).toBe(true);
    f.sink("s1").emit({ kind: "call.start", call: 1, tool: "fill" });
    expect(got).toEqual([["call.start", "s1"]]);
    expect(errors).toEqual(["boom"]);
    off();
    expect(f.listening).toBe(true);
  });

  it("delivers a base document's ops to session subscribers with observability off", async () => {
    const session = new Session(tempDir());
    const doc = await session.create({ name: "linked", mcVersion: "1.21.1", palettes: new PaletteBook() });
    expect(doc.events.enabled).toBe(false);
    const got: [string, string][] = [];
    const off = session.subscribe((e, d) => got.push([e.kind, d]));
    expect(doc.events.enabled).toBe(true);
    fill(doc, env, B([0, 0, 0], [1, 0, 1]), "stone");
    doc.undo();
    expect(got).toEqual([
      ["doc.op", "base"],
      ["doc.undo", "base"],
    ]);
    off();
    expect(doc.events.enabled).toBe(false);
    await session.close();
  });
});

describe("restore signal and journal tap (13, Agent → world)", () => {
  function linked() {
    const listeners = new Set<(e: ObserveEvent, doc: string) => void>();
    const fan = new EventFanout(() => NO_EVENTS);
    const doc = Document.create({ name: "base", dataVersion: 3955, seed: 1, size: [16, 16, 16] });
    doc.events = fan.sink("base");
    const batches: JournalStep[][] = [];
    const tap = tapJournal((fn) => fan.subscribe(fn), () => doc, (_d, steps) => batches.push(steps));
    return { doc, fan, batches, tap, listeners };
  }

  it("brackets a restore's steps with start and end, and not a restore with nothing to step", () => {
    const doc = Document.create({ name: "base", dataVersion: 3955, seed: 1 });
    const seen: string[] = [];
    doc.restoreListeners.add((phase, cp) => seen.push(`${phase}:${cp}`));
    doc.checkpoint("empty");
    fill(doc, env, B([0, 0, 0], [0, 0, 0]), "stone");
    doc.restore("empty");
    doc.restore("empty");
    expect(seen).toEqual(["start:empty", "end:empty"]);
  });

  it("makes one batch per committed entry, undo and redo, with the entry's positions and states", () => {
    const { doc, batches } = linked();
    fill(doc, env, B([0, 0, 0], [2, 0, 2]), "stone");
    doc.undo();
    doc.redo();
    expect(batches.map((b) => b.map((s) => `${s.kind}:${s.entry.op}:${s.to}`))).toEqual([["op:fill:after"], ["undo:fill:before"], ["redo:fill:after"]]);
    const e = batches[0]![0]!.entry;
    expect(e.after.length).toBe(9);
    expect([...e.before].every((id) => doc.states.get(id) === "minecraft:air")).toBe(true);
    expect([...e.after].every((id) => doc.states.get(id) === "minecraft:stone")).toBe(true);
  });

  it("sends a restore across five ops as one batch", () => {
    const { doc, batches } = linked();
    doc.checkpoint("start");
    for (let i = 0; i < 5; i++) fill(doc, env, B([i, 0, 0], [i, 0, 0]), "stone");
    batches.length = 0;
    doc.restore("start");
    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((s) => s.kind)).toEqual(["undo", "undo", "undo", "undo", "undo"]);
  });

  it("never sends the commit of a world_sync entry, but does send its undo", () => {
    const { doc, batches } = linked();
    expect(NO_PUSH_OPS.has(WORLD_SYNC_OP)).toBe(true);
    expect(pushes("fill")).toBe(true);
    doc.edit(WORLD_SYNC_OP, "world sync", (tx) => tx.set(0, 0, 0, "minecraft:dirt"));
    expect(batches).toHaveLength(0);
    doc.undo();
    expect(batches.map((b) => b[0]!.kind)).toEqual(["undo"]);
  });

  it("ignores sandbox documents and stops on close", () => {
    const { fan, doc, batches, tap } = linked();
    const sandbox = Document.create({ name: "s1", dataVersion: 3955, seed: 1 });
    sandbox.events = fan.sink("s1");
    fill(sandbox, env, B([0, 0, 0], [0, 0, 0]), "stone");
    expect(batches).toHaveLength(0);
    tap.close();
    fill(doc, env, B([0, 0, 0], [0, 0, 0]), "stone");
    expect(batches).toHaveLength(0);
  });
});

describe("root scope write rule (13, Model; 11)", () => {
  function rooted() {
    const doc = Document.create({ name: "base", dataVersion: 3955, seed: 1 });
    const scopes = new ScopeManager(() => doc);
    scopes.attach(doc);
    fill(doc, env, B([-3, -3, -3], [18, 18, 18]), "stone"); // the cache before the link applies its rule
    const work = M([0, 0, 0], [15, 15, 15]);
    scopes.root = { work, context: M([-3, -3, -3], [18, 18, 18]).subtract(work) };
    return { doc, scopes };
  }

  it("refuses writes outside the player's work volume with outside_work_volume, in edits and history", () => {
    const { doc, scopes } = rooted();
    fill(doc, env, B([0, 0, 0], [15, 0, 15]), "dirt");
    const r = refused(() => fill(doc, env, B([14, 0, 0], [17, 0, 0]), "gold_block"));
    expect(r.code).toBe("outside_work_volume");
    expect(r.message).toContain("2 blocks outside the work volume the player set in-game");
    expect(r.message).toContain("2 in the read-only context");
    expect(doc.getState(14, 0, 0)).toBe("minecraft:dirt"); // nothing was written
    // An entry from before the rule (the cache's initial fill) can't be undone through it either.
    scopes.root = undefined;
    doc.undo(); // undo the dirt (inside), fine without the rule
    scopes.root = { work: M([0, 0, 0], [15, 15, 15]), context: new Mask() };
    expect(refused(() => doc.undo()).code).toBe("outside_work_volume");
  });

  it("measures forks from the root against its volumes, and is inert when unset", () => {
    const { doc, scopes } = rooted();
    expect(refused(() => scopes.fork("base", { work: M([10, 0, 10], [18, 8, 18]), brief: "x", env })).code).toBe("nest_outside");
    const big = refused(() => scopes.fork("base", { work: M([0, 0, 0], [15, 14, 15]), brief: "x", env }));
    expect(big.code).toBe("nest_too_large");
    expect(big.message).toContain("the work volume the player set in-game (4,096)");
    const f = scopes.fork("base", { work: M([0, 0, 0], [7, 7, 7]), brief: "x", env, context: { padding: 5 } });
    expect(f.contextClipped).toBeGreaterThan(0); // the context stays inside the root's volumes
    scopes.abandon(f.scope.id);
    scopes.root = undefined;
    fill(doc, env, B([30, 0, 0], [30, 0, 0]), "stone"); // unlinked: no volume rule
    expect(doc.getState(30, 0, 0)).toBe("minecraft:stone");
  });
});

describe("call hooks (13: auto-sync before, world line after)", () => {
  it("run around the tool body in order, and a session without hooks runs it unchanged", async () => {
    const session = new Session(tempDir());
    const call = { tool: "fill", scope: "base", doc: true, mutating: true };
    const plain = await session.runCall(call, () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    expect(plain).toEqual({ content: [{ type: "text", text: "ok" }] });
    const order: string[] = [];
    session.callHooks.push({
      before: (c) => void order.push(`before ${c.tool}`),
      after: (_c, r) => ({ ...r, content: [...r.content, { type: "text", text: "world: 9 placed, 0 skipped (hand-edited), 0 rejected" }] }),
    });
    const r = await session.runCall(call, () => {
      order.push("run");
      return { content: [{ type: "text" as const, text: "ok" }] };
    });
    expect(order).toEqual(["before fill", "run"]);
    expect(r.content.map((c) => (c as { text: string }).text)).toEqual(["ok", "world: 9 placed, 0 skipped (hand-edited), 0 rejected"]);
  });
});
