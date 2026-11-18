import { afterEach, describe, expect, it } from "vitest";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readConfig } from "../../../src/core/config.js";
import { Mask } from "../../../src/core/mask.js";
import { fromPublic, type Vec3 } from "../../../src/core/region.js";
import { Settings } from "../../../src/core/settings.js";
import { libraryRoots, starterRoot } from "../../../src/library/roots.js";
import { fill } from "../../../src/ops/edit.js";
import { PaletteBook } from "../../../src/palette/pick.js";
import { Session } from "../../../src/server/session.js";
import { startUi, type UiCore } from "../../../src/ui/index.js";
import { LiveLink } from "../../../src/world/live-link.js";
import { decodePreviewBody } from "../../../src/world/protocol/body.js";
import type { PlayerRef, ReplayFrame, UiGhost, UiMcpMessage, UiResult, UiState, WireBox } from "../../../src/world/protocol/messages.js";
import { syncLink } from "../../../src/world/sync.js";
import { FakeHost } from "../../support/fake-host.js";
import { solidPng, tempDir } from "../../helpers/fixtures.js";
import { vanillaRegistry } from "../../helpers/vanilla.js";
// Every area that declares settings, so the registry is the server's.
import "../../../src/assets/settings.js";
import "../../../src/server/settings.js";
import "../../../src/world/settings.js";

/** The MCP UI core against the fake host with `ui` (16, *Testing: MCP*; briefs/ui/M, *Done when*). */

const env = { registry: vanillaRegistry() };
const B = (min: Vec3, max: Vec3) => fromPublic({ min, max });
const WORK: WireBox = { min: [100, 64, -200], max: [131, 79, -169] }; // 32×16×32, local (0,0,0)–(31,15,31)
const HOST: PlayerRef = { name: "Dev", uuid: "00000000-0000-4000-8000-000000000001" };
const KEV: PlayerRef = { name: "Kev", uuid: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" };
const STRANGER: PlayerRef = { name: "Eve", uuid: "7c9e6679-7425-40de-944b-e07fc1f90ae7" };

let host: FakeHost | undefined;
let link: LiveLink | undefined;
let ui: UiCore | undefined;
afterEach(async () => {
  ui?.close();
  link?.close();
  await host?.close();
  host = link = ui = undefined;
});

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function setup(opts: { features?: string[] } = {}) {
  host = await FakeHost.start({ volumes: { work: WORK }, ...(opts.features ? { features: opts.features } : {}) });
  const workspace = await tempDir("autosketch-ui-ws-");
  const session = new Session(workspace);
  link = new LiveLink(session, { ackWaitMs: 500, backoff: { minMs: 20, maxMs: 50 }, features: ["prompt.close", "ui"] });
  link.setSync(syncLink);
  session.world = link;
  // A user library root with a prefab, a palette and a knowledge pack; the starter root read-only.
  const lib = await tempDir("autosketch-ui-lib-");
  await cp(join(starterRoot().path, "prefabs", "park_bench"), join(lib, "prefabs", "park_bench"), { recursive: true });
  await mkdir(join(lib, "palettes"), { recursive: true });
  await writeFile(join(lib, "palettes", "stone.json"), JSON.stringify({ name: "stone", roles: { wall: [{ block: "minecraft:stone", weight: 1 }] } }));
  await mkdir(join(lib, "knowledge"), { recursive: true });
  await writeFile(join(lib, "knowledge", "gothic.md"), "---\nkind: style\nsummary: Tall.\n---\nBody\n");
  const configPath = join(await tempDir("autosketch-ui-home-"), "config.toml");
  const settings = Settings.from([], {}, readConfig(configPath));
  const png = Buffer.from(solidPng([200, 10, 10], 4));
  ui = startUi({
    bridge: link.bridge,
    subscribe: (fn) => session.subscribe(fn),
    workspace,
    sessionId: "20261117T000000000Z-live",
    settings,
    configPath,
    promptPlayers: () => ["Kev"],
    library: { roots: () => libraryRoots({ workspace, env: { AUTOSKETCH_LIBRARY: lib }, settings: Settings.from([], {}, readConfig(configPath)) }), thumbnail: async () => png, registry: () => env.registry },
    baseDoc: () => session.doc,
    scopes: session.scopes,
    linkFrame: () => (link!.volumes ? { dimension: link!.volumes.dimension, origin: link!.volumes.origin } : undefined),
    intervalMs: 20,
  });
  await session.linkWorld({ instanceDir: host.instanceDir, plugins: [], palettes: new PaletteBook() });
  await until(() => host!.connected && host!.uiEnabled);
  return { session, host, configPath, png };
}

const ask = async (player: PlayerRef, kind: string, args: Record<string, unknown> = {}) => {
  const r = await host!.playerUiRequest(player, { kind, args });
  if ("local" in r) throw new Error(`not sent: ${r.local}`);
  return r;
};
const ok = (r: UiResult) => {
  if (!r.ok) throw new Error(`${r.error}: ${r.message}`);
  return r;
};

describe("against the fake host with ui", () => {
  it("a fork shows a job, its edits flash and update its ghost, a merge clears it", async () => {
    const { session, host } = await setup();
    await until(() => host.uiFor(HOST.uuid).some((m) => m.type === "ui.state"));
    const first = host.uiFor(HOST.uuid)[0] as UiState;
    expect(first).toMatchObject({ type: "ui.state", seq: 1, full: true, jobs: [] });
    const doc = session.doc!;
    const f = session.scopes.fork("base", { work: Mask.fromBox(B([8, 0, 8], [15, 7, 15])), brief: "west tower", env });
    await until(() => host.ui.some((m) => m.type === "ui.state" && (m.jobs ?? []).length > 0));
    const withJob = host.ui.find((m): m is UiState => m.type === "ui.state" && (m.jobs ?? []).length > 0)!;
    expect(withJob.jobs![0]).toMatchObject({ id: f.scope.id, brief: "west tower", dimension: "minecraft:overworld", work: { min: [108, 64, -192], max: [115, 71, -185] } });
    const from = host.ui.length;
    fill(f.scope.doc, env, B([0, 0, 0], [1, 0, 0]), "oak_planks");
    await until(() => host.ui.slice(from).some((m) => m.type === "ui.ghost") && host.ui.slice(from).some((m) => m.type === "ui.flash"));
    const flash = host.ui.slice(from).find((m) => m.type === "ui.flash")!;
    expect(flash).toMatchObject({ flashes: [{ job: f.scope.id, boxes: [{ min: [108, 64, -192], max: [109, 64, -192] }] }] });
    const ghost = host.ui.slice(from).filter((m): m is UiGhost => m.type === "ui.ghost").at(-1)!;
    expect(ghost).toMatchObject({ ghost: f.scope.id, origin: [108, 64, -192], players: [HOST.uuid] });
    const at = host.ui.length;
    session.scopes.merge(f.scope.id, "done", env);
    await until(() => host.ui.slice(at).some((m) => m.type === "ui.state" && (m.removed ?? []).includes(f.scope.id)));
    expect(host.ui.slice(at).some((m) => m.type === "ui.ghost.clear" && m.ghost === f.scope.id)).toBe(true);
    expect(doc.getState(8, 0, 8)).toBe("minecraft:oak_planks");
  });

  it("refuses players not on the allowlist, and unknown kinds; resync sends the full state, then the result", async () => {
    const { host } = await setup();
    const no = await ask(STRANGER, "settings.list");
    expect(no).toMatchObject({ ok: false, error: "not_allowed" });
    expect((await ask(HOST, "nope")).ok).toBe(false);
    // `17`'s candidates kinds are on the wire (W1) but not served yet (silo Q): bad_request, as for an MCP without them.
    for (const kind of ["candidates.open", "candidates.ghost", "candidates.ghost.clear", "candidates.submit"]) expect(await ask(HOST, kind, { id: "c1" })).toMatchObject({ ok: false, error: "bad_request" });
    const from = host.ui.length;
    ok(await ask(KEV, "resync"));
    const after = host.ui.slice(from);
    const full = after.findIndex((m) => m.type === "ui.state" && m.full && m.players.length === 1 && m.players[0] === KEV.uuid);
    const result = after.findIndex((m) => m.type === "ui.result");
    expect(full).toBeGreaterThanOrEqual(0);
    expect(full).toBeLessThan(result);
    // Kev is now known by name, so the overlays include him.
    await until(() => host.ui.some((m) => m.type === "ui.state" && m.players.includes(KEV.uuid) && m.players.includes(HOST.uuid)));
  });

  it("settings: list, set and unset with the hash; conflict on a stale one; bad values refused", async () => {
    const { configPath } = await setup();
    const list = ok(await ask(HOST, "settings.list")).result as { hash: string; path: string; settings: { key: string }[] };
    expect(list.path).toBe(configPath);
    expect(list.settings.some((s) => s.key === "scope.maxDepth")).toBe(true);
    const set = ok(await ask(HOST, "settings.set", { key: "scope.maxDepth", value: "2", hash: list.hash })).result as { hash: string };
    expect(readConfig(configPath).config.settings["scope.maxDepth"]).toBe("2");
    expect(set.hash).toBe(readConfig(configPath).hash);
    expect(await ask(HOST, "settings.set", { key: "scope.maxDepth", value: "3", hash: list.hash })).toMatchObject({ ok: false, error: "conflict" });
    expect(await ask(HOST, "settings.set", { key: "scope.maxDepth", value: "deep", hash: set.hash })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await ask(HOST, "settings.set", { key: "no.such", value: "1", hash: set.hash })).toMatchObject({ ok: false, error: "not_found" });
    const unset = ok(await ask(HOST, "settings.unset", { key: "scope.maxDepth", hash: set.hash })).result as { hash: string };
    expect(readConfig(configPath).config.settings["scope.maxDepth"]).toBeUndefined();
    expect(unset.hash).toBe(readConfig(configPath).hash);
  });

  it("library: list, entry, thumbnail, preview, rename, duplicate, delete, trash, restore, hide, copy, empty trash", async () => {
    const { configPath, png } = await setup();
    const v = ok(await ask(HOST, "library.list")).result as { roots: { label: string; writable: boolean; counts: Record<string, number> }[]; entries: Record<string, { name: string; root: string; hidden: boolean }[]> };
    expect(v.roots.map((r) => [r.label, r.writable])).toEqual([["user", true], ["starter", false]]);
    expect(v.roots[0]!.counts).toMatchObject({ prefabs: 1, palettes: 1, knowledge: 1 });
    const entry = ok(await ask(HOST, "library.entry", { root: "user", kind: "knowledge", name: "gothic" })).result;
    expect(entry).toMatchObject({ name: "gothic", text: expect.stringContaining("Body"), editable: true, hash: expect.any(String) });
    expect(await ask(HOST, "library.entry", { root: "user", kind: "knowledge", name: "../../etc" })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await ask(HOST, "library.entry", { root: "user", kind: "knowledge", name: "nope" })).toMatchObject({ ok: false, error: "not_found" });

    const thumb = ok(await ask(HOST, "library.thumbnail", { root: "user", name: "park_bench" }));
    expect(thumb.result).toEqual({ format: "png", width: 4, height: 4 });
    expect(Buffer.from((thumb as { body: Uint8Array }).body)).toEqual(png);
    const prev = ok(await ask(HOST, "library.preview", { root: "user", name: "park_bench" })) as UiResult & { ok: true; body: Uint8Array };
    const size = prev.result.size as Vec3;
    const decoded = decodePreviewBody(prev.body, size);
    expect(decoded.states).toHaveLength(size[0] * size[1] * size[2]);
    expect(decoded.palette.some((s) => s !== "minecraft:air")).toBe(true);

    expect(ok(await ask(HOST, "library.rename", { root: "user", kind: "palettes", name: "stone", to: "granite" })).result).toEqual({ name: "granite" });
    expect(ok(await ask(HOST, "library.duplicate", { root: "user", kind: "palettes", name: "granite", to: "stone" })).result).toEqual({ name: "stone" });
    expect(await ask(HOST, "library.rename", { root: "user", kind: "palettes", name: "stone", to: "../evil" })).toMatchObject({ ok: false, error: "bad_request" });
    const del = ok(await ask(HOST, "library.delete", { root: "user", kind: "palettes", name: "granite" })).result as { trashed: { id: string; name: string } };
    expect(del.trashed).toMatchObject({ kind: "palettes", name: "granite" });
    const trash = ok(await ask(HOST, "library.trash", { root: "user" })).result as { trash: { id: string }[] };
    expect(trash.trash.map((t) => t.id)).toEqual([del.trashed.id]);
    expect(ok(await ask(HOST, "library.restore", { root: "user", id: del.trashed.id })).result).toMatchObject({ restored: { name: "granite" } });

    const hash = (ok(await ask(HOST, "settings.list")).result as { hash: string }).hash;
    const hid = ok(await ask(HOST, "library.hide", { root: "starter", kind: "prefabs", name: "lamp_post", hidden: true, hash })).result as { hidden: boolean; hash: string };
    expect(hid.hidden).toBe(true);
    expect(readConfig(configPath).config.settings["library.hidden"]).toBe("prefabs/lamp_post");
    expect(await ask(HOST, "library.hide", { root: "starter", kind: "prefabs", name: "lamp_post", hidden: false, hash })).toMatchObject({ ok: false, error: "conflict" });
    ok(await ask(HOST, "library.hide", { root: "starter", kind: "prefabs", name: "lamp_post", hidden: false, hash: hid.hash }));
    expect(readConfig(configPath).config.settings["library.hidden"]).toBeUndefined();
    expect(await ask(HOST, "library.hide", { root: "user", kind: "palettes", name: "stone", hidden: true, hash: readConfig(configPath).hash })).toMatchObject({ ok: false, error: "bad_request" });

    expect(ok(await ask(HOST, "library.copy", { root: "starter", kind: "prefabs", name: "lamp_post" })).result).toEqual({ root: "user", name: "lamp_post" });
    ok(await ask(HOST, "library.delete", { root: "user", kind: "palettes", name: "granite" }));
    expect(ok(await ask(HOST, "library.empty_trash", { root: "user" })).result).toEqual({ emptied: 1 });
  });

  it("logs and replay: list, open (result then keyframe), seek (result then delta), close", async () => {
    const { session, host } = await setup();
    fill(session.doc!, env, B([0, 0, 0], [2, 0, 0]), "stone");
    // No observability in this test: no live log.
    expect(ok(await ask(HOST, "logs.list")).result).toEqual({ logs: [] });
    expect(await ask(HOST, "replay.open", { log: null })).toMatchObject({ ok: false, error: "not_found" });
    expect(await ask(HOST, "replay.open", {})).toMatchObject({ ok: false, error: "bad_request" });
    // A finished log in the workspace.
    const dir = join(session.workspace, "old", "observe", "20261101T000000000Z-old");
    await mkdir(dir, { recursive: true });
    const ev = (seq: number, e: object) => JSON.stringify({ v: 1, seq, t: 1_700_000_000_000 + seq, doc: "base", ...e });
    await writeFile(
      join(dir, "events.ndjson"),
      [
        ev(1, { kind: "session.open", name: "old", bounds: { min: [0, 0, 0], max: [1, 0, 0] }, delta: { offset: 0, length: 16 } }),
        ev(2, { kind: "state.add", id: 1, state: "minecraft:stone" }),
        ev(3, { kind: "doc.op", jseq: 1, op: "fill", summary: "", changed: 1, box: { min: [1, 0, 0], max: [1, 0, 0] }, counts: { placed: {}, removed: 0 }, delta: { offset: 16, length: 16 } }),
      ].join("\n") + "\n",
    );
    await writeFile(join(dir, "deltas.bin"), Buffer.from(new Int32Array([0, 0, 0, 1, 1, 0, 0, 1]).buffer));
    const logs = (ok(await ask(HOST, "logs.list")).result as { logs: { id: string; live: boolean; modified: string }[] }).logs;
    expect(logs).toEqual([{ id: "old/20261101T000000000Z-old", doc: "old", session: "20261101T000000000Z-old", modified: expect.stringMatching(/Z$/), live: false }]);
    const from = host.ui.length;
    const open = ok(await ask(HOST, "replay.open", { log: logs[0]!.id })).result as { replay: string; steps: number; step: number; volume: WireBox };
    expect(open).toEqual({ replay: expect.any(String), steps: 1, step: 0, dimension: "minecraft:overworld", volume: { min: [100, 64, -200], max: [101, 64, -200] } });
    await until(() => host.ui.slice(from).some((m) => m.type === "replay.frame"));
    const seq1 = host.ui.slice(from).map((m) => m.type);
    expect(seq1.indexOf("ui.result")).toBeLessThan(seq1.indexOf("replay.frame"));
    const key = host.ui.slice(from).find((m): m is ReplayFrame => m.type === "replay.frame")!;
    expect(key).toMatchObject({ keyframe: true, step: 0, steps: 1, players: [HOST.uuid] });
    const at = host.ui.length;
    expect(ok(await ask(HOST, "replay.seek", { replay: open.replay, step: 1 })).result).toEqual({ step: 1 });
    await until(() => host.ui.slice(at).some((m) => m.type === "replay.frame"));
    const delta = host.ui.slice(at).find((m): m is ReplayFrame => m.type === "replay.frame")!;
    expect(delta).toMatchObject({ keyframe: false, from: 0, step: 1, blocks: [{ pos: [101, 64, -200], state: "minecraft:stone" }] });
    expect(await ask(HOST, "replay.seek", { replay: open.replay, step: 9 })).toMatchObject({ ok: false, error: "bad_request" });
    expect(ok(await ask(HOST, "replay.close", { replay: open.replay })).result).toEqual({});
    expect(await ask(HOST, "replay.seek", { replay: open.replay, step: 0 })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("ghosts: anchor refused while linked; ghost.clear of a job id is not_found", async () => {
    await setup();
    expect(await ask(HOST, "ghost.anchor", { dimension: "minecraft:overworld", pos: [0, 70, 0] })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await ask(HOST, "ghost.anchor", { dimension: "minecraft:overworld", pos: [0, 70] })).toMatchObject({ ok: false, error: "bad_request" });
    expect(await ask(HOST, "ghost.clear", { ghost: "s1" })).toMatchObject({ ok: false, error: "not_found" });
  });

  it("sends nothing and answers nothing when the mod lacks ui", async () => {
    host = await FakeHost.start({ volumes: { work: WORK }, features: ["modes", "scan", "volumes.set"] });
    const session = new Session(await tempDir("autosketch-ui-ws-"));
    link = new LiveLink(session, { backoff: { minMs: 20, maxMs: 50 }, features: ["prompt.close", "ui"] });
    link.setSync(syncLink);
    session.world = link;
    ui = startUi({ bridge: link.bridge, subscribe: (fn) => session.subscribe(fn), workspace: session.workspace, sessionId: "s", settings: Settings.from([], {}, readConfig(join(session.workspace, "c.toml"))), configPath: join(session.workspace, "c.toml"), promptPlayers: () => [], library: { roots: () => [] }, baseDoc: () => session.doc, scopes: session.scopes, linkFrame: () => undefined, intervalMs: 20 });
    await session.linkWorld({ instanceDir: host.instanceDir, plugins: [], palettes: new PaletteBook() });
    fill(session.doc!, env, B([0, 0, 0], [0, 0, 0]), "stone");
    await new Promise((r) => setTimeout(r, 80));
    expect(host.ui).toEqual([] as UiMcpMessage[]);
    expect(host.uiUngated).toEqual([]);
    expect(await host.playerUiRequest(HOST, { kind: "resync" })).toEqual({ local: "mcp_outdated" });
  });
});

describe("against the fake host, unlinked", () => {
  it("anchors the open document's ghost at the player's position (result first), places jobs there, clears it", async () => {
    host = await FakeHost.start({ volumes: null });
    const session = new Session(await tempDir("autosketch-ui-ws-"));
    link = new LiveLink(session, { gameDir: host.instanceDir, backoff: { minMs: 20, maxMs: 50 }, features: ["prompt.close", "ui"] });
    session.world = link;
    const configPath = join(session.workspace, "c.toml");
    ui = startUi({ bridge: link.bridge, subscribe: (fn) => session.subscribe(fn), workspace: session.workspace, sessionId: "s", settings: Settings.from([], {}, readConfig(configPath)), configPath, promptPlayers: () => [], library: { roots: () => [] }, baseDoc: () => session.doc, scopes: session.scopes, linkFrame: () => undefined, intervalMs: 20 });
    expect(await (async () => {
      await link!.bridge.connect();
      await until(() => host!.uiEnabled);
      return ask(HOST, "ghost.anchor", { dimension: "minecraft:overworld", pos: [40, 70, 12] });
    })()).toMatchObject({ ok: false, error: "not_found" }); // no document open
    const { Document } = await import("../../../src/document/document.js");
    const doc = Document.create({ name: "hut", dataVersion: 3955, seed: 1 });
    fill(doc, env, B([0, 0, 0], [3, 0, 3]), "stone");
    await session.adopt(doc);
    const from = host.ui.length;
    expect(ok(await ask(HOST, "ghost.anchor", { dimension: "minecraft:overworld", pos: [40, 70, 12] })).result).toEqual({ ghost: "doc" });
    await until(() => host!.ui.slice(from).some((m) => m.type === "ui.ghost"));
    const types = host.ui.slice(from).map((m) => m.type);
    expect(types.indexOf("ui.result")).toBeLessThan(types.indexOf("ui.ghost"));
    const g = host.ui.slice(from).find((m): m is UiGhost => m.type === "ui.ghost")!;
    expect(g).toMatchObject({ ghost: "doc", origin: [40, 70, 12], full: true });
    expect(g.sections.length).toBe(1);
    const at = host.ui.length;
    expect(ok(await ask(HOST, "ghost.clear", { ghost: "doc" })).result).toEqual({});
    await until(() => host!.ui.slice(at).some((m) => m.type === "ui.ghost.clear"));
  });
});
