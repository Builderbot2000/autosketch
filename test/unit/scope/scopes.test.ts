import { describe, expect, it } from "vitest";
import { refusalCode, type ObserveEvent } from "../../../src/core/events.js";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill, setBlocks } from "../../../src/ops/edit.js";
import type { AutosketchPlugin } from "../../../src/plugins/types.js";
import { runScript } from "../../../src/script/run.js";
import { extendWholeBlocks } from "../../../src/scope/multiblock.js";
import { ScopeManager, seamShell } from "../../../src/scope/scopes.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

const registry = vanillaRegistry({ "minecraft:oak_fence": ["minecraft:fences", "minecraft:wooden_fences"] });
const env = { registry };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const M = (min: Vec3, max: Vec3) => Mask.fromBox(B(min, max));
const at = (doc: Document, x: number, y: number, z: number) => doc.getState(x, y, z).replace("minecraft:", "");
const side = (doc: Document, x: number, y: number, z: number, d: string) => new RegExp(`${d}=(\\w+)`).exec(doc.getState(x, y, z))?.[1];

function setup(size: Vec3 = [32, 16, 32]) {
  const doc = Document.create({ name: "base", dataVersion: 3955, seed: 1, size });
  const scopes = new ScopeManager(() => doc);
  scopes.attach(doc);
  return { doc, scopes };
}

/** The error a call throws, and its refusal code. */
function refused(fn: () => unknown): { code?: string; message: string } {
  try {
    fn();
  } catch (e) {
    return { code: refusalCode(e), message: (e as Error).message };
  }
  throw new Error("expected a refusal");
}

describe("scope fork (11)", () => {
  it("copies only the work and context volumes, re-origined, and writes a handoff block", () => {
    const { doc, scopes } = setup();
    fill(doc, env, B([0, 0, 0], [31, 0, 31]), "stone"); // ground everywhere
    fill(doc, env, B([25, 1, 25], [26, 2, 26]), "gold_block"); // far away: must not be copied
    const f = scopes.fork("base", { work: M([10, 1, 10], [17, 8, 17]), brief: "Build a small tower", env, spec: { levels: { cornice: 6 }, anchors: { door: [13, 1, 10] }, values: { wall: 1 } } });
    const sb = f.scope.doc;
    expect(f.scope.id).toBe("s1");
    expect(f.scope.offset).toEqual([10, 1, 10]);
    // Ground under the work volume sits at local y=-1 (context), and the work volume starts at (0,0,0).
    expect(at(sb, 0, -1, 0)).toBe("stone");
    expect(at(sb, -3, -1, -3)).toBe("stone");
    expect(at(sb, -4, -1, 0)).toBe("air"); // beyond the default 3-block context
    expect(sb.blockCount()).toBe(14 * 14); // one ground layer of the context: nothing else came along
    expect(sb.localBounds()).toEqual(B([-3, -3, -3], [10, 10, 10]));
    expect(f.handoff).toContain('scope:"s1"');
    expect(f.handoff).toContain("Work volume (editable): (0,0,0)–(7,7,7)");
    expect(f.handoff).toContain("cornice 5");
    expect(f.handoff).toContain("door (3,0,0)");
  });

  it("refuses writes outside the work volume, in any write path, and explains why", () => {
    const { doc, scopes } = setup();
    fill(doc, env, B([0, 0, 0], [31, 0, 31]), "stone");
    const sb = scopes.fork("base", { work: M([10, 1, 10], [17, 8, 17]), brief: "job", env }).scope.doc;
    const r = refused(() => fill(sb, env, B([0, 0, 0], [8, 0, 0]), "oak_planks"));
    expect(r.code).toBe("outside_work_volume");
    expect(r.message).toMatch(/outside the work volume of scope s1 \(e\.g\. \(8,0,0\); 1 in the read-only context\)/);
    expect(at(sb, 0, 0, 0)).toBe("air"); // rolled back
    // The context (ground) is read-only too.
    expect(refused(() => setBlocks(sb, env, [{ pos: [0, -1, 0], block: "dirt" }])).message).toMatch(/1 in the read-only context/);
    // A clear over a bigger box is fine: nothing outside changes.
    fill(sb, env, B([0, 0, 0], [7, 0, 7]), "oak_planks");
    expect(at(sb, 7, 0, 7)).toBe("oak_planks");
    // Scripts go through the same guard: the whole run rolls back.
    return runScript(sb, env, { source: 'fill(sel.box([0,1,0],[9,1,0]), "stone");' }).then(
      () => expect.unreachable(),
      (e: unknown) => {
        expect(String((e as Error).message)).toMatch(/outside the work volume/);
        expect(at(sb, 0, 1, 0)).toBe("air");
      },
    );
  });

  it("connects a fence to the context wall in the sandbox and to the real wall after merge", () => {
    const { doc, scopes } = setup();
    fill(doc, env, B([18, 0, 10], [18, 3, 17]), "oak_planks"); // a wall just east of the work volume
    setBlocks(doc, env, [{ pos: [13, 0, 9], block: "oak_fence" }]); // a fence just north of the work volume
    const s = scopes.fork("base", { work: M([10, 0, 10], [17, 7, 17]), brief: "fence", env }).scope;
    const sb = s.doc;
    // Local x=8 is the wall (context). A fence line to the boundary joins it.
    fill(sb, env, B([0, 0, 3], [7, 0, 3]), "oak_fence");
    expect(side(sb, 7, 0, 3, "east")).toBe("true");
    // A fence up to the north boundary joins the context fence, whose connection is recomputed there.
    setBlocks(sb, env, [{ pos: [3, 0, 0], block: "oak_fence" }]);
    expect(side(sb, 3, 0, 0, "north")).toBe("true");
    expect(side(sb, 3, 0, -1, "south")).toBe("true");
    expect(side(doc, 13, 0, 9, "south")).toBe("false"); // the base is untouched until merge
    const m = scopes.merge(s.id, "built a fence", env);
    expect(side(doc, 17, 0, 13, "east")).toBe("true");
    expect(side(doc, 10, 0, 13, "west")).toBe("false");
    // The seam recompute updated the real fence outside the work volume.
    expect(side(doc, 13, 0, 9, "south")).toBe("true");
    expect(m.seam).toBeGreaterThan(0);
    expect(m.edit.box).toBeDefined();
    // One undo reverts the whole merge.
    const head = doc.journal.headSeq;
    doc.undo();
    expect(doc.journal.headSeq).toBe(head - 1);
    expect(at(doc, 13, 0, 13)).toBe("air");
    expect(side(doc, 13, 0, 9, "south")).toBe("false");
    expect(scopes.openCount).toBe(0);
  });

  it("locks the work volume in the parent: overlapping forks and edits are refused, neighbours work", () => {
    const { doc, scopes } = setup();
    fill(doc, env, B([0, 0, 0], [31, 0, 31]), "stone");
    const a = scopes.fork("base", { work: M([0, 0, 0], [7, 7, 7]), brief: "west tower", env }).scope;
    const r = refused(() => scopes.fork("base", { work: M([4, 0, 4], [11, 7, 11]), brief: "x", env }));
    expect(r.code).toBe("lock_overlap");
    expect(r.message).toMatch(/lock held by job s1 \("west tower"\)/);
    // The parent's own edit inside the lock is refused; next to it, allowed.
    expect(refused(() => fill(doc, env, B([5, 1, 5], [9, 1, 5]), "oak_planks")).code).toBe("lock_overlap");
    fill(doc, env, B([8, 1, 5], [9, 1, 5]), "oak_planks");
    expect(at(doc, 8, 1, 5)).toBe("oak_planks");
    // Undoing an older edit that touched the locked region is refused too, and changes nothing.
    doc.undo(); // the planks
    expect(refused(() => doc.undo()).code).toBe("lock_overlap");
    expect(at(doc, 3, 0, 3)).toBe("stone");
    // A neighbouring job whose context overlaps the lock is fine, and is told the context may be stale.
    const b = scopes.fork("base", { work: M([8, 0, 0], [15, 7, 7]), brief: "east tower", env });
    expect(b.stale.map((s) => s.scope)).toEqual(["s1"]);
    // Abandon releases the lock.
    scopes.abandon(a.id);
    fill(doc, env, B([5, 1, 5], [5, 1, 5]), "oak_planks");
    expect(at(doc, 5, 1, 5)).toBe("oak_planks");
  });

  it("enforces the over-nesting limits with their refusal messages, and they are configurable", () => {
    const { doc, scopes } = setup([16, 16, 16]); // 4096 blocks: half is 2048
    fill(doc, env, B([0, 0, 0], [15, 0, 15]), "stone");
    const small = refused(() => scopes.fork("base", { work: M([0, 0, 0], [6, 6, 6]), brief: "x", env }));
    expect(small).toEqual({ code: "nest_too_small", message: expect.stringMatching(/^Small enough to do directly\./) });
    const large = refused(() => scopes.fork("base", { work: M([0, 0, 0], [15, 8, 15]), brief: "x", env }));
    expect(large).toEqual({ code: "nest_too_large", message: expect.stringMatching(/^This is most of your own job: do it yourself, or split it into smaller jobs\./) });
    scopes.limits = { maxWorkRatio: 0.9, minWorkBlocks: 8, maxDepth: 2 };
    const s1 = scopes.fork("base", { work: M([0, 0, 0], [15, 8, 15]), brief: "big", env }).scope;
    const s2 = scopes.fork(s1.id, { work: M([0, 0, 0], [3, 3, 3]), brief: "child", env }).scope;
    expect(s2.depth).toBe(2);
    const deep = refused(() => scopes.fork(s2.id, { work: M([0, 0, 0], [1, 1, 1]), brief: "grandchild", env }));
    expect(deep).toEqual({ code: "nest_depth", message: expect.stringMatching(/^Too deep: finish this job in your own sandbox\./) });
  });

  it("nests: the child forks from the sandbox, its lock lives there, and merges go up one level", () => {
    const { doc, scopes } = setup();
    scopes.limits = { maxWorkRatio: 0.5, minWorkBlocks: 8, maxDepth: 3 };
    const p = scopes.fork("base", { work: M([8, 0, 8], [23, 7, 23]), brief: "keep", env }).scope;
    // The child's work must lie inside the parent's work volume.
    expect(refused(() => scopes.fork(p.id, { work: M([-1, 0, 0], [3, 3, 3]), brief: "x", env })).code).toBe("nest_outside");
    const c = scopes.fork(p.id, { work: M([0, 0, 0], [3, 3, 3]), brief: "corner", env, context: { expand: 10 } });
    // Its context is clipped to the parent's volumes.
    expect(c.contextClipped).toBeGreaterThan(0);
    expect(c.scope.contextLocal.bbox()!.min).toEqual([-3, -3, -3]);
    // The lock is in the parent sandbox, not in the base.
    expect(refused(() => setBlocks(p.doc, env, [{ pos: [1, 1, 1], block: "stone" }])).code).toBe("lock_overlap");
    setBlocks(doc, env, [{ pos: [0, 0, 0], block: "stone" }]); // the base is only locked by p
    setBlocks(c.scope.doc, env, [{ pos: [1, 1, 1], block: "gold_block" }]);
    expect(refused(() => scopes.merge(p.id, "r")).code).toBe("scope_children");
    scopes.merge(c.scope.id, "corner done");
    expect(at(p.doc, 1, 1, 1)).toBe("gold_block");
    expect(at(doc, 9, 1, 9)).toBe("air");
    scopes.merge(p.id, "keep done");
    expect(at(doc, 9, 1, 9)).toBe("gold_block");
  });

  it("merges two parallel jobs with overlapping contexts in either order to the same result", () => {
    const run = (order: ("a" | "b")[]) => {
      const { doc, scopes } = setup();
      fill(doc, env, B([0, 0, 0], [31, 0, 31]), "stone");
      const a = scopes.fork("base", { work: M([0, 1, 0], [7, 8, 7]), brief: "a", env }).scope;
      const b = scopes.fork("base", { work: M([8, 1, 0], [15, 8, 7]), brief: "b", env }).scope;
      fill(a.doc, env, B([0, 0, 3], [7, 0, 3]), "oak_fence");
      fill(b.doc, env, B([0, 0, 3], [7, 0, 3]), "oak_fence");
      fill(b.doc, env, B([0, 1, 0], [0, 3, 7]), "cobblestone_wall");
      expect(side(a.doc, 7, 0, 3, "east")).toBe("false"); // b's fence isn't there yet (stale context)
      for (const k of order) scopes.merge((k === "a" ? a : b).id, k, env);
      return doc;
    };
    const ab = run(["a", "b"]), ba = run(["b", "a"]);
    expect(side(ab, 7, 1, 3, "east")).toBe("true");
    expect(side(ab, 8, 1, 3, "west")).toBe("true");
    for (let x = 0; x < 16; x++) for (let y = 0; y < 6; y++) for (let z = 0; z < 8; z++) expect(ab.getState(x, y, z)).toBe(ba.getState(x, y, z));
  });

  it("fails the merge loudly when the parent changed inside the lock (a bug)", () => {
    const { doc, scopes } = setup();
    const s = scopes.fork("base", { work: M([0, 0, 0], [7, 7, 7]), brief: "x", env }).scope;
    doc.voxels.set(1, 1, 1, doc.states.intern("minecraft:stone")); // bypasses every guard
    const r = refused(() => scopes.merge(s.id, "r", env));
    expect(r.code).toBe("merge_check");
    expect(scopes.openCount).toBe(1);
  });

  it("handles components across the boundary: editable, external and partial, reserved ids, write-back", () => {
    const { doc, scopes } = setup();
    fill(doc, env, B([10, 0, 10], [12, 2, 12]), "stone", { as: "inner", kind: "plinth" });
    fill(doc, env, B([16, 0, 10], [22, 2, 12]), "bricks", { as: "crossing" });
    fill(doc, env, B([28, 0, 28], [30, 2, 30]), "bricks", { as: "far" });
    doc.edit("anchor", "a", (tx) => tx.setComponent({ id: "inner", box: B([10, 0, 10], [12, 2, 12]), anchors: { top: [11, 3, 11] } }));
    const s = scopes.fork("base", { work: M([8, 0, 8], [17, 7, 17]), brief: "x", env }).scope;
    const sb = s.doc;
    expect([...s.copied]).toEqual(["inner"]);
    expect([...s.external]).toEqual(["crossing"]);
    expect(sb.components.has("far")).toBe(false);
    expect(sb.componentLocal("inner")).toMatchObject({ box: B([2, 0, 2], [4, 2, 4]), anchors: { top: [3, 3, 3] } });
    expect(sb.componentLocal("crossing")!.tags).toEqual(["external", "partial"]);
    expect(sb.componentLocal("crossing")!.box).toEqual(B([8, 0, 2], [12, 2, 4])); // clipped to the context
    expect(s.reserved.has("far")).toBe(true);
    // Read-only and reserved components, and new ones outside the work volume, are refused.
    expect(refused(() => sb.edit("x", "x", (tx) => tx.removeComponent("crossing"))).code).toBe("outside_work_volume");
    expect(refused(() => fill(sb, env, B([0, 0, 0], [1, 1, 1]), "stone", { as: "far" })).code).toBe("component_reserved");
    expect(refused(() => sb.edit("x", "x", (tx) => tx.setComponent({ id: "big", box: B([0, 0, 0], [10, 1, 1]) }))).code).toBe("outside_work_volume");
    // Editable ones change and new ones are written back in parent coordinates.
    fill(sb, env, B([5, 0, 5], [6, 3, 6]), "oak_planks", { as: "post" });
    sb.edit("x", "x", (tx) => tx.removeComponent("inner"));
    scopes.merge(s.id, "r", env);
    expect(doc.componentLocal("post")!.box).toEqual(B([13, 0, 13], [14, 3, 14]));
    expect(doc.components.has("inner")).toBe(false);
    expect(doc.components.has("crossing")).toBe(true);
    expect(doc.componentLocal("crossing")!.tags).toEqual([]);
  });

  it("emits scope events in the base frame through the parent's sink", () => {
    const doc = Document.create({ name: "base", dataVersion: 3955, seed: 1, size: [32, 16, 32] });
    const seen: { doc: string; e: ObserveEvent }[] = [];
    const scopes = new ScopeManager(() => doc, { events: (d) => ({ enabled: true, emit: (e) => void seen.push({ doc: d, e }) }) });
    scopes.attach(doc);
    const s = scopes.fork("base", { work: M([8, 0, 8], [15, 7, 15]), brief: "job", env }).scope;
    expect(s.doc.events.enabled).toBe(true);
    setBlocks(s.doc, env, [{ pos: [0, 0, 0], block: "stone" }]);
    scopes.merge(s.id, "done", env);
    const s2 = scopes.fork("base", { work: M([8, 0, 8], [15, 7, 15]), brief: "again", env }).scope;
    scopes.abandon(s2.id);
    const kinds = seen.map((x) => `${x.doc}:${x.e.kind}`);
    expect(kinds).toEqual(["base:scope.fork", "s1:doc.op", "base:scope.merge", "base:scope.fork", "base:scope.abandon"]);
    expect(seen[0]!.e).toMatchObject({ scope: "s1", parent: "base", depth: 1, work: { min: [8, 0, 8], max: [15, 7, 15] }, translation: [8, 0, 8], brief: "job" });
    expect(seen[2]!.e).toMatchObject({ kind: "scope.merge", scope: "s1", report: "done", box: { min: [8, 0, 8], max: [8, 0, 8] } });
  });
});

describe("whole-block extension (11)", () => {
  it("extends a volume over doors, beds and double chests it cuts, and plugin multi-blocks", () => {
    const doc = Document.create({ name: "t", dataVersion: 3955, seed: 1 });
    setBlocks(doc, env, [
      { pos: [0, 0, 0], block: "oak_door[facing=south,half=lower]" },
      { pos: [0, 1, 0], block: "oak_door[facing=south,half=upper]" },
      { pos: [2, 0, 0], block: "red_bed[facing=east,part=foot]" },
      { pos: [3, 0, 0], block: "red_bed[facing=east,part=head]" },
      { pos: [5, 0, 0], block: "chest[facing=south,type=left]" },
      { pos: [4, 0, 0], block: "chest[facing=south,type=right]" },
      { pos: [7, 0, 0], block: "lodestone" },
    ], undefined, { raw: true });
    const plugin = { id: "t", namespaces: ["test"], multiBlock: { partners: (s: string) => (s === "minecraft:lodestone" ? [[0, 1, 0], [0, 2, 0]] as [number, number, number][] : undefined) } } as AutosketchPlugin;
    const r = extendWholeBlocks(doc, M([0, 0, 0], [7, 0, 0]), [plugin]);
    expect(r.added.positions().sort()).toEqual([[0, 1, 0], [7, 1, 0], [7, 2, 0]]);
    // The bed's head and the chest's partner are inside already; cutting them extends.
    expect(extendWholeBlocks(doc, M([3, 0, 0], [4, 0, 0])).added.positions().sort()).toEqual([[2, 0, 0], [5, 0, 0]]);
  });

  it("extends a fork's work volume over a door it cuts, and reports it", () => {
    const { doc, scopes } = setup();
    setBlocks(doc, env, [{ pos: [8, 0, 3], block: "oak_door[facing=east,half=lower]" }, { pos: [8, 1, 3], block: "oak_door[facing=east,half=upper]" }], undefined, { raw: true });
    const f = scopes.fork("base", { work: M([0, 0, 0], [8, 0, 63]), brief: "path", env, context: new Mask() });
    expect(f.extension.positions()).toEqual([[8, 1, 3]]);
    expect(f.scope.workLocal.has(8, 1, 3)).toBe(true);
    expect(f.handoff).toContain("blocks (not the whole box)");
  });
});

describe("seam shell", () => {
  it("covers one block on both sides of the boundary over connection neighbours", () => {
    const s = seamShell(M([0, 0, 0], [2, 2, 2]));
    expect(s.has(1, 1, 1)).toBe(false); // the centre of a 3³ box has every neighbour inside
    expect(s.has(0, 1, 1)).toBe(true);
    expect(s.has(-1, 0, 0) && s.has(3, 2, 2) && s.has(-1, -1, 1)).toBe(true);
    expect(s.has(-1, -1, -1)).toBe(false); // corners only through 6 faces and vertical diagonals
  });
});
