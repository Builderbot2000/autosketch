import { describe, expect, it } from "vitest";
import { fromPublic } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { clear, fill, replace, setBlocks } from "../../../src/ops/edit.js";
import { changedRegions, diffSince, documentAt, formatDiff, resolveSince } from "../../../src/perception/diff.js";

const B = (min: [number, number, number], max: [number, number, number]) => fromPublic({ min, max });

function build() {
  const doc = Document.create({ name: "d", dataVersion: 3955, seed: 1 });
  fill(doc, {}, B([0, 0, 0], [3, 0, 3]), "minecraft:stone");
  doc.checkpoint("base");
  fill(doc, {}, B([0, 1, 0], [3, 1, 3]), "minecraft:oak_planks"); // +16
  replace(doc, {}, B([0, 0, 0], [3, 0, 0]), "minecraft:stone", "minecraft:cobblestone"); // 4 replaced
  clear(doc, B([3, 1, 3], [3, 1, 3])); // one plank gone again
  setBlocks(doc, {}, [{ pos: [10, 0, 10], block: "minecraft:glass" }]);
  return doc;
}

describe("diff", () => {
  it("summarises changes since a checkpoint by family and region", () => {
    const doc = build();
    const d = diffSince(doc, "checkpoint:base");
    expect(d.ops).toBe(4);
    expect(d.changes).toHaveLength(15 + 4 + 1);
    expect(d.mask.has(3, 1, 3)).toBe(false); // added then removed: no net change
    expect(formatDiff(d)).toBe(
      [
        "diff since checkpoint \"base\" (4 ops): 20 positions changed in (0,0,0)–(10,1,10)",
        "added: oak_planks 15, glass 1",
        "replaced: stone→cobblestone 4",
        "regions: (0,0,0)–(3,1,3) 19 · (10,0,10)–(10,0,10) 1",
      ].join("\n"),
    );
    expect(diffSince(doc, "base").changes).toHaveLength(20);
  });

  it("diffs the last n ops and a checkpoint ahead of now", () => {
    const doc = build();
    expect(formatDiff(diffSince(doc, "op:-1"))).toBe(
      ["diff since the last op (1 op): 1 position changed in (10,0,10)–(10,0,10)", "added: glass 1", "regions: (10,0,10)–(10,0,10) 1"].join("\n"),
    );
    doc.checkpoint("end");
    doc.undo();
    doc.undo();
    const ahead = diffSince(doc, "checkpoint:end");
    expect(ahead.ahead).toBe(true);
    // Now → the checkpoint: the plank comes back as air and the glass disappears, seen from now.
    expect(ahead.changes.map((c) => [c.pos.join(","), c.before, c.after]).sort()).toEqual([
      ["10,0,10", "minecraft:glass", "minecraft:air"],
      ["3,1,3", "minecraft:air", "minecraft:oak_planks"],
    ]);
    expect(formatDiff(ahead)).toMatch(/which are undone/);
  });

  it("errors on bad references", () => {
    const doc = build();
    expect(() => resolveSince(doc, "op:-9")).toThrow(/only 5 ops/);
    expect(() => resolveSince(doc, "checkpoint:nope")).toThrow(/no checkpoint "nope" \(have: base\)/);
    expect(() => resolveSince(doc, "op:-0")).toThrow(/n ≥ 1/);
  });

  it("builds a snapshot at the reference point without touching the document", () => {
    const doc = build();
    const rev = doc.revision;
    const snap = documentAt(doc, resolveSince(doc, "base").target);
    expect(snap.getState(0, 1, 0)).toBe("minecraft:air");
    expect(snap.getState(0, 0, 0)).toBe("minecraft:stone");
    expect(snap.getState(10, 0, 10)).toBe("minecraft:air");
    expect(snap.blockCount()).toBe(16);
    expect(doc.getState(0, 1, 0)).toBe("minecraft:oak_planks");
    expect(doc.revision).toBe(rev);
    expect(doc.journal.cursor).toBe(5);
  });

  it("clusters changed positions", () => {
    const doc = build();
    expect(changedRegions(diffSince(doc, "base").mask).map((r) => r.count)).toEqual([19, 1]);
  });
});
