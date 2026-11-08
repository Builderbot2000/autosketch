import { afterEach, describe, expect, it } from "vitest";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document } from "../../../src/document/document.js";
import { fill } from "../../../src/ops/edit.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import type { WireBox } from "../../../src/world/protocol/messages.js";
import { parseSnbt } from "../../../src/world/protocol/snbt.js";
import { applyWorldState, cacheHashes, syncBySections, type LinkFrame } from "../../../src/world/sync.js";
import { FakeHost } from "../../support/fake-host.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";
import { SyncClient } from "./sync-client.js";

const env = { registry: vanillaRegistry() };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const O: Vec3 = [100, 64, -200];
const W = (p: Vec3): Vec3 => [p[0] + O[0], p[1] + O[1], p[2] + O[2]];
const WB = (min: Vec3, max: Vec3): WireBox => ({ min: W(min), max: W(max) });
const at = (doc: Document, x: number, y: number, z: number) => doc.getState(x, y, z).replace("minecraft:", "");

let host: FakeHost | undefined;
let client: SyncClient | undefined;
afterEach(async () => {
  client?.close();
  await host?.close();
  host = client = undefined;
});

/** A fake world with an 8³ work volume (context: grown by 3) and a cache filled from a full snapshot. */
async function linkedPair() {
  const work = WB([0, 0, 0], [7, 7, 7]);
  host = await FakeHost.start({ volumes: { work } });
  for (let x = -3; x <= 10; x++) for (let z = -3; z <= 10; z++) host.set(W([x, -1, z]), "minecraft:grass_block[snowy=false]");
  host.set(W([2, 0, 2]), "minecraft:chest[facing=north,type=single,waterlogged=false]", parseSnbt('{id:"minecraft:chest",Items:[]}'));
  client = await SyncClient.open(host);
  const v = client.volumes!;
  if (v.work === null) throw new Error("unlinked");
  const frame: LinkFrame = { origin: O, volumes: [v.work, ...v.context], volatile: DEFAULT_VOLATILE };
  const doc = Document.create({ name: "linked", dataVersion: 3955, seed: 1 });
  const snap = await client.snapshot({ boxes: frame.volumes });
  applyWorldState(doc, { snapshot: snap }, { origin: O, volumes: frame.volumes, volatile: frame.volatile });
  return { doc, frame, host, client };
}

describe("section-hash sync (13, W5)", () => {
  it("a cache filled from a snapshot hashes like the world: nothing differs, no entry", async () => {
    const { doc, frame, client } = await linkedPair();
    expect(at(doc, 0, -1, 0)).toBe("grass_block[snowy=false]");
    expect(at(doc, -3, -1, -3)).toBe("grass_block[snowy=false]"); // context
    const head = doc.journal.headSeq;
    const r = await syncBySections(doc, client, frame);
    expect(r.sections.compared).toBe(4); // x 97..110 → 1 section, y 61..74 → 2, z -203..-190 → 2
    expect(r.sections.differing).toEqual([]);
    expect(r.changed).toBe(0);
    expect(doc.journal.headSeq).toBe(head);
  });

  it("an \"everything\" dirty with one changed section snapshots only that section", async () => {
    const { doc, frame, host, client } = await linkedPair();
    host.playerSetMany(Array.from({ length: 5 }, (_, i) => ({ pos: W([i, 3, 0]), state: "minecraft:stone" })));
    // The tracker lost count: no positions.
    host.markEverythingDirty();
    await client.waitDirty(host, 2);
    expect(client.dirty.at(-1)).toEqual({ type: "dirty", everything: true });
    const snaps = host.received.filter((m) => m.type === "snapshot").length;
    const r = await syncBySections(doc, client, frame);
    expect(r.sections.differing).toEqual([[6, 4, -13]]);
    const req = host.received.filter((m) => m.type === "snapshot");
    expect(req.length).toBe(snaps + 1);
    expect(req.at(-1)).toMatchObject({ sections: [[6, 4, -13]] });
    expect(r.changed).toBe(5);
    for (let i = 0; i < 5; i++) expect(at(doc, i, 3, 0)).toBe("stone");
    expect(doc.journal.entries.at(-1)!.summary).toBe("world sync: 1 of 4 sections differed");
    expect((await syncBySections(doc, client, frame)).sections.differing).toEqual([]);
  });

  it("a contents-only change (no dirty notice) is picked up by the next sync", async () => {
    const { doc, frame, host, client } = await linkedPair();
    const filled = parseSnbt('{id:"minecraft:chest",Items:[{Slot:0b,id:"minecraft:diamond",count:3}]}');
    host.playerSetNbt(W([2, 0, 2]), filled);
    const r = await syncBySections(doc, client, frame);
    expect(r.changed).toBe(1);
    expect(doc.getBlockEntity(2, 0, 2)).toEqual(filled);
    expect(client.dirty).toEqual([]);
  });

  it("a ticking furnace's volatile keys don't make its section differ", async () => {
    const { doc, frame, host, client } = await linkedPair();
    const state = "minecraft:furnace[facing=north,lit=false]";
    host.playerSet(W([4, 0, 4]), state, parseSnbt('{id:"minecraft:furnace",BurnTime:0s,Items:[]}'));
    await client.waitDirty(host, 1);
    applyWorldState(doc, { blocks: client.dirty[0]!.everything ? [] : client.dirty[0]!.blocks }, { origin: O, volumes: frame.volumes, volatile: frame.volatile });
    host.tick(W([4, 0, 4]), parseSnbt("{BurnTime:80s}"));
    expect((await syncBySections(doc, client, frame)).sections.differing).toEqual([]);
  });

  it("keeps cache hashes incrementally: a write invalidates its section, and the sync restores the world's blocks", async () => {
    const { doc, frame, client } = await linkedPair();
    const before = cacheHashes(doc, frame);
    // A cache-only change (a lost ack, a stale draft): the world is authoritative.
    fill(doc, env, B([0, 0, 0], [0, 0, 0]), "gold_block");
    const after = cacheHashes(doc, frame);
    const changed = [...after].filter(([k, h]) => before.get(k) !== h).map(([k]) => k);
    expect(changed).toEqual(["6,4,-13"]);
    const r = await syncBySections(doc, client, frame);
    expect(r.sections.differing).toEqual([[6, 4, -13]]);
    expect(at(doc, 0, 0, 0)).toBe("air");
    // Undo and redo write too, so they invalidate as well.
    doc.undo();
    expect(cacheHashes(doc, frame).get("6,4,-13")).toBe(after.get("6,4,-13"));
  });

  it("partial form from a dirty notice: a player edit in the context volume syncs", async () => {
    const { doc, frame, host, client } = await linkedPair();
    host.playerSet(W([-2, 0, -2]), "minecraft:oak_log[axis=y]");
    host.playerSet(W([40, 0, 40]), "minecraft:oak_log[axis=y]"); // outside both volumes: never reported
    const [d] = await client.waitDirty(host, 1);
    if (!d || d.everything) throw new Error("expected positions");
    const r = applyWorldState(doc, { blocks: d.blocks }, { origin: O, volumes: frame.volumes, volatile: frame.volatile });
    expect(r.changed).toBe(1);
    expect(at(doc, -2, 0, -2)).toBe("oak_log[axis=y]");
    expect(client.dirty.length).toBe(1);
  });
});
