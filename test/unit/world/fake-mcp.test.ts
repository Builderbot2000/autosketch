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

  it("candidates (17, piece 3): a reply's clickable line sends candidates.open, answered from the table", async () => {
    const h = await host();
    const entries = [{ cell: "B2", prefab: "gothic_tower_a", root: "user", size: [7, 24, 7], tags: ["tower"], notes: null }];
    const mcp = await FakeMcp.connect({
      pairing: pairingPath(h.instanceDir),
      script: {
        send: [{ type: "chat", request: 12, player: KEV.uuid, kind: "reply", lines: ["Here are towers.", "[Show candidates]"], action: { line: 1, kind: "candidates.open", args: { id: "c1" } } }],
        results: {
          "candidates.open": { ok: true, result: { id: "c1", request: 12, question: "show me a tower", entries } },
          "candidates.ghost": { ok: true, result: { ghost: "candidate" } },
          "candidates.ghost.clear": { ok: true, result: {} },
          "candidates.submit": { ok: false, error: "answered", message: "already answered" },
        },
      },
    });
    cleanup.push(() => mcp.close());
    await h.waitFor(() => h.chats.length === 1);
    expect(await h.playerClick(KEV, h.chats[0]!)).toMatchObject({ ok: true, result: { id: "c1", request: 12, entries } });
    expect(await h.playerUiRequest(KEV, { kind: "candidates.ghost", args: { id: "c1", prefab: "gothic_tower_a", dimension: "minecraft:overworld", at: [1, 64, 2], rotate: 90 } })).toMatchObject({ ok: true, result: { ghost: "candidate" } });
    expect(await h.playerUiRequest(KEV, { kind: "candidates.ghost.clear" })).toMatchObject({ ok: true, result: {} });
    expect(await h.playerUiRequest(KEV, { kind: "candidates.submit", args: { id: "c1", picks: [{ prefab: "gothic_tower_a", cell: "B2" }] } })).toMatchObject({ ok: false, error: "answered" });
    expect(mcp.uiRequests.map((r) => [r.kind, r.args])).toEqual([
      ["candidates.open", { id: "c1" }],
      ["candidates.ghost", { id: "c1", prefab: "gothic_tower_a", dimension: "minecraft:overworld", at: [1, 64, 2], rotate: 90 }],
      ["candidates.ghost.clear", {}],
      ["candidates.submit", { id: "c1", picks: [{ prefab: "gothic_tower_a", cell: "B2" }] }],
    ]);
    expect(() => h.playerClick(KEV, { type: "chat", request: 12, player: KEV.uuid, kind: "reply", lines: ["plain"] })).toThrow();
  });

  it("library editors and save flash (17, pieces 6 and 8): writes answered from the table, a save flash sent like any flash", async () => {
    const h = await host();
    const flash = { job: "save", colour: "#ffffff", dimension: "minecraft:overworld", boxes: [{ min: [1, 64, 2], max: [7, 80, 8] }] as { min: [number, number, number]; max: [number, number, number] }[] };
    const mcp = await FakeMcp.connect({
      pairing: pairingPath(h.instanceDir),
      script: {
        send: [{ type: "ui.flash", players: [KEV.uuid], flashes: [flash] }],
        results: {
          "library.write.prefab": { ok: false, error: "conflict", message: "changed since it was opened" },
          "library.write.palette": { ok: true, result: { hash: "b".repeat(64), warnings: [] } },
          "library.write.procedure": { ok: true, result: { hash: "c".repeat(64) } },
          "library.write.knowledge": { ok: true, result: { hash: "d".repeat(64) } },
        },
      },
    });
    cleanup.push(() => mcp.close());
    await h.waitFor(() => h.ui.some((m) => m.type === "ui.flash"));
    expect(h.ui.find((m) => m.type === "ui.flash")).toMatchObject({ flashes: [flash] });
    const at = { root: "user", name: "towers/round", hash: "a".repeat(64) };
    expect(await h.playerUiRequest(KEV, { kind: "library.write.prefab", args: { ...at, name: "gothic_tower_a", meta: { tags: ["tower"] } } })).toMatchObject({ ok: false, error: "conflict" });
    expect(await h.playerUiRequest(KEV, { kind: "library.write.palette", args: { ...at, name: "castle", tags: ["grey"] } })).toMatchObject({ ok: true, result: { hash: "b".repeat(64) } });
    expect(await h.playerUiRequest(KEV, { kind: "library.write.procedure", args: { ...at, text: "x" } })).toMatchObject({ ok: true, result: { hash: "c".repeat(64) } });
    expect(await h.playerUiRequest(KEV, { kind: "library.write.knowledge", args: { ...at, name: "kits/k", text: "---\nkind: kit\n---\n" } })).toMatchObject({ ok: true, result: { hash: "d".repeat(64) } });
    expect(mcp.uiRequests.map((r) => r.kind)).toEqual(["library.write.prefab", "library.write.palette", "library.write.procedure", "library.write.knowledge"]);
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
