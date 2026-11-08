import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Compound } from "prismarine-nbt";
import { Document } from "../../../src/document/document.js";
import { loadNative, saveNative } from "../../../src/document/native.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { formatHistory } from "../../../src/server/format.js";
import { Session } from "../../../src/server/session.js";

const root = mkdtempSync(join(tmpdir(), "autosketch-journal-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const docPath = () => join(root, `d${++n}`, "doc.autosketch");

const blocks = (doc: Document) => {
  const out: string[] = [];
  doc.voxels.forEach((x, y, z, id) => out.push(`${x},${y},${z}=${doc.states.get(id)}`));
  return out.sort();
};
const chest: Compound = { type: "compound", value: { id: { type: "string", value: "minecraft:chest" } } };

/** Op i places block_i at (i,0,0); op 3 also adds a chest with NBT and a component. */
function build(doc: Document, from: number, to: number): void {
  for (let i = from; i < to; i++)
    doc.edit("set", `op ${i}`, (tx) => {
      tx.set(i, 0, 0, `test:block_${i}`);
      if (i === 3) {
        tx.set(i, 1, 0, "minecraft:chest[facing=north]", chest);
        tx.setComponent({ id: "c3", box: { min: [3, 0, 0], max: [4, 2, 1] } });
      }
    });
}

describe("journal persistence", () => {
  it("undo after reopening reaches ops from before the reopen, exactly; redo comes back", async () => {
    const path = docPath();
    const doc = Document.create({ name: "a", dataVersion: 3955, seed: 1 });
    build(doc, 0, 5);
    const states = [blocks(doc)];
    await saveNative(doc, path);
    expect(readdirSync(join(path, "..", "journal")).sort()).toEqual(["1-5.seg", "index.json"]);

    const back = await loadNative(path);
    expect(blocks(back)).toEqual(states[0]);
    expect(back.journal.position).toBe(5);
    expect(back.journal.entries.length).toBe(0); // nothing loaded until undo needs it
    expect(formatHistory(back, 10)).toMatch(/#1 op 0 · 1 changed[\s\S]*#5 op 4/);

    for (let k = 4; k >= 0; k--) {
      expect(back.undo()?.entry.summary).toBe(`op ${k}`);
      expect(blocks(back)).toEqual(Array.from({ length: k }, (_, i) => `${i},0,0=test:block_${i}`).concat(k > 3 ? ["3,1,0=minecraft:chest[facing=north]"] : []).sort());
    }
    expect(back.undo()).toBeUndefined();
    expect(back.components.size).toBe(0);
    for (let k = 0; k < 5; k++) back.redo();
    expect(blocks(back)).toEqual(states[0]);
    expect(back.getBlockEntity(3, 1, 0)).toEqual(chest);
    expect(back.components.get("c3")).toBeDefined();
    expect(back.redo()).toBeUndefined();
  });

  it("continues the sequence after reopening, and a new edit after undo discards the redo tail on disk", async () => {
    const path = docPath();
    const doc = Document.create({ name: "b", dataVersion: 3955, seed: 1 });
    build(doc, 0, 4);
    doc.checkpoint("mid");
    build(doc, 4, 6);
    await saveNative(doc, path);

    const d2 = await loadNative(path);
    d2.undo();
    d2.undo();
    d2.undo(); // back to after op 2 (position 3)
    build(d2, 10, 11); // discards ops 3,4,5
    expect(d2.journal.headSeq).toBe(7);
    await saveNative(d2, path);

    const d3 = await loadNative(path);
    expect(d3.journal.seqs).toEqual([1, 2, 3, 7]);
    expect(formatHistory(d3, 10)).not.toMatch(/op 4/);
    expect(() => d3.restore("mid")).toThrow(/can no longer be restored/);
    d3.undo();
    expect(blocks(d3)).toEqual(["0,0,0=test:block_0", "1,0,0=test:block_1", "2,0,0=test:block_2"]);
  });

  it("restores a checkpoint made before the reopen", async () => {
    const path = docPath();
    const doc = Document.create({ name: "c", dataVersion: 3955, seed: 1 });
    build(doc, 0, 2);
    doc.checkpoint("two");
    build(doc, 2, 5);
    await saveNative(doc, path);
    const back = await loadNative(path);
    expect(back.restore("two")).toMatchObject({ steps: 3, direction: "undo" });
    expect(blocks(back)).toEqual(["0,0,0=test:block_0", "1,0,0=test:block_1"]);
  });

  it("keeps memory under the cap by moving old entries to disk, and undo still reaches them", async () => {
    const path = docPath();
    const doc = new Document({ name: "d", front: "south", dataVersion: 3955, seed: 1, createdAt: "" }, { journalBytes: 2000 });
    await saveNative(doc, path); // attaches the store
    const big = (i: number) =>
      doc.edit("fill", `fill ${i}`, (tx) => {
        for (let x = 0; x < 20; x++) tx.set(x, i, 0, `test:layer_${i}`);
      });
    for (let i = 0; i < 30; i++) big(i);
    expect(doc.journal.entries.length).toBeLessThan(30);
    expect(doc.journal.start).toBeGreaterThan(0);
    expect(doc.journal.lost).toBe(0);
    for (let i = 29; i >= 0; i--) expect(doc.undo()?.entry.summary).toBe(`fill ${i}`);
    expect(doc.blockCount()).toBe(0);
    expect(doc.journal.entries.length).toBeLessThan(30);
    for (let i = 0; i < 30; i++) doc.redo();
    expect(doc.blockCount()).toBe(600);
  });

  it("treats journal disk writes as best-effort: the edit succeeds with a warning, memory passes the cap, and the write is retried", async () => {
    const path = docPath();
    const doc = new Document({ name: "f", front: "south", dataVersion: 3955, seed: 1, createdAt: "" }, { journalBytes: 2000 });
    await saveNative(doc, path); // attaches the store
    const store = doc.journal.store!;
    let failing = true;
    const fail = <T extends unknown[]>(real: (...a: T) => void) => (...a: T) => {
      if (failing) throw new Error("ENOSPC: disk full");
      real(...a);
    };
    const append = store.append.bind(store), discard = store.discard.bind(store);
    vi.spyOn(store, "append").mockImplementation(fail(append));
    vi.spyOn(store, "discard").mockImplementation(fail(discard));
    const big = (i: number) =>
      doc.edit("fill", `fill ${i}`, (tx) => {
        for (let x = 0; x < 20; x++) tx.set(x, i, 0, `test:layer_${i}`);
      });

    const results = Array.from({ length: 30 }, (_, i) => big(i));
    const rev = doc.revision;
    expect(rev).toBe(30); // every edit committed
    expect(results.every((r) => r.changed === 20)).toBe(true);
    expect(results.at(-1)!.warnings).toEqual([expect.stringMatching(/^undo history couldn't be written to disk \(ENOSPC: disk full\); it is kept in memory/)]);
    expect(results[0]!.warnings).toEqual([]); // under the cap, nothing to write yet
    expect(doc.journal.entries.length).toBe(30); // nothing evicted past the cap
    expect(doc.journal.start).toBe(0);

    // A discarded redo tail is retried too.
    doc.undo();
    doc.undo();
    const after = big(40);
    expect(after.warnings.length).toBe(1);
    expect(doc.journal.seqs.length).toBe(29);

    // The disk recovers: the next edit persists and trims, and undo reaches everything.
    failing = false;
    expect(big(41).warnings).toEqual([]);
    expect(doc.journal.start).toBeGreaterThan(0);
    expect(store.allSeqs().length).toBe(doc.journal.seqs.length);
    await saveNative(doc, path);
    const back = await loadNative(path);
    expect(back.journal.seqs).toEqual(doc.journal.seqs);
    const summaries: string[] = [];
    for (let e = back.undo(); e; e = back.undo()) summaries.push(e.entry.summary);
    expect(summaries.slice(0, 3)).toEqual(["fill 41", "fill 40", "fill 27"]);
    expect(summaries.length).toBe(30);
    expect(back.blockCount()).toBe(0);
  });

  it("reports a save failure from a failing store and saves once it recovers", async () => {
    const path = docPath();
    const doc = Document.create({ name: "g", dataVersion: 3955, seed: 1 });
    await saveNative(doc, path);
    const store = doc.journal.store!;
    const spy = vi.spyOn(store, "append").mockImplementation(() => {
      throw new Error("EIO");
    });
    build(doc, 0, 3);
    await expect(saveNative(doc, path)).rejects.toThrow(/EIO/);
    spy.mockRestore();
    await saveNative(doc, path);
    expect((await loadNative(path)).journal.seqs).toEqual([1, 2, 3]);
  });

  it("starts fresh when the journal doesn't match the document, or for files outside the workspace layout", async () => {
    const path = docPath();
    const doc = Document.create({ name: "e", dataVersion: 3955, seed: 1 });
    build(doc, 0, 3);
    await saveNative(doc, path);
    // Another document saved over it without touching the journal: its head (seq 5) isn't in the saved chain.
    const other = Document.create({ name: "e", dataVersion: 3955, seed: 1 });
    other.journal.newSeq();
    other.journal.newSeq();
    other.journal.newSeq();
    other.journal.newSeq();
    build(other, 7, 8); // seq 5, not in the saved chain [1,2,3]
    await saveNative(other, path, { journal: false });
    const back = await loadNative(path);
    expect(back.journal.seqs).toEqual([]);
    expect(back.undo()).toBeUndefined();

    const loose = join(root, "loose.autosketch");
    await saveNative(doc, loose);
    expect(readdirSync(root)).not.toContain("journal");
  });

  it("works through the session: doc_open then undo reaches pre-reopen ops", async () => {
    const ws = join(root, "ws");
    const s = new Session(ws);
    const doc = await s.create({ name: "house", mcVersion: "1.21.1", palettes: new PaletteBook() });
    build(doc, 0, 3);
    s.touch();
    await s.close();
    const opened = await s.open("house", new PaletteBook());
    expect(opened.undo()?.entry.summary).toBe("op 2");
    expect(blocks(opened)).toEqual(["0,0,0=test:block_0", "1,0,0=test:block_1"]);
    await s.close();
  });
});
