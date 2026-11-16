import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discover } from "../../../src/assets/discover/index.js";
import { CLAUDE_ADD, runCli } from "../../../src/cli/index.js";
import { readConfig } from "../../../src/core/config.js";
import { makeZip, tempDir, writeTree } from "../../helpers/fixtures.js";

/** A synthetic home with one loadable CurseForge instance and one Modrinth instance that needs a base jar. */
async function world() {
  const home = await tempDir();
  await writeTree(home, {
    "curseforge/minecraft/Install/versions/1.21.1/1.21.1.jar": makeZip({ "version.json": { id: "1.21.1" } }),
    "curseforge/minecraft/Instances/Craftoria/minecraftinstance.json": { name: "Craftoria", gameVersion: "1.21.1", baseModLoader: { name: "neoforge-21.1.262" } },
    "curseforge/minecraft/Instances/Craftoria/mods/a.jar": makeZip({}),
    "atlauncher-like/jar/client.jar": makeZip({ "version.json": { id: "1.20.1" } }),
    ".local/share/atlauncher/instances/Needs Jar/instance.json": { id: "1.20.1", launcher: { name: "Needs Jar" } },
  });
  const configPath = join(home, ".autosketch/config.toml");
  const out: string[] = [];
  const err: string[] = [];
  const execs: string[][] = [];
  const deps = {
    discover: () => discover({ platform: "linux", home, env: {}, autosketchHome: join(home, ".autosketch"), wsl: false }),
    configPath,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    exec: async (cmd: string, args: string[]) => (execs.push([cmd, ...args]), 0),
  };
  return { home, configPath, out, err, execs, deps };
}

describe("autosketch instances / setup / config (14, Setup)", () => {
  it("lists what discovery found, one line per instance", async () => {
    const w = await world();
    expect(await runCli("instances", [], w.deps)).toBe(0);
    expect(w.out[0]).toMatch(/^craftoria +Craftoria +1\.21\.1 +neoforge 21\.1\.262 +CurseForge +\/.*Instances\/Craftoria$/);
    expect(w.out[1]).toMatch(/^needs-jar +Needs Jar +1\.20\.1 +vanilla +ATLauncher /);
    expect(w.out[2]).toMatch(/^  can't load yet: /);
    expect(w.out.at(-1)).toBe("Choose one with: autosketch setup --instance <id>");
    const j = await world();
    await runCli("instances", ["--json"], j.deps);
    expect(JSON.parse(j.out.join("\n"))).toHaveLength(2);
  });

  it("setup saves the instance by id, and registers with Claude Code when asked", async () => {
    const w = await world();
    expect(await runCli("setup", ["--instance", "craftoria", "--workspace", join(w.home, "ws"), "--client", "claude"], w.deps)).toBe(0);
    const c = readConfig(w.configPath).config;
    expect(c).toMatchObject({ instance: join(w.home, "curseforge/minecraft/Instances/Craftoria"), workspace: join(w.home, "ws") });
    expect(c.version).toBeUndefined();
    expect(w.out[0]).toBe(`Saved instance Craftoria (Minecraft 1.21.1, neoforge 21.1.262, 1 mod jar): ${c.instance}`);
    expect(w.out).toContain(`Running: ${[CLAUDE_ADD[0], ...CLAUDE_ADD[1]].join(" ")}`);
    expect(w.execs).toEqual([["claude", "mcp", "add", "--scope", "user", "autosketch", "--", "npx", "-y", "autosketch"]]);
  });

  it("setup refuses a folder the locator can't load, and saves it with --base-jar and --version", async () => {
    const w = await world();
    expect(await runCli("setup", ["--instance", "needs-jar"], w.deps)).toBe(1);
    expect(w.err[0]).toMatch(/^can't use .*Needs Jar: could not recognise .* Pass baseJar/);
    expect(readConfig(w.configPath).exists).toBe(false);
    const jar = join(w.home, "atlauncher-like/jar/client.jar");
    expect(await runCli("setup", ["--instance", join(w.home, ".local/share/atlauncher/instances/Needs Jar"), "--base-jar", jar, "--version", "1.20.1"], w.deps)).toBe(0);
    expect(readConfig(w.configPath).config).toMatchObject({ instance: join(w.home, ".local/share/atlauncher/instances/Needs Jar"), version: "1.20.1", baseJar: jar });
    expect(await runCli("setup", ["--instance", "nothing-like-this"], w.deps)).toBe(1);
    expect(w.err.at(-1)).toMatch(/^no instance with id "nothing-like-this" and no folder at .* \(ids: craftoria, needs-jar\)$/);
    expect(await runCli("setup", ["--client", "claude"], w.deps)).toBe(2);
  });

  it("config set and unset edit config.toml with each setting's own validation", async () => {
    const w = await world();
    expect(await runCli("config", ["set", "observe.snapshots", "merge"], w.deps)).toBe(0);
    expect(await runCli("config", ["set", "observe.snapshots", "sometimes"], w.deps)).toBe(1);
    expect(w.err.at(-1)).toMatch(/^observe\.snapshots: "sometimes" is not valid; expected /);
    expect(await runCli("config", ["set", "no.such", "1"], w.deps)).toBe(1);
    expect(await runCli("config", ["set", "version", "1.21.1"], w.deps)).toBe(1);
    expect(w.err.at(-1)).toMatch(/^version goes with an instance/);
    expect(await runCli("config", ["set", "instance", "craftoria"], w.deps)).toBe(0);
    expect(await runCli("config", ["set", "version", "1.21.1"], w.deps)).toBe(0);
    expect(readConfig(w.configPath).config).toMatchObject({ version: "1.21.1", settings: { "observe.snapshots": "merge" } });
    expect(await runCli("config", ["unset", "instance"], w.deps)).toBe(0);
    expect(readConfig(w.configPath).config).toEqual({ settings: { "observe.snapshots": "merge" }, extra: {} });
    expect(await runCli("config", ["unset", "observe.snapshots"], w.deps)).toBe(0);
    expect(readFileSync(w.configPath, "utf8")).toBe("");
    expect(await runCli("config", ["set", "observe.snapshots"], w.deps)).toBe(2);
  });

  it("keeps unknown keys and settings it doesn't know when editing", async () => {
    const w = await world();
    await writeTree(w.home, { ".autosketch/.keep": "" });
    writeFileSync(w.configPath, 'future = "keep"\n[settings]\n"plugin.thing" = "x"\n');
    expect(await runCli("config", ["set", "workspace", "~/builds"], w.deps)).toBe(0);
    expect(readFileSync(w.configPath, "utf8")).toBe('workspace = "~/builds"\nfuture = "keep"\n\n[settings]\n"plugin.thing" = "x"\n');
    expect(await runCli("config", ["unset", "plugin.thing"], w.deps)).toBe(0);
  });
});
