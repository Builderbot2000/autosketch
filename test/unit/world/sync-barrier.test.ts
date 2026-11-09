import { describe, expect, it } from "vitest";
import { refusalCode, type EventSink, type ObserveEvent } from "../../../src/core/events.js";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill } from "../../../src/ops/edit.js";
import { ScopeManager } from "../../../src/scope/scopes.js";
import { applyWorldState } from "../../../src/world/sync.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

const env = { registry: vanillaRegistry() };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const at = (doc: Document, x: number, y: number, z: number) => doc.getState(x, y, z).replace("minecraft:", "");

function refused(fn: () => unknown): { code?: string; message: string } {
  try {
    fn();
  } catch (e) {
    return { code: refusalCode(e), message: (e as Error).message };
  }
  throw new Error("expected a refusal");
}

/** A document with two ops, a sync of a hand edit, and one more op. */
function history() {
  const doc = Document.create({ name: "linked", dataVersion: 3955, seed: 1, size: [16, 8, 16] });
  fill(doc, env, B([0, 0, 0], [7, 0, 7]), "stone"); // #1
  doc.checkpoint("ground");
  fill(doc, env, B([0, 1, 0], [0, 3, 0]), "oak_log"); // #2
  applyWorldState(doc, { blocks: [{ pos: [3, 1, 3], state: "minecraft:gold_block" }] }); // #3: the player's edit
  fill(doc, env, B([5, 1, 5], [5, 1, 5]), "dirt"); // #4
  doc.checkpoint("top");
  return doc;
}

/** A sink recording each step's kind with `doc.overwriting` at the time it was emitted. */
function recorder(doc: Document): { kind: string; forced: boolean }[] {
  const log: { kind: string; forced: boolean }[] = [];
  const sink: EventSink = { enabled: true, emit: (e: ObserveEvent) => void log.push({ kind: e.kind, forced: doc.overwriting }) };
  doc.events = sink;
  return log;
}

describe("sync barrier (13, W6)", () => {
  it("undo stops at a world_sync entry that changed blocks, and says why", () => {
    const doc = history();
    doc.undo(); // #4 is fine
    const r = refused(() => doc.undo());
    expect(r.code).toBe("sync_barrier");
    expect(r.message).toContain("undo would step past #3 world sync: 1 block");
    expect(r.message).toContain("erase those edits");
    expect(r.message).toContain("overwriteHandEdits: true");
    expect(at(doc, 3, 1, 3)).toBe("gold_block");
    expect(doc.journal.headSeq).toBe(3);
  });

  it("overwriteHandEdits crosses it, and commit listeners see the step as forced", () => {
    const doc = history();
    doc.undo();
    const log = recorder(doc);
    expect(doc.undo({ overwriteHandEdits: true })?.entry.seq).toBe(3);
    expect(at(doc, 3, 1, 3)).toBe("air");
    doc.undo(); // #2: past the barrier already
    expect(log).toEqual([{ kind: "doc.undo", forced: true }, { kind: "doc.undo", forced: false }]);
    expect(doc.overwriting).toBe(false);
    // Redo stops at the sync entry too: it would push the synced states over whatever the world holds now.
    doc.redo();
    expect(refused(() => doc.redo()).code).toBe("sync_barrier");
    expect(doc.redo({ overwriteHandEdits: true })?.entry.seq).toBe(3);
  });

  it("restore across a barrier is refused with nothing changed; with overwriteHandEdits it applies, forced throughout", () => {
    const doc = history();
    const before = doc.journal.headSeq;
    const r = refused(() => doc.restore("ground"));
    expect(r.code).toBe("sync_barrier");
    expect(r.message).toMatch(/^restore "ground" refused: step 2 of 3 \(undo of op #3 world sync: 1 block\)/);
    expect(r.message).toContain("Nothing was changed; the document is still at op #4.");
    expect(doc.journal.headSeq).toBe(before);
    expect(at(doc, 5, 1, 5)).toBe("dirt");
    const log = recorder(doc);
    expect(doc.restore("ground", { overwriteHandEdits: true })).toMatchObject({ steps: 3, direction: "undo" });
    expect(log.map((e) => e.forced)).toEqual([true, true, true]);
    expect(at(doc, 3, 1, 3)).toBe("air");
    expect(at(doc, 0, 1, 0)).toBe("air");
    // And back up: redo crosses it the same way.
    expect(refused(() => doc.restore("top")).code).toBe("sync_barrier");
    expect(doc.restore("top", { overwriteHandEdits: true }).steps).toBe(3);
    expect(at(doc, 3, 1, 3)).toBe("gold_block");
  });

  it("restore up to the barrier, without crossing it, is allowed", () => {
    const doc = history();
    doc.undo();
    doc.checkpoint("synced"); // right after the sync
    doc.redo();
    fill(doc, env, B([6, 1, 6], [6, 1, 6]), "dirt");
    expect(doc.restore("synced").steps).toBe(2);
    expect(at(doc, 3, 1, 3)).toBe("gold_block");
  });

  it("composes with the lock guard: both still refuse, and the scope layer's guard is untouched", () => {
    const doc = Document.create({ name: "linked", dataVersion: 3955, seed: 1, size: [32, 16, 32] });
    const scopes = new ScopeManager(() => doc);
    scopes.attach(doc);
    const lockGuard = doc.guard;
    fill(doc, env, B([0, 0, 0], [31, 0, 31]), "stone");
    applyWorldState(doc, { blocks: [{ pos: [20, 1, 20], state: "minecraft:gold_block" }] });
    expect(doc.guard).toBe(lockGuard);
    expect(doc.guards.length).toBe(1);
    fill(doc, env, B([10, 1, 10], [10, 1, 10]), "dirt");
    scopes.fork("base", { work: Mask.fromBox(B([8, 1, 8], [15, 8, 15])), brief: "tower", env });
    // The newest entry wrote into what is now a lock: the lock guard refuses its undo first.
    expect(refused(() => doc.undo()).code).toBe("lock_overlap");
    expect(refused(() => doc.undo({ overwriteHandEdits: true })).code).toBe("lock_overlap");
  });

  it("an unlinked document has no extra guard and behaves as before", () => {
    const doc = Document.create({ name: "plain", dataVersion: 3955, seed: 1, size: [8, 8, 8] });
    fill(doc, env, B([0, 0, 0], [1, 0, 1]), "stone");
    expect(doc.guards).toEqual([]);
    expect(doc.undo({ overwriteHandEdits: true })?.entry.seq).toBe(1);
    expect(doc.redo()?.entry.seq).toBe(1);
  });
});
