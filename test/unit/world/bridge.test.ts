import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Vec3 } from "../../../src/core/region.js";
import { Bridge, BridgeError } from "../../../src/world/bridge.js";
import { DEFAULT_VOLATILE } from "../../../src/world/protocol/hash.js";
import { writePairing } from "../../../src/world/protocol/pairing.js";
import { FakeHost } from "../../support/fake-host.js";

const roots: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "autosketch-bridge-"));
  roots.push(d);
  return d;
};
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("bridge client (13, W1)", () => {
  let host: FakeHost | undefined;
  let bridge: Bridge | undefined;
  afterEach(async () => {
    bridge?.close();
    await host?.close();
    host = bridge = undefined;
  });

  const volumes = { work: { min: [100, 64, -200] as Vec3, max: [109, 73, -191] as Vec3 } };

  it("pairs with the token, sends the volatile list, and keeps the mod's hello and volumes", async () => {
    host = await FakeHost.start({ volumes });
    bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE });
    const hello = await bridge.connect();
    expect(hello.game.dataVersion).toBeGreaterThan(0);
    expect(host.volatile).toEqual(DEFAULT_VOLATILE);
    await host.waitFor(() => bridge!.volumes);
    expect(bridge.volumes).toMatchObject({ type: "volumes", link: host.link, work: volumes.work });
  });

  it("matches responses to requests, including volumes.extend's id-less success and its refusals", async () => {
    host = await FakeHost.start({ volumes });
    bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE });
    await bridge.connect();
    const v = await host.waitFor(() => bridge!.volumes);
    host.set([100, 64, -200], "minecraft:air");
    const ack = await bridge.request({ type: "patch", link: v.link, dimension: "minecraft:overworld", blocks: [{ pos: [100, 64, -200], expected: "minecraft:air", state: "minecraft:stone" }] });
    expect(ack).toMatchObject({ type: "patch.ack", applied: 1, skipped: [], rejected: [] });
    expect(host.get([100, 64, -200]).state).toBe("minecraft:stone");
    const hashes = await bridge.request({ type: "hashes", dimension: "minecraft:overworld", boxes: [volumes.work] });
    expect(hashes.sections.length).toBeGreaterThan(0);
    const ext = await bridge.request({ type: "volumes.extend", link: v.link, work: { min: [100, 64, -200], max: [109, 74, -191] } });
    expect(ext.work !== null && ext.extended).toEqual({ min: [100, 64, -200], max: [109, 74, -191] });
    const bad = await bridge.request({ type: "volumes.extend", link: v.link, work: { min: [101, 64, -200], max: [109, 74, -191] } }).catch((e: BridgeError) => e);
    expect(bad).toBeInstanceOf(BridgeError);
    expect((bad as BridgeError).refusal).toBe("bad_extension");
    const stale = await bridge.request({ type: "volumes.extend", link: v.link + 7, work: volumes.work }).catch((e: BridgeError) => e.refusal);
    expect(stale).toBe("stale_link");
  });

  it("drops requests on disconnect instead of queueing them, and reconnects after a game restart", async () => {
    host = await FakeHost.start({ volumes });
    bridge = new Bridge({ instanceDir: host.instanceDir, volatile: DEFAULT_VOLATILE, backoff: { minMs: 20, maxMs: 50 } });
    const states: string[] = [];
    bridge.onConnection((s) => states.push(s));
    await bridge.connect();
    const v = await host.waitFor(() => bridge!.volumes);
    let release!: () => void;
    host.beforePatch = () => new Promise<void>((r) => (release = r));
    const inFlight = bridge.request({ type: "patch", link: v.link, dimension: "minecraft:overworld", blocks: [{ pos: [101, 64, -200], expected: "minecraft:air", state: "minecraft:stone" }] }).catch((e: BridgeError) => e.refusal);
    await host.waitFor(() => host!.patchLog.length === 0 && release !== undefined);
    await host.restart();
    expect(await inFlight).toBe("world_disconnected");
    release();
    host.beforePatch = undefined;
    expect(await bridge.request({ type: "hashes", dimension: "minecraft:overworld", boxes: [volumes.work] }).catch((e: BridgeError) => e.refusal)).toBe("world_disconnected");
    await host.waitFor(() => bridge!.connected, 3000);
    expect(states).toEqual(["up", "down", "up"]);
    // The host finished the patch in progress (its ack was lost), and nothing was replayed.
    expect(host.patchLog).toHaveLength(1);
    expect(host.received.filter((m) => m.type === "patch")).toHaveLength(1);
  });

  it("explains a missing pairing file and an unreachable port, naming WSL mirrored networking", async () => {
    const dir = tempDir();
    const missing = await new Bridge({ instanceDir: dir, volatile: {} }).connect().catch((e: Error) => e.message);
    expect(missing).toContain("No pairing file");
    host = await FakeHost.start({ instanceDir: dir });
    const port = host.port;
    await host.restart(); // the old port is closed, but write the old one back into the pairing file
    await writePairing(dir, { protocol: 1, host: "127.0.0.1", port, token: host.token });
    const unreachable = await new Bridge({ instanceDir: dir, volatile: {}, reconnect: false }).connect().catch((e: BridgeError) => e);
    expect((unreachable as BridgeError).refusal).toBe("world_disconnected");
    expect((unreachable as Error).message).toContain("networkingMode=mirrored");
  });

  it("reports a protocol mismatch without guessing around it", async () => {
    host = await FakeHost.start({ protocol: 2 });
    const msg = await new Bridge({ instanceDir: host.instanceDir, volatile: {}, reconnect: false }).connect().catch((e: Error) => e.message);
    expect(msg).toContain("protocol 2");
    expect(msg).toContain("update the Autosketch MCP server");
  });
});
