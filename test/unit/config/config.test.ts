import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ABSENT, autosketchHome, ConfigConflictError, configPath, expandHome, formatConfig, hashText, parseConfig, readConfig, setInstance, unsetInstance, updateConfig, writeConfig } from "../../../src/core/config.js";

const home = () => mkdtempSync(join(tmpdir(), "autosketch-home-"));

describe("config.toml store (14, 15 Settings tab)", () => {
  it("lives in ~/.autosketch, or AUTOSKETCH_HOME", () => {
    expect(autosketchHome({})).toBe(join(homedir(), ".autosketch"));
    expect(configPath({ AUTOSKETCH_HOME: "/x/y" })).toBe(join("/x/y", "config.toml"));
    expect(expandHome("~/a/b")).toBe(join(homedir(), "a/b"));
    expect(expandHome("/abs/~x")).toBe("/abs/~x");
  });

  it("reads a missing file as an empty config with the ABSENT hash", () => {
    const snap = readConfig(configPath({ AUTOSKETCH_HOME: home() }));
    expect(snap).toMatchObject({ exists: false, hash: ABSENT, config: { settings: {}, extra: {} }, warnings: [] });
  });

  it("reads instance, workspace and [settings] as text, keeping unknown keys", () => {
    const text = [
      'instance = "C:/Users/me/curseforge/minecraft/Instances/Craftoria"',
      'workspace = "~/autosketch"',
      "future = { a = 1 }",
      "[settings]",
      '"observe.snapshots" = "merge"',
      '"scope.maxDepth" = 2',
      '"observe.log" = false',
      '"library.roots" = ["~/autosketch/library", "~/shared/castle-kit"]',
      "",
    ].join("\n");
    const snap = parseConfig(text, "c.toml");
    expect(snap.warnings).toEqual([]);
    expect(snap.hash).toBe(hashText(text));
    expect(snap.config).toEqual({
      instance: "C:/Users/me/curseforge/minecraft/Instances/Craftoria",
      workspace: "~/autosketch",
      settings: { "observe.snapshots": "merge", "scope.maxDepth": "2", "observe.log": "false", "library.roots": "~/autosketch/library, ~/shared/castle-kit" },
      extra: { future: { a: 1 } },
    });
  });

  it("warns about bad TOML and wrongly typed values, and leaves them out", () => {
    expect(parseConfig("instance = ", "c.toml")).toMatchObject({ config: { settings: {} }, warnings: [expect.stringContaining("not valid TOML")] });
    const snap = parseConfig('instance = 3\nsettings = "x"\n', "c.toml");
    expect(snap.config.instance).toBeUndefined();
    expect(snap.warnings).toEqual(["c.toml: instance must be a folder path (text), ignored", "c.toml: settings must be a table ([settings]), ignored"]);
    const bad = parseConfig('[settings]\n"a.b" = { x = 1 }\n"c" = 1979-05-27\n"d" = "ok"\n', "c.toml");
    expect(bad.config.settings).toEqual({ d: "ok" });
    expect(bad.warnings).toHaveLength(2);
  });

  it("writes the whole file through a temp file and reads it back", () => {
    const path = configPath({ AUTOSKETCH_HOME: join(home(), "nested") });
    const first = readConfig(path);
    const written = writeConfig({ ...first.config, instance: "/games/pack", settings: { "observe.snapshots": "merge" } }, first.hash, path);
    expect(readFileSync(path, "utf8")).toBe('instance = "/games/pack"\n\n[settings]\n"observe.snapshots" = "merge"\n');
    expect(readdirSync(join(path, ".."))).toEqual(["config.toml"]); // no temp file left behind
    const again = readConfig(path);
    expect(again.hash).toBe(written.hash);
    expect(again.config).toEqual(written.config);
    // Unknown keys survive a write; an empty [settings] is left out.
    writeFileSync(path, 'future = "keep"\n[settings]\n"x" = "1"\n');
    const s = readConfig(path);
    writeConfig({ ...s.config, settings: {} }, s.hash, path);
    expect(readFileSync(path, "utf8")).toBe('future = "keep"\n');
    expect(formatConfig({ settings: {}, extra: {} })).toBe("");
  });

  it("refuses a write when the file changed since it was read (compare-and-set)", () => {
    const path = configPath({ AUTOSKETCH_HOME: home() });
    const stale = readConfig(path);
    writeConfig({ ...stale.config, instance: "/a" }, stale.hash, path);
    // The stale snapshot said "no file"; now there is one.
    expect(() => writeConfig({ ...stale.config, instance: "/b" }, stale.hash, path)).toThrow(ConfigConflictError);
    const now = readConfig(path);
    writeFileSync(path, 'instance = "/edited by hand"\n');
    expect(() => writeConfig({ ...now.config, instance: "/c" }, now.hash, path)).toThrow(/changed since it was read/);
    expect(readConfig(path).config.instance).toBe("/edited by hand");
    const fresh = readConfig(path);
    expect(writeConfig({ ...fresh.config, instance: "/c" }, fresh.hash, path).config.instance).toBe("/c");
  });

  it("keeps version and baseJar with the instance they were saved with", () => {
    const snap = parseConfig('instance = "/p"\nversion = "1.21.1"\nbaseJar = "/j/client.jar"\n', "c.toml");
    expect(snap.config).toMatchObject({ instance: "/p", version: "1.21.1", baseJar: "/j/client.jar", extra: {} });
    expect(parseConfig("version = 1.21\n", "c.toml").warnings).toEqual(['c.toml: version must be a Minecraft version as text (e.g. "1.21.1"), ignored']);
    const c = structuredClone(snap.config);
    c.workspace = "/w";
    expect(formatConfig(c)).toBe('instance = "/p"\nversion = "1.21.1"\nbaseJar = "/j/client.jar"\nworkspace = "/w"\n');
    setInstance(c, "/q");
    expect(c).toMatchObject({ instance: "/q", workspace: "/w" });
    expect(c.version).toBeUndefined();
    setInstance(c, "/r", { baseJar: "/k.jar" });
    expect([c.instance, c.version, c.baseJar]).toEqual(["/r", undefined, "/k.jar"]);
    unsetInstance(c);
    expect(c).toEqual({ workspace: "/w", settings: {}, extra: {} });
  });

  it("updateConfig edits a fresh read and writes it", () => {
    const path = configPath({ AUTOSKETCH_HOME: home() });
    updateConfig((c) => setInstance(c, "/a"), path);
    writeFileSync(path, 'instance = "/a"\n[settings]\n"x" = "1"\n');
    const s = updateConfig((c) => (c.settings.y = "2"), path);
    expect(s.config).toMatchObject({ instance: "/a", settings: { x: "1", y: "2" } });
    expect(readConfig(path).hash).toBe(s.hash);
  });
});
