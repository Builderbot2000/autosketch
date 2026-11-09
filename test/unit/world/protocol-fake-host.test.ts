import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { decodeMessage, encodeMessage } from "../../../src/world/protocol/codec.js";
import { FrameReader } from "../../../src/world/protocol/frame.js";
import { DEFAULT_VOLATILE, nbtHash, sectionHashes } from "../../../src/world/protocol/hash.js";
import type { McpMessage, ModMessage, PatchAck, SnapshotResult, VolumesMessage, WireBox } from "../../../src/world/protocol/messages.js";
import { readPairing } from "../../../src/world/protocol/pairing.js";
import { parseSnbt } from "../../../src/world/protocol/snbt.js";
import { FakeHost } from "../../support/fake-host.js";

/** A bare protocol client standing in for the MCP side (silo P builds the real one). */
class Client {
  readonly inbox: ModMessage[] = [];
  closed = false;
  private nextId = 1;
  private constructor(readonly socket: Socket) {
    const reader = new FrameReader();
    socket.on("data", (c) => {
      for (const f of reader.push(c)) this.inbox.push(decodeMessage(f, "mod"));
    });
    socket.on("close", () => (this.closed = true));
    socket.on("error", () => {});
  }

  static async open(host: FakeHost, hello: Partial<Extract<McpMessage, { type: "hello" }>> = {}): Promise<Client> {
    const p = await readPairing(host.instanceDir);
    const socket = connect(p.port, p.host);
    await new Promise<void>((r) => socket.once("connect", () => r()));
    const c = new Client(socket);
    c.send({ type: "hello", protocol: p.protocol, token: p.token, client: { name: "test", version: "0" }, volatile: DEFAULT_VOLATILE, ...hello });
    return c;
  }

  send(m: McpMessage): void {
    this.socket.write(encodeMessage(m));
  }

  id(): number {
    return this.nextId++;
  }

  async next<T extends ModMessage["type"]>(type: T, pred: (m: Extract<ModMessage, { type: T }>) => boolean = () => true): Promise<Extract<ModMessage, { type: T }>> {
    const end = Date.now() + 2000;
    for (;;) {
      const i = this.inbox.findIndex((m) => m.type === type && pred(m as Extract<ModMessage, { type: T }>));
      if (i >= 0) return this.inbox.splice(i, 1)[0] as Extract<ModMessage, { type: T }>;
      if (Date.now() > end) throw new Error(`no ${type} (inbox: ${this.inbox.map((m) => m.type).join(", ")})`);
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  async waitClosed(): Promise<void> {
    const end = Date.now() + 2000;
    while (!this.closed) {
      if (Date.now() > end) throw new Error("socket still open");
      await new Promise((r) => setTimeout(r, 2));
    }
  }

  close(): void {
    this.socket.destroy();
  }
}

const OW = "minecraft:overworld";
const work: WireBox = { min: [0, 64, 0], max: [7, 67, 7] };
const STONE = "minecraft:stone";
const PLANKS = "minecraft:oak_planks";
const CHEST = "minecraft:chest[facing=north,type=single,waterlogged=false]";
const FURNACE = "minecraft:furnace[facing=north,lit=true]";

let hosts: FakeHost[] = [];
let clients: Client[] = [];
afterEach(async () => {
  for (const c of clients) c.close();
  for (const h of hosts) await h.close();
  hosts = [];
  clients = [];
});

async function setup(opts: Parameters<typeof FakeHost.start>[0] = {}) {
  const host = await FakeHost.start({ volumes: { work }, ...opts });
  hosts.push(host);
  for (let x = 0; x < 8; x++) for (let z = 0; z < 8; z++) host.set([x, 64, z], STONE);
  const client = await Client.open(host);
  clients.push(client);
  const hello = await client.next("hello");
  const volumes = await client.next("volumes");
  return { host, client, hello, volumes };
}

function cacheFrom(snap: SnapshotResult) {
  const cache = new Map<string, { state: string; nbt?: import("prismarine-nbt").Compound }>();
  for (const r of snap.regions) {
    let i = 0;
    for (let y = r.box.min[1]; y <= r.box.max[1]; y++) for (let z = r.box.min[2]; z <= r.box.max[2]; z++) for (let x = r.box.min[0]; x <= r.box.max[0]; x++) cache.set(`${x},${y},${z}`, { state: snap.palette[r.states[i++]!]! });
  }
  for (const r of snap.regions) for (const be of r.blockEntities) cache.get(be.pos.join(","))!.nbt = be.nbt;
  return cache;
}

describe("fake host", () => {
  it("runs the happy path: hello, volumes, snapshot, patch with one skip, ack, dirty", async () => {
    const { host, client, hello, volumes } = await setup();
    expect(hello).toMatchObject({ protocol: 1, singleplayer: true, game: { dataVersion: 3955 } });
    expect(volumes).toEqual({ type: "volumes", link: 1, dimension: OW, work, context: [{ min: [-3, 61, -3], max: [10, 70, 10] }] });
    expect(host.volatile).toEqual(DEFAULT_VOLATILE);

    const v = volumes as Extract<VolumesMessage, { dimension: string }>;
    const sid = client.id();
    client.send({ type: "snapshot", id: sid, dimension: OW, boxes: [v.work, ...v.context] });
    const snap = await client.next("snapshot.result", (m) => m.id === sid);
    expect(snap.regions.map((r) => r.box)).toEqual([v.work, ...v.context]);
    const cache = cacheFrom(snap);
    expect(cache.get("3,64,3")!.state).toBe(STONE);
    expect(cache.get("3,65,3")!.state).toBe("minecraft:air");

    host.playerSet([1, 64, 0], PLANKS); // a hand edit the cache doesn't know yet
    const dirty = await client.next("dirty");
    expect(dirty).toEqual({ type: "dirty", everything: false, blocks: [{ pos: [1, 64, 0], state: PLANKS }] });

    const pid = client.id();
    client.send({
      type: "patch",
      id: pid,
      link: volumes.link,
      dimension: OW,
      blocks: [
        { pos: [0, 64, 0], expected: STONE, state: "minecraft:glass" },
        { pos: [1, 64, 0], expected: STONE, state: "minecraft:glass" },
        { pos: [0, 65, 0], expected: "minecraft:air", state: "minecraft:glass" },
      ],
    });
    const ack = await client.next("patch.ack", (m) => m.id === pid);
    expect(ack).toEqual({ type: "patch.ack", id: pid, applied: 2, overwritten: 0, skipped: [{ pos: [1, 64, 0], state: PLANKS }], rejected: [], normalized: [] });
    expect(host.get([0, 64, 0]).state).toBe("minecraft:glass");
    expect(host.get([1, 64, 0]).state).toBe(PLANKS);
    expect(host.get([0, 65, 0]).state).toBe("minecraft:glass");
    expect(host.patchLog).toHaveLength(1);
    expect(client.inbox.filter((m) => m.type === "dirty")).toEqual([]); // the host's own writes are never dirty
  });

  it("refuses a wrong token and a protocol mismatch, then closes", async () => {
    const host = await FakeHost.start();
    hosts.push(host);
    const bad = await Client.open(host, { token: "0".repeat(64) });
    clients.push(bad);
    expect(await bad.next("error")).toMatchObject({ code: "bad_token", id: null });
    await bad.waitClosed();
    const old = await Client.open(host, { protocol: 2 });
    clients.push(old);
    expect(await old.next("error")).toMatchObject({ code: "protocol_mismatch", protocol: 1 });
    await old.waitClosed();
    expect(host.connected).toBe(false);
  });

  it("section hashes agree with a cache built from a snapshot, and catch contents-only edits", async () => {
    const { host, client, volumes } = await setup();
    const v = volumes as Extract<VolumesMessage, { dimension: string }>;
    host.set([2, 65, 2], CHEST, parseSnbt('{id:"minecraft:chest",Items:[]}'));
    const boxes = [v.work, ...v.context];
    const sid = client.id();
    client.send({ type: "snapshot", id: sid, dimension: OW, boxes });
    const cache = cacheFrom(await client.next("snapshot.result"));
    const mine = sectionHashes(boxes, (x, y, z) => cache.get(`${x},${y},${z}`) ?? { state: "minecraft:air" }, DEFAULT_VOLATILE);

    const hid = client.id();
    client.send({ type: "hashes", id: hid, dimension: OW, boxes });
    const theirs = await client.next("hashes.result", (m) => m.id === hid);
    expect(theirs.sections).toEqual(mine);
    expect(theirs.sections.map((s) => s.section)).toEqual([[-1, 3, -1], [0, 3, -1], [-1, 3, 0], [0, 3, 0], [-1, 4, -1], [0, 4, -1], [-1, 4, 0], [0, 4, 0]]);

    host.playerSetNbt([2, 65, 2], parseSnbt('{id:"minecraft:chest",Items:[{Slot:0b,id:"minecraft:stone",count:1}]}'));
    const hid2 = client.id();
    client.send({ type: "hashes", id: hid2, dimension: OW, boxes });
    const after = await client.next("hashes.result", (m) => m.id === hid2);
    const changed = after.sections.filter((s, i) => s.hash !== mine[i]!.hash).map((s) => s.section);
    expect(changed).toEqual([[0, 4, 0]]);
    expect(client.inbox.some((m) => m.type === "dirty")).toBe(false);
  });

  it("checks expected NBT hashes: volatile ticks pass, contents edits skip with the actual NBT", async () => {
    const { host, client } = await setup();
    const furnace = parseSnbt('{id:"minecraft:furnace",BurnTime:100s,CookTime:10s,Items:[]}');
    const chest = parseSnbt('{id:"minecraft:chest",Items:[]}');
    host.set([1, 65, 1], FURNACE, furnace);
    host.set([2, 65, 1], CHEST, chest);
    host.tick([1, 65, 1], parseSnbt("{BurnTime:40s,CookTime:70s}"));
    const edited = parseSnbt('{id:"minecraft:chest",Items:[{Slot:0b,id:"minecraft:diamond",count:64}]}');
    host.playerSetNbt([2, 65, 1], edited);
    const id = client.id();
    client.send({
      type: "patch",
      id,
      link: 1,
      dimension: OW,
      blocks: [
        { pos: [1, 65, 1], expected: FURNACE, expectedNbtHash: nbtHash(furnace, DEFAULT_VOLATILE)!, state: "minecraft:air" },
        { pos: [2, 65, 1], expected: CHEST, expectedNbtHash: nbtHash(chest, DEFAULT_VOLATILE)!, state: "minecraft:air" },
      ],
    });
    const ack = await client.next("patch.ack");
    expect(ack.applied).toBe(1);
    expect(ack.skipped).toHaveLength(1);
    expect(ack.skipped[0]!.pos).toEqual([2, 65, 1]);
    expect(ack.skipped[0]!.state).toBe(CHEST);
    expect(nbtHash(ack.skipped[0]!.nbt!, {})).toBe(nbtHash(edited, {}));
    expect(host.get([1, 65, 1]).state).toBe("minecraft:air");
    expect(host.get([1, 65, 1]).nbt).toBeUndefined();
  });

  it("rejects unknown states, positions outside the volumes and stale links; force overwrites and counts", async () => {
    const { host, client } = await setup({ knownStates: new Set([STONE, PLANKS, "minecraft:air", "minecraft:glass"]) });
    const send = async (patch: Omit<Extract<McpMessage, { type: "patch" }>, "type" | "id" | "dimension">): Promise<PatchAck> => {
      const id = client.id();
      client.send({ type: "patch", id, dimension: OW, ...patch });
      return client.next("patch.ack", (m) => m.id === id);
    };
    const a = await send({
      link: 1,
      blocks: [
        { pos: [0, 64, 0], expected: STONE, state: "modded:thing" },
        { pos: [0, 64, 1], expected: STONE, state: "oak_planks" },
        { pos: [50, 64, 0], expected: "minecraft:air", state: STONE },
        { pos: [-2, 64, 0], expected: "minecraft:air", state: STONE },
      ],
    });
    expect(a.rejected).toEqual([
      { pos: [-2, 64, 0], reason: "outside_volumes" }, // in the context: patches never write context
      { pos: [0, 64, 0], reason: "unknown_state" },
      { pos: [50, 64, 0], reason: "outside_volumes" },
      { pos: [0, 64, 1], reason: "unknown_state" },
    ]); // listed in grid order: x fastest, then z, then y
    expect(a.applied).toBe(0);
    expect(host.get([-2, 64, 0]).state).toBe("minecraft:air");
    expect(host.get([0, 64, 0]).state).toBe(STONE);

    host.set([3, 64, 3], PLANKS);
    const f = await send({
      link: 1,
      force: true,
      blocks: [
        { pos: [3, 64, 3], expected: STONE, state: "minecraft:glass" },
        { pos: [4, 64, 3], expected: STONE, state: "minecraft:glass" },
      ],
    });
    expect(f).toMatchObject({ applied: 2, overwritten: 1, skipped: [] });
    expect(host.get([3, 64, 3]).state).toBe("minecraft:glass");

    host.setVolumes({ work: { min: [100, 64, 100], max: [107, 70, 107] } });
    const vol = await client.next("volumes");
    expect(vol.link).toBe(2);
    const s = await send({ link: 1, blocks: [{ pos: [100, 64, 100], expected: "minecraft:air", state: STONE }] });
    expect(s.rejected).toEqual([{ pos: [100, 64, 100], reason: "stale_link" }]);
    host.setVolumes({ work: { min: [100, 64, 100], max: [107, 70, 107] }, context: [{ min: [90, 60, 90], max: [120, 80, 120] }] });
    expect((await client.next("volumes")).link).toBe(2); // context-only change keeps the link
    host.setVolumes(null);
    expect(await client.next("volumes")).toEqual({ type: "volumes", link: 3, work: null });
    const hid = client.id();
    client.send({ type: "hashes", id: hid, dimension: OW, boxes: [work] });
    expect(await client.next("error", (m) => m.id === hid)).toMatchObject({ code: "no_volumes" });
  });

  it("volumes.extend: writes in the extension are rejected before it and applied after; a bad extension is refused", async () => {
    const { host, client, volumes } = await setup({ volumes: { work, context: [{ min: [-1, 63, -1], max: [8, 68, 8] }] } });
    const beyond: [number, number, number] = [11, 65, 3]; // a multi-block part 4 blocks past the work box, outside the context too
    const patch = async () => {
      const id = client.id();
      client.send({ type: "patch", id, link: volumes.link, dimension: OW, blocks: [{ pos: beyond, expected: "minecraft:air", state: PLANKS }] });
      return client.next("patch.ack", (m) => m.id === id);
    };
    expect((await patch()).rejected).toEqual([{ pos: beyond, reason: "outside_volumes" }]);

    const bad = client.id();
    client.send({ type: "volumes.extend", id: bad, link: volumes.link, work: { min: [1, 64, 0], max: [11, 67, 7] } });
    expect(await client.next("error", (m) => m.id === bad)).toMatchObject({ code: "bad_extension" });
    const stale = client.id();
    client.send({ type: "volumes.extend", id: stale, link: volumes.link + 1, work: { min: [0, 64, 0], max: [11, 67, 7] } });
    expect(await client.next("error", (m) => m.id === stale)).toMatchObject({ code: "stale_link" });
    expect(host.extended).toBeNull();

    const extended = { min: [0, 64, 0], max: [11, 67, 7] } as WireBox;
    client.send({ type: "volumes.extend", id: client.id(), link: volumes.link, work: extended });
    const v = await client.next("volumes");
    expect(v).toMatchObject({ link: volumes.link, work, extended }); // the link stays: the MCP caused the extension
    expect((await patch())).toMatchObject({ applied: 1, rejected: [] });
    expect(host.get(beyond).state).toBe(PLANKS);

    host.setVolumes({ work: { min: [0, 64, 0], max: [7, 68, 7] } }); // the player changes the work volume: new link, extension gone
    const after = await client.next("volumes");
    expect(after.link).toBe(volumes.link + 1);
    expect("extended" in after).toBe(false);
    expect(host.extended).toBeNull();
  });

  it("reports NBT the game normalized on load", async () => {
    const { host, client } = await setup({
      normalizeNbt: (_pos, state, nbt) => (state.startsWith("minecraft:chest") ? { type: "compound", value: { Items: { type: "list", value: { type: "end", value: [] } } as never, ...(nbt?.value ?? {}), id: { type: "string", value: "minecraft:chest" } } } : nbt),
    });
    const id = client.id();
    client.send({
      type: "patch",
      id,
      link: 1,
      dimension: OW,
      blocks: [
        { pos: [1, 65, 1], expected: "minecraft:air", state: CHEST },
        { pos: [2, 65, 1], expected: "minecraft:air", state: CHEST, nbt: parseSnbt('{id:"minecraft:chest",Items:[]}') },
      ],
    });
    const ack = await client.next("patch.ack");
    expect(ack.applied).toBe(2);
    expect(ack.normalized).toHaveLength(1);
    expect(ack.normalized[0]!.pos).toEqual([1, 65, 1]);
    expect(ack.normalized[0]!.nbt!.value.id).toEqual({ type: "string", value: "minecraft:chest" });
  });

  it("dirty: positions up to the cap, everything past it, nothing outside the volumes", async () => {
    const { host, client } = await setup({ dirtyCap: 4 });
    host.playerSet([500, 64, 500], STONE);
    host.playerSetMany([0, 1, 2, 3, 4].map((x) => ({ pos: [x, 66, 0] as [number, number, number], state: PLANKS })));
    host.playerSetMany([0, 1].map((x) => ({ pos: [x, 67, 0] as [number, number, number], state: PLANKS })));
    host.markEverythingDirty();
    expect(await client.next("dirty")).toEqual({ type: "dirty", everything: true });
    const d = await client.next("dirty");
    expect(d.everything === false && d.blocks.map((b) => b.pos)).toEqual([
      [0, 67, 0],
      [1, 67, 0],
    ]);
    expect(await client.next("dirty")).toEqual({ type: "dirty", everything: true });
  });

  it("delivers in-game prompts and records chat and notices", async () => {
    const { host, client } = await setup();
    const asked = host.playerAsk({ name: "Kev", uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" }, "put a balcony here", { target: { pos: [3, 64, 3], state: STONE, face: "up" } });
    const prompt = await client.next("prompt");
    expect(prompt).toMatchObject({ text: "put a balcony here", player: { name: "Kev" }, context: { dimension: OW, target: { pos: [3, 64, 3], face: "up" } } });
    client.send({ type: "prompt.result", id: prompt.id, delivered: false, reason: "not_allowed" });
    expect(await asked).toEqual({ type: "prompt.result", id: prompt.id, delivered: false, reason: "not_allowed" });
    client.send({ type: "chat", request: prompt.id, player: prompt.player.uuid, kind: "reply", lines: ["done"] });
    client.send({ type: "notice", text: "Autosketch: 3 placed", player: null });
    await host.waitFor(() => host.chats.length === 1 && host.notices.length === 1);
    expect(host.chats[0]!.lines).toEqual(["done"]);
  });

  it("holds later requests behind a patch in progress, as the mod does", async () => {
    const { host, client } = await setup();
    let release!: () => void;
    host.beforePatch = () => new Promise<void>((r) => (release = r));
    const pid = client.id();
    client.send({ type: "patch", id: pid, link: 1, dimension: OW, blocks: [{ pos: [5, 65, 5], expected: "minecraft:air", state: PLANKS }] });
    const sid = client.id();
    client.send({ type: "snapshot", id: sid, dimension: OW, boxes: [{ min: [5, 65, 5], max: [5, 65, 5] }] });
    await host.waitFor(() => release !== undefined);
    host.playerSet([6, 65, 5], STONE); // dirty interleaves while the patch is held
    expect((await client.next("dirty")).everything).toBe(false);
    expect(client.inbox.some((m) => m.type === "snapshot.result")).toBe(false);
    client.send({ type: "notice", text: "not held", player: null }); // id-less messages don't wait behind the patch
    await host.waitFor(() => host.notices.some((n) => n.text === "not held"));
    expect(client.inbox.some((m) => m.type === "patch.ack")).toBe(false);
    release();
    await client.next("patch.ack");
    const snap = await client.next("snapshot.result");
    expect(snap.palette).toEqual([PLANKS]);
  });

  it("answers invalid messages by id and stays open; closes on an undecodable header", async () => {
    const { client } = await setup();
    const frame = (header: string) => {
      const h = Buffer.from(header);
      const out = Buffer.alloc(8 + h.length);
      out.writeUInt32BE(4 + h.length, 0);
      out.writeUInt32BE(h.length, 4);
      h.copy(out, 8);
      return out;
    };
    client.socket.write(frame('{"type":"hashes","id":40,"dimension":"minecraft:overworld"}'));
    expect(await client.next("error", (m) => m.id === 40)).toMatchObject({ code: "bad_request" });
    client.socket.write(frame('{"type":"notice","text":5,"player":null}'));
    expect(await client.next("error", (m) => m.id === null)).toMatchObject({ code: "bad_request" });
    expect(client.closed).toBe(false);
    client.socket.write(frame("{not json"));
    expect(await client.next("error", (m) => m.id === null)).toMatchObject({ code: "bad_request" });
    await client.waitClosed();
  });

  it("reads positions outside the build height as air", async () => {
    const { host, client } = await setup({ volumes: { work: { min: [0, 300, 0], max: [3, 319, 3] } } });
    host.world.set("1,320,1", { state: STONE }); // can't exist in the game; the host must not report it
    const id = client.id();
    client.send({ type: "snapshot", id, dimension: OW, sections: [[0, 20, 0]] });
    const snap = await client.next("snapshot.result", (m) => m.id === id);
    expect(snap.palette).toEqual(["minecraft:air"]);
  });

  it("survives dropped connections, replacement and restarts", async () => {
    const { host, client } = await setup();
    const second = await Client.open(host);
    clients.push(second);
    await second.next("hello");
    expect(await client.next("error")).toMatchObject({ code: "replaced" });
    await client.waitClosed();
    expect(host.connected).toBe(true);
    expect(host.connections).toBe(2);

    host.dropConnection();
    await second.waitClosed();
    const third = await Client.open(host);
    clients.push(third);
    await third.next("volumes");

    const before = await readPairing(host.instanceDir);
    host.set([7, 66, 7], PLANKS);
    await host.restart();
    await third.waitClosed();
    const after = await readPairing(host.instanceDir);
    expect(after.token).not.toBe(before.token);
    expect(after.port).not.toBe(before.port);
    const fourth = await Client.open(host);
    clients.push(fourth);
    expect((await fourth.next("volumes")) as unknown).toMatchObject({ work });
    expect(host.get([7, 66, 7]).state).toBe(PLANKS);
  });
});
