import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { refusalCode } from "../../../src/core/events.js";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Document, type EditResult } from "../../../src/document/document.js";
import { fill } from "../../../src/ops/edit.js";
import { formatHistory } from "../../../src/server/format.js";
import { Session } from "../../../src/server/session.js";
import { Bridge } from "../../../src/world/bridge.js";
import type { DirtyState, LinkState, LinkVolumes, SyncFn, SyncReason, WorldLink } from "../../../src/world/link.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import { applyWorldState, autoSyncHook, syncLink } from "../../../src/world/sync.js";
import { FakeHost } from "../../support/fake-host.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";

const env = { registry: vanillaRegistry() };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const O: Vec3 = [100, 64, -200];
const W = (p: Vec3): Vec3 => [p[0] + O[0], p[1] + O[1], p[2] + O[2]];
const at = (doc: Document, x: number, y: number, z: number) => doc.getState(x, y, z).replace("minecraft:", "");

/**
 * A minimal WorldLink over the real bridge (silo P's implementation is still to come): the volumes
 * from the mod, the dirty notices accumulated, and the installed sync.
 */
class TestLink implements WorldLink {
  state: LinkState = "linked";
  volumes: LinkVolumes;
  readonly volatile = DEFAULT_VOLATILE;
  private dirty?: DirtyState;
  private sync?: SyncFn;
  constructor(
    readonly doc: Document,
    readonly bridge: Bridge,
  ) {
    const v = bridge.volumes!;
    if (v.work === null) throw new Error("no volumes");
    this.volumes = { link: v.link, dimension: v.dimension, work: v.work, extended: v.work, context: v.context, origin: [...v.work.min] };
    bridge.on("dirty", (m) => {
      const d = (this.dirty ??= { everything: false, blocks: [] });
      if (m.everything) {
        d.everything = true;
        d.blocks = [];
      } else if (!d.everything) d.blocks.push(...m.blocks);
    });
  }
  isDirty() {
    return this.dirty !== undefined;
  }
  takeDirty() {
    const d = this.dirty;
    this.dirty = undefined;
    return d;
  }
  syncNow(reason: SyncReason = "manual"): Promise<EditResult | undefined> {
    return this.sync ? this.sync(this, reason) : Promise.resolve(undefined);
  }
  setSync(fn: SyncFn) {
    this.sync = fn;
  }
  toWorld(p: Vec3): Vec3 {
    return [p[0] + O[0], p[1] + O[1], p[2] + O[2]];
  }
  toLocal(p: Vec3): Vec3 {
    return [p[0] - O[0], p[1] - O[1], p[2] - O[2]];
  }
}

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));
let host: FakeHost | undefined;
let bridge: Bridge | undefined;
afterEach(async () => {
  bridge?.close();
  await host?.close();
  host = bridge = undefined;
});

async function linkedSession() {
  host = await FakeHost.start({ volumes: { work: { min: W([0, 0, 0]), max: W([7, 7, 7]) } } });
  for (let x = -3; x <= 10; x++) for (let z = -3; z <= 10; z++) host.set(W([x, -1, z]), "minecraft:stone");
  bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE, reconnect: false });
  await bridge.connect();
  await host.waitFor(() => bridge!.volumes);
  const dir = mkdtempSync(join(tmpdir(), "autosketch-sync-link-"));
  roots.push(dir);
  const session = new Session(dir);
  const doc = Document.create({ name: "linked", dataVersion: 3955, seed: 1 });
  session.doc = doc;
  session.scopes.attach(doc);
  const link = new TestLink(doc, bridge);
  // The link's first snapshot (P's relink does this); then the hooks as server/index.ts installs them.
  const frame = [link.volumes.extended, ...link.volumes.context];
  applyWorldState(doc, { snapshot: await bridge.request({ type: "snapshot", dimension: link.volumes.dimension, boxes: frame }) }, { origin: O, volumes: frame, volatile: DEFAULT_VOLATILE });
  session.world = link;
  link.setSync(syncLink);
  session.callHooks.push(autoSyncHook(() => session.world));
  return { session, doc, link, host, bridge };
}

const call = { tool: "fill", scope: "base", doc: true, mutating: true };

describe("auto-sync before a tool call (13, W5)", () => {
  it("a player edit, then the next tool call: the cache shows the edit before the tool runs, as one world_sync entry", async () => {
    const { session, doc, link, host } = await linkedSession();
    const head = doc.journal.headSeq;
    host.playerSet(W([2, 0, 2]), "minecraft:oak_planks");
    await host.waitFor(() => link.isDirty());
    let seen = "";
    await session.runCall(call, () => {
      seen = at(doc, 2, 0, 2);
      return { content: [] };
    });
    expect(seen).toBe("oak_planks");
    expect(doc.journal.headSeq).toBe(head + 1);
    expect(doc.journal.entries.at(-1)!.op).toBe("world_sync");
    expect(formatHistory(doc, 1)).toContain("world sync: 1 block · 1 changed");
    expect(link.isDirty()).toBe(false);
    // No snapshot or hash request: the dirty notice carried the positions.
    expect(host.received.filter((m) => m.type === "hashes")).toEqual([]);
    // Nothing dirty: the next call doesn't sync.
    await session.runCall(call, () => ({ content: [] }));
    expect(doc.journal.headSeq).toBe(head + 1);
  });

  it("an \"everything\" dirty syncs by section hashes; tools without a document and world_sync itself don't trigger it", async () => {
    const { session, doc, link, host } = await linkedSession();
    host.set(W([5, 5, 5]), "minecraft:glass");
    host.markEverythingDirty();
    await host.waitFor(() => link.isDirty());
    await session.runCall({ tool: "palette_list", scope: "base", doc: false, mutating: false }, () => ({ content: [] }));
    await session.runCall({ tool: "world_sync", scope: "base", doc: false, mutating: true }, () => ({ content: [] }));
    expect(link.isDirty()).toBe(true);
    await session.runCall({ tool: "render", scope: "base", doc: true, mutating: false }, () => ({ content: [] }));
    expect(at(doc, 5, 5, 5)).toBe("glass");
    expect(host.received.filter((m) => m.type === "hashes").length).toBe(1);
    expect(host.received.filter((m) => m.type === "snapshot").at(-1)).toMatchObject({ sections: [[6, 4, -13]] });
  });

  it("concurrent calls share one sync", async () => {
    const { session, doc, link, host } = await linkedSession();
    host.markEverythingDirty();
    host.set(W([1, 1, 1]), "minecraft:glass");
    await host.waitFor(() => link.isDirty());
    const head = doc.journal.headSeq;
    await Promise.all([session.runCall(call, () => ({ content: [] })), session.runCall(call, () => ({ content: [] }))]);
    expect(host.received.filter((m) => m.type === "hashes").length).toBe(1);
    expect(doc.journal.headSeq).toBe(head + 1);
  });

  it("a player edit in the context volume syncs, the agent still can't write there, and undo past the sync is refused", async () => {
    const { session, doc, link, host } = await linkedSession();
    // The root write rule (P): the work volume is local (0,0,0)–(7,7,7); the context is the rest.
    const work = Mask.fromBox(B([0, 0, 0], [7, 7, 7]));
    session.scopes.root = { work, context: Mask.fromBox(B([-3, -3, -3], [10, 10, 10])).subtract(work) };
    fill(doc, env, B([0, 0, 0], [0, 0, 0]), "dirt"); // an agent op before the player's edit
    host.playerSet(W([-2, 0, -2]), "minecraft:oak_log[axis=y]");
    await host.waitFor(() => link.isDirty());
    await session.runCall(call, () => ({ content: [] }));
    expect(at(doc, -2, 0, -2)).toBe("oak_log[axis=y]");
    try {
      fill(doc, env, B([-2, 1, -2], [-2, 1, -2]), "dirt");
      expect.unreachable();
    } catch (e) {
      expect(refusalCode(e)).toBe("outside_work_volume");
    }
    try {
      doc.undo();
      expect.unreachable();
    } catch (e) {
      expect(refusalCode(e)).toBe("sync_barrier");
    }
    // Even forced: undoing that sync would write the context, which the agent never may.
    try {
      doc.undo({ overwriteHandEdits: true });
      expect.unreachable();
    } catch (e) {
      expect(refusalCode(e)).toBe("outside_work_volume");
    }
  });

  it("the manual sync (world_sync) picks up a contents-only change no dirty notice reports", async () => {
    const { doc, link, host } = await linkedSession();
    expect(await link.syncNow("manual")).toBeUndefined(); // already in step
    host.playerSet(W([3, 0, 3]), "minecraft:chest[facing=north,type=single,waterlogged=false]");
    await host.waitFor(() => link.isDirty());
    await link.syncNow("dirty");
    host.playerSetNbt(W([3, 0, 3]), { type: "compound", value: { id: { type: "string", value: "minecraft:chest" }, Items: { type: "list", value: { type: "end", value: [] } } } });
    expect(link.isDirty()).toBe(false);
    const r = await link.syncNow("manual");
    expect(r?.changed).toBe(1);
    expect(doc.getBlockEntity(3, 0, 3)?.value.id).toEqual({ type: "string", value: "minecraft:chest" });
  });
});
