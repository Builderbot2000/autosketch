import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pairingPath } from "../../../src/world/protocol/pairing.js";
import type { UiGhost } from "../../../src/world/protocol/messages.js";
import { FakeHost } from "../../support/fake-host.js";
import { FakeMcp } from "../../support/fake-mcp.js";

/** The fake MCP (test/support/fake-mcp.ts), here played against the fake host standing in for the mod. */

const KEV = { name: "Kev", uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
const ROOT = join(import.meta.dirname, "../../..");

describe("fake MCP", () => {
  const cleanup: (() => unknown)[] = [];
  afterEach(async () => {
    for (const c of cleanup.splice(0).reverse()) await c();
  });

  async function host(features?: string[]) {
    const h = await FakeHost.start(features ? { features } : {});
    cleanup.push(() => h.close());
    return h;
  }

  it("says hello with the chosen features, sends its script and answers ui.requests from the table", async () => {
    const h = await host();
    const mcp = await FakeMcp.connect({
      pairing: pairingPath(h.instanceDir),
      script: {
        send: [
          { type: "ui.state", players: [KEV.uuid], seq: 1, full: true, jobs: [], request: null, tokens: null, refusal: null },
          { type: "ui.ghost", players: [KEV.uuid], ghost: "j1", dimension: "minecraft:overworld", origin: [0, 64, 0], tint: "#3fa7d6", full: true, palette: ["minecraft:air", "minecraft:stone"], sections: [{ section: [0, 0, 0], fill: "minecraft:stone" }] },
        ],
        replies: [{ on: "ui.request", kind: "resync", send: [{ type: "ui.state", players: [KEV.uuid], seq: 1, full: true, jobs: [], request: null, tokens: null, refusal: null }, { type: "ui.result", ok: true, result: {} }] }],
        results: { "logs.list": { ok: true, result: { logs: [] } }, "library.preview": { ok: false, error: "not_found", message: "no prefab x" } },
      },
    });
    cleanup.push(() => mcp.close());
    expect(h.mcpFeatures).toEqual(["prompt.close", "ui"]);
    expect(mcp.hello?.features).toContain("ui");
    await h.waitFor(() => h.ui.length === 2);
    const ghost = h.ui[1] as UiGhost;
    expect(ghost.palette).toEqual(["minecraft:stone"]); // first-use order: the unused air is dropped
    expect(ghost.sections[0]!.states.every((s) => s === 0)).toBe(true);

    expect(await h.playerUiRequest(KEV, { kind: "logs.list" })).toMatchObject({ ok: true, result: { logs: [] } });
    expect(await h.playerUiRequest(KEV, { kind: "library.preview", args: { root: "starter", name: "x" } })).toMatchObject({ ok: false, error: "not_found" });
    expect(await h.playerUiRequest(KEV, { kind: "settings.list" })).toMatchObject({ ok: false, error: "bad_request" });
    const before = h.ui.length;
    expect(await h.playerUiRequest(KEV, { kind: "resync" })).toMatchObject({ ok: true, request: 4 });
    expect(h.ui.slice(before).map((m) => m.type)).toEqual(["ui.state", "ui.result"]);
    expect(mcp.uiRequests.map((r) => r.kind)).toEqual(["logs.list", "library.preview", "settings.list", "resync"]);
  });

  it("plays an MCP that's too old: no ui in its hello, so the mod sends no ui.request", async () => {
    const h = await host();
    const mcp = await FakeMcp.connect({ pairing: pairingPath(h.instanceDir), script: { hello: { features: ["prompt.close"] } } });
    cleanup.push(() => mcp.close());
    expect(h.uiEnabled).toBe(false);
    expect(await h.playerUiRequest(KEV, { kind: "resync" })).toEqual({ local: "mcp_outdated" });
  });

  it("runs as a CLI: waits for the pairing file, records every message, stops on SIGTERM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fake-mcp-cli-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const script = join(dir, "script.json"), record = join(dir, "record.jsonl");
    await writeFile(script, JSON.stringify({ results: { "logs.list": { ok: true, result: { logs: [{ id: "a/b" }] } } } }));
    const h = await host();
    const child = spawn(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "test/support/fake-mcp.ts"), "--pairing", pairingPath(h.instanceDir), "--script", script, "--record", record], { stdio: ["ignore", "ignore", "pipe"] });
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    cleanup.push(() => child.kill("SIGKILL"));
    await h.waitFor(() => h.uiEnabled, 15_000);
    expect(await h.playerUiRequest(KEV, { kind: "logs.list" })).toMatchObject({ ok: true, result: { logs: [{ id: "a/b" }] } });
    child.kill("SIGTERM");
    expect(await exited).toBe(0);
    const lines = (await readFile(record, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.message.type)).toEqual(["hello", "volumes", "ui.request"]);
    expect(lines[2].message).toMatchObject({ kind: "logs.list", player: KEV });
  }, 30_000);
});
