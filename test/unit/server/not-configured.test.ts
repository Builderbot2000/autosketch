import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Candidate, Discovery } from "../../../src/assets/discover/index.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session, type InstanceSetup } from "../../../src/server/session.js";
import { AUTO_SOURCE, chooseAutomatically, makeInstanceSetup, notConfiguredText, setupCommand } from "../../../src/server/setup.js";
import { instanceSourceText } from "../../../src/server/tools/instance.js";
import { smallContext } from "../../helpers/context.js";

const workspace = mkdtempSync(join(tmpdir(), "autosketch-unconf-"));
afterAll(() => rmSync(workspace, { recursive: true, force: true }));

const candidate = (over: Partial<Candidate>): Candidate => ({
  id: "craftoria",
  name: "Craftoria",
  mcVersion: "1.21.1",
  loader: { name: "neoforge", version: "21.1.262" },
  launcher: "curseforge",
  folder: "/games/Craftoria",
  gameDir: "/games/Craftoria",
  via: "record",
  check: { ok: true, mods: 532, detail: "Minecraft 1.21.1, neoforge 21.1.262, 532 mod jars" },
  warnings: [],
  ...over,
});

const found: Discovery = {
  candidates: [
    candidate({ id: "broken", name: "Broken Pack", folder: "/games/My Broken Pack", launcher: "modrinth", loader: undefined, check: { ok: false, mods: 3, detail: "base game jar not found" } }),
    candidate({}),
  ],
  warnings: [],
};

async function connect(session: Session, ctx?: Promise<InstanceContext>) {
  const server = createServer(ctx, { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

type Content = { type: string; text?: string }[];
const textOf = (r: { content: unknown }) => (r.content as Content).map((c) => c.text ?? "").join("\n");

function stubSetup(over: Partial<InstanceSetup> = {}): InstanceSetup & { loads: string[] } {
  const loads: string[] = [];
  return {
    loads,
    load: async (path) => {
      loads.push(path);
      return smallContext();
    },
    notConfigured: async () => notConfiguredText(found),
    ...over,
  };
}

describe("not configured (14, Setup)", () => {
  it("answers not_configured from every tool but instance_info, with candidates and commands", async () => {
    const session = new Session(workspace);
    session.setup = stubSetup();
    const client = await connect(session);
    const r = await client.callTool({ name: "doc_list", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      [
        "not_configured: Autosketch has no Minecraft instance to read blocks from yet. Ask the user to choose one in a terminal, then call the tool again (no restart needed):",
        "- one of:",
        "  npx -y autosketch setup --instance /games/Craftoria   # Craftoria (Minecraft 1.21.1, neoforge 21.1.262, CurseForge, 532 mods)",
        '  npx -y autosketch setup --instance "/games/My Broken Pack"   # Broken Pack (Minecraft 1.21.1, Modrinth App, 3 mods); can\'t load yet: base game jar not found',
      ].join("\n"),
    );
    const info = await client.callTool({ name: "instance_info", arguments: {} });
    expect(info.isError).toBeFalsy();
    expect(textOf(info)).toMatch(/^No Minecraft instance is loaded yet\.\nAutosketch has no Minecraft instance/);
  });

  it("loads an instance in place with loadInstance, and refuses a second one", async () => {
    const session = new Session(workspace);
    const setup = stubSetup();
    session.setup = setup;
    const client = await connect(session);
    expect((await client.callTool({ name: "instance_info", arguments: {} })).isError).toBeFalsy();
    const first = session.loadInstance("/games/Craftoria", { version: "1.21.1" });
    // Refused at once, even while the first is still loading.
    await expect(session.loadInstance("/games/Other")).rejects.toMatchObject({ refusal: "instance_loaded" });
    expect((await first).info.name).toBe("Fixture");
    expect(setup.loads).toEqual(["/games/Craftoria"]);
    const info = await client.callTool({ name: "instance_info", arguments: {} });
    expect(textOf(info)).toMatch(/^Fixture: Minecraft 1\.21\.1/);
    await expect(session.loadInstance("/games/Other")).rejects.toThrow(/already loaded/);
    expect(await session.whenInstance()).toBe(await first);
  });

  it("goes back to not configured when a load fails, so another choice can be loaded", async () => {
    const session = new Session(workspace);
    let fail = true;
    session.setup = stubSetup({ load: async () => (fail ? Promise.reject(new Error("instance folder not found: /nope")) : smallContext()) });
    const client = await connect(session);
    await expect(session.loadInstance("/nope")).rejects.toThrow("instance folder not found");
    expect(session.instance).toBeUndefined();
    expect(textOf(await client.callTool({ name: "doc_list", arguments: {} }))).toMatch(/^not_configured:/);
    fail = false;
    await session.loadInstance("/games/Craftoria");
    expect((await client.callTool({ name: "doc_list", arguments: {} })).isError).toBeFalsy();
  });

  it("picks up an instance saved in config.toml since startup on the next tool call", async () => {
    const session = new Session(workspace);
    let saved: { path: string; version?: string } | undefined;
    const setup = stubSetup({ saved: () => saved });
    session.setup = setup;
    const client = await connect(session);
    expect((await client.callTool({ name: "doc_list", arguments: {} })).isError).toBe(true);
    saved = { path: "/games/Craftoria", version: "1.21.1" };
    expect((await client.callTool({ name: "doc_list", arguments: {} })).isError).toBeFalsy();
    expect(setup.loads).toEqual(["/games/Craftoria"]);
  });

  it("allows loadInstance after the startup instance failed", async () => {
    const session = new Session(workspace);
    session.setup = stubSetup();
    const failed = Promise.reject(new Error("bad launch instance"));
    failed.catch(() => {});
    const client = await connect(session, failed);
    expect(textOf(await client.callTool({ name: "doc_list", arguments: {} }))).toMatch(/failed to load: bad launch instance/);
    await session.loadInstance("/games/Craftoria");
    expect((await client.callTool({ name: "doc_list", arguments: {} })).isError).toBeFalsy();
  });
});

describe("setup helpers (14, Setup; 16, Command line)", () => {
  it("quotes setup commands only when needed, and says when nothing was found", () => {
    expect(setupCommand("C:/Users/me/curseforge/minecraft/Instances/Craftoria")).toBe("npx -y autosketch setup --instance C:/Users/me/curseforge/minecraft/Instances/Craftoria");
    expect(setupCommand('/a b/"c"')).toBe('npx -y autosketch setup --instance "/a b/\\"c\\""');
    expect(notConfiguredText({ candidates: [], warnings: [] })).toBe(
      "Autosketch has no Minecraft instance to read blocks from yet. Ask the user to choose one in a terminal, then call the tool again (no restart needed):\n" +
        '- npx -y autosketch setup --instance "<instance folder>"  (no instance was found in the known launcher folders)',
    );
  });

  it("reads a saved instance from config.toml and builds the answer from discovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autosketch-setup-"));
    const path = join(dir, "config.toml");
    let runs = 0;
    const setup = makeInstanceSetup({ launch: {}, configPath: path, discover: async () => (runs++, found) });
    expect(setup.saved!()).toBeUndefined();
    writeFileSync(path, 'instance = "/games/Craftoria"\nversion = "1.21.1"\n');
    expect(setup.saved!()).toEqual({ path: "/games/Craftoria", version: "1.21.1" });
    const text = await setup.notConfigured();
    expect(text).toContain("  npx -y autosketch setup --instance /games/Craftoria   # Craftoria");
    await setup.notConfigured();
    expect(runs).toBe(1); // one discovery serves answers for a while
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("automatic instance choice (16, Command line)", () => {
  const vanilla = candidate({ id: "minecraft", name: "Minecraft", launcher: "vanilla", folder: "/home/me/.minecraft", gameDir: "/home/me/.minecraft", loader: undefined, check: { ok: true, mods: 0, detail: "Minecraft 1.21.1" } });
  const withMod = candidate({ pointer: true });
  const broken = found.candidates[0]!;

  /** A session with the real setup (discovery stubbed) and a stub load; what it logged and loaded. */
  async function start(discovery: Discovery) {
    const logs: string[] = [];
    const loads: string[] = [];
    const setup = makeInstanceSetup({ launch: {}, configPath: join(workspace, "no-config.toml"), discover: async () => discovery, log: (m) => logs.push(m) });
    const session = new Session(workspace);
    session.setup = { ...setup, load: async (path) => (loads.push(path), smallContext()) };
    const client = await connect(session);
    const pick = await setup.autoChoose(session);
    return { session, client, pick, logs, loads };
  }

  it("picks the one candidate found, and reports it on stderr and in the first tool result only", async () => {
    const { session, client, pick, logs, loads } = await start({ candidates: [withMod], warnings: [] });
    expect(pick?.folder).toBe("/games/Craftoria");
    expect(loads).toEqual(["/games/Craftoria"]);
    const note =
      "Autosketch chose the Minecraft instance Craftoria (Minecraft 1.21.1, neoforge 21.1.262, CurseForge, 532 mods) at /games/Craftoria automatically: it is the only instance found. " +
      "It isn't saved; to keep it or choose another, the user runs npx -y autosketch setup --instance /games/Craftoria.";
    expect(logs).toEqual([note]);
    await session.whenInstance();
    const first = await client.callTool({ name: "doc_list", arguments: {} });
    expect(first.isError).toBeFalsy();
    expect((first.content as Content)[0]).toEqual({ type: "text", text: note });
    const second = await client.callTool({ name: "doc_list", arguments: {} });
    expect(textOf(second)).not.toContain("chose the Minecraft instance");
    // instance_info names how it was chosen (the real load tags the context with AUTO_SOURCE).
    expect(instanceSourceText(AUTO_SOURCE)).toBe("automatic choice");
  });

  it("prefers the one game the mod has run in over others without a pointer file, and ignores ones that can't load", async () => {
    const { pick, logs, loads } = await start({ candidates: [vanilla, withMod, broken], warnings: [] });
    expect(pick?.id).toBe("craftoria");
    expect(loads).toEqual(["/games/Craftoria"]);
    expect(logs[0]).toContain("automatically: it is the only one the Autosketch mod has run in (3 found). It isn't saved; to keep it or choose another, the user runs npx -y autosketch setup --instance /games/Craftoria; `npx -y autosketch instances` lists the others.");
    expect(chooseAutomatically({ candidates: [vanilla, broken], warnings: [] })).toBe(vanilla);
    expect(chooseAutomatically({ candidates: [withMod, { ...vanilla, pointer: true }], warnings: [] })).toBeUndefined();
  });

  it("lists several candidates with the setup command, and loads nothing", async () => {
    const { session, client, pick, logs, loads } = await start({ candidates: [vanilla, candidate({})], warnings: [] });
    expect(pick).toBeUndefined();
    expect(loads).toEqual([]);
    expect(session.instance).toBeUndefined();
    expect(logs).toEqual(["no instance configured and 2 found, none chosen automatically: choose one with `npx -y autosketch setup --instance <id|path>` (`npx -y autosketch instances` lists them)"]);
    const r = await client.callTool({ name: "doc_list", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("  npx -y autosketch setup --instance /home/me/.minecraft   # Minecraft (Minecraft 1.21.1, Minecraft Launcher, 0 mods)");
    expect(textOf(r)).toContain("  npx -y autosketch setup --instance /games/Craftoria   # Craftoria");
  });

  it("says how to set one when none is found", async () => {
    const { client, pick, logs } = await start({ candidates: [], warnings: [] });
    expect(pick).toBeUndefined();
    expect(logs).toEqual(['no instance configured and none found: choose one with `npx -y autosketch setup --instance "<instance folder>"`']);
    expect(textOf(await client.callTool({ name: "doc_list", arguments: {} }))).toContain('- npx -y autosketch setup --instance "<instance folder>"  (no instance was found in the known launcher folders)');
  });

  it("answers a call made while discovery ran with the choice, which is loading", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const setup = makeInstanceSetup({ launch: {}, configPath: join(workspace, "no-config.toml"), discover: async () => (await gate, { candidates: [withMod], warnings: [] }) });
    const session = new Session(workspace);
    session.setup = { ...setup, load: async () => smallContext() };
    const client = await connect(session);
    const chosen = setup.autoChoose(session);
    const early = client.callTool({ name: "doc_list", arguments: {} });
    await new Promise((r) => setTimeout(r, 20));
    release();
    await chosen;
    expect(textOf(await early)).toMatch(/^not_configured: Autosketch chose the Minecraft instance Craftoria .* It is loading now: call the tool again\.$/);
    // Said once: the next result carries no note.
    expect(textOf(await client.callTool({ name: "doc_list", arguments: {} }))).not.toContain("chose the Minecraft instance");
  });
});
