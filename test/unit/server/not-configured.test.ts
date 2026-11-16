import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Candidate, Discovery } from "../../../src/assets/discover/index.js";
import { parseConfig } from "../../../src/core/config.js";
import type { InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session, type InstanceSetup } from "../../../src/server/session.js";
import { INSTANCE_TAB_FRAGMENT, makeInstanceSetup, notConfiguredText, setupCommand, wantsSetupWizard, withFragment } from "../../../src/server/setup.js";
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
    notConfigured: async () => notConfiguredText(found, "http://127.0.0.1:4000/#tab=instance"),
    ...over,
  };
}

describe("not configured (14, Setup)", () => {
  it("answers not_configured from every tool but instance_info, with candidates, commands and the UI URL", async () => {
    const session = new Session(workspace);
    session.setup = stubSetup();
    const client = await connect(session);
    const r = await client.callTool({ name: "doc_list", arguments: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      [
        "not_configured: Autosketch has no Minecraft instance to read blocks from yet. Ask the user to choose one, then call the tool again (no restart needed):",
        "- in the browser: http://127.0.0.1:4000/#tab=instance (Instance tab)",
        "- or in a terminal, one of:",
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

describe("setup helpers (15, Instance tab and first-run setup)", () => {
  it("adds the Instance tab fragment beside an existing one", () => {
    expect(withFragment("http://127.0.0.1:1/", INSTANCE_TAB_FRAGMENT)).toBe("http://127.0.0.1:1/#tab=instance");
    expect(withFragment("http://127.0.0.1:1/#t=abc", INSTANCE_TAB_FRAGMENT)).toBe("http://127.0.0.1:1/#t=abc&tab=instance");
    expect(withFragment("http://127.0.0.1:1/#", INSTANCE_TAB_FRAGMENT)).toBe("http://127.0.0.1:1/#tab=instance");
  });

  it("opens the wizard at startup only when config.toml remembers no instance", () => {
    expect(wantsSetupWizard(parseConfig(""))).toBe(true);
    expect(wantsSetupWizard(parseConfig('workspace = "/w"'))).toBe(true);
    expect(wantsSetupWizard(parseConfig('instance = "/games/x"'))).toBe(false);
  });

  it("quotes setup commands only when needed, and says when nothing was found", () => {
    expect(setupCommand("C:/Users/me/curseforge/minecraft/Instances/Craftoria")).toBe("npx -y autosketch setup --instance C:/Users/me/curseforge/minecraft/Instances/Craftoria");
    expect(setupCommand('/a b/"c"')).toBe('npx -y autosketch setup --instance "/a b/\\"c\\""');
    expect(notConfiguredText({ candidates: [], warnings: [] })).toBe(
      "Autosketch has no Minecraft instance to read blocks from yet. Ask the user to choose one, then call the tool again (no restart needed):\n" +
        '- or in a terminal: npx -y autosketch setup --instance "<instance folder>"  (no instance was found in the known launcher folders)',
    );
  });

  it("reads a saved instance from config.toml and builds the answer from discovery and the UI URL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autosketch-setup-"));
    const path = join(dir, "config.toml");
    let runs = 0;
    const setup = makeInstanceSetup({ launch: {}, uiUrl: async () => "http://127.0.0.1:5/#t=x", configPath: path, discover: async () => (runs++, found) });
    expect(setup.saved!()).toBeUndefined();
    writeFileSync(path, 'instance = "/games/Craftoria"\nversion = "1.21.1"\n');
    expect(setup.saved!()).toEqual({ path: "/games/Craftoria", version: "1.21.1" });
    const text = await setup.notConfigured();
    expect(text).toContain("- in the browser: http://127.0.0.1:5/#t=x&tab=instance (Instance tab)");
    await setup.notConfigured();
    expect(runs).toBe(1); // one discovery serves answers for a while
    rmSync(dir, { recursive: true, force: true });
  });
});
