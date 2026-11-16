import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discover, findCandidate, formatPointer, gameFolderHash, windowsFormOfWslPath, type Candidate } from "../../../src/assets/discover/index.js";
import { MODRINTH_SQL, openReadOnly, type OpenDb } from "../../../src/assets/discover/modrinth.js";
import { curseForgeLoader, vanillaVersionId } from "../../../src/assets/discover/versions.js";
import { makeZip, tempDir, writeTree } from "../../helpers/fixtures.js";

// Synthetic launcher layouts only: every test passes its own home, platform and environment, so the
// real user's launcher folders are never read (docs/briefs/release/J-install-config.md).

const jar = (id: string) => makeZip({ "version.json": { id } });
const linux = (home: string, extra: Record<string, unknown> = {}) => ({ platform: "linux" as const, home, env: {}, autosketchHome: join(home, ".autosketch"), wsl: false, ...extra });
const byName = (cs: Candidate[], name: string) => cs.find((c) => c.name === name);

/** A database stub that records every statement, over a real read-only handle. */
function recordingDb(sql: string[], opened: string[]): OpenDb {
  return async (path) => {
    opened.push(path);
    const db = await openReadOnly(path);
    return { all: (s) => (sql.push(s), db.all(s)), close: () => db.close() };
  };
}

function makeDb(path: string, statements: string): void {
  const db = new DatabaseSync(path);
  db.exec(statements);
  db.close();
}

describe("instance discovery (14, Instance discovery)", () => {
  it("reads CurseForge's record and checks each instance with the locator", async () => {
    const home = await tempDir();
    const cf = join(home, "curseforge/minecraft");
    await writeTree(home, {
      ".config/CurseForge/agent/GameInstances/MinecraftGameInstance.json": [
        { name: "Craftoria", installPath: join(cf, "Instances/Craftoria"), gameVersion: "1.21.1", baseModLoader: { name: "neoforge-21.1.262" } },
        { name: "Moved", installPath: join(home, "elsewhere/Moved"), gameVersion: "1.21.11", baseModLoader: { name: "fabric-0.19.2-1.21.11" } },
        { name: "No path" },
        { name: "Deleted", installPath: join(home, "gone") },
      ],
      "curseforge/minecraft/Install/versions/1.21.1/1.21.1.jar": jar("1.21.1"),
      "curseforge/minecraft/Instances/Craftoria/minecraftinstance.json": { name: "Craftoria", gameVersion: "1.21.1", baseModLoader: { name: "neoforge-21.1.262" } },
      "curseforge/minecraft/Instances/Craftoria/mods/a.jar": makeZip({}),
      "curseforge/minecraft/Instances/Craftoria/mods/b.jar": makeZip({}),
      "elsewhere/Moved/minecraftinstance.json": { name: "Moved", gameVersion: "1.21.11" },
    });
    const { candidates, warnings } = await discover(linux(home));
    expect(candidates.map((c) => c.name)).toEqual(["Craftoria", "Moved"]);
    expect(byName(candidates, "Craftoria")).toMatchObject({
      id: "craftoria",
      mcVersion: "1.21.1",
      loader: { name: "neoforge", version: "21.1.262" },
      launcher: "curseforge",
      via: "record",
      folder: join(cf, "Instances/Craftoria"),
      check: { ok: true, mods: 2, detail: "Minecraft 1.21.1, neoforge 21.1.262, 2 mod jars" },
    });
    expect(byName(candidates, "Moved")).toMatchObject({ loader: { name: "fabric", version: "0.19.2" }, check: { ok: false, mods: 0, detail: expect.stringContaining("base game jar not found") } });
    expect(warnings).toEqual([expect.stringMatching(/^CurseForge: 1 entry in .* without installPath, skipped$/)]);
  });

  it("falls back to listing CurseForge's instance folder when the record is unreadable", async () => {
    const home = await tempDir();
    await writeTree(home, {
      ".config/CurseForge/agent/GameInstances/MinecraftGameInstance.json": "{ not json",
      "curseforge/minecraft/Instances/Pack/minecraftinstance.json": { name: "My Pack", gameVersion: "1.20.1", baseModLoader: { name: "forge-47.4.4" } },
      "curseforge/minecraft/Instances/NotAnInstance/readme.txt": "x",
    });
    const { candidates, warnings } = await discover(linux(home));
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: "my-pack", name: "My Pack", via: "folder", mcVersion: "1.20.1", loader: { name: "forge", version: "47.4.4" } });
    expect(warnings).toEqual([expect.stringMatching(/^CurseForge: .*MinecraftGameInstance\.json is not the list it used to be .*listing the instance folder instead$/)]);
  });

  it("reads Prism's InstanceDir (moved outside the data folder) and mmc-pack.json, tolerating a missing pack file", async () => {
    const home = await tempDir();
    const moved = join(home, "games/prism-instances");
    await writeTree(home, {
      ".local/share/PrismLauncher/prismlauncher.cfg": `[General]\nInstanceDir=${moved}\n`,
      ".local/share/PrismLauncher/libraries/com/mojang/minecraft/1.21.1/minecraft-1.21.1-client.jar": jar("1.21.1"),
      "games/prism-instances/Pack/instance.cfg": "InstanceType=OneSix\nname=Prism Pack\n",
      "games/prism-instances/Pack/mmc-pack.json": { components: [{ uid: "net.minecraft", version: "1.21.1" }, { uid: "net.neoforged", version: "21.1.200" }] },
      "games/prism-instances/Pack/minecraft/mods/x.jar": makeZip({}),
      "games/prism-instances/Bare/instance.cfg": "name=Bare\n",
      "games/prism-instances/Bare/.minecraft/options.txt": "",
      "games/prism-instances/_LAUNCHER_TEMP/readme": "",
    });
    const { candidates } = await discover(linux(home));
    expect(candidates.map((c) => c.name)).toEqual(["Bare", "Prism Pack"]);
    const pack = byName(candidates, "Prism Pack")!;
    expect(pack).toMatchObject({ launcher: "prism", mcVersion: "1.21.1", loader: { name: "neoforge", version: "21.1.200" }, folder: join(moved, "Pack"), gameDir: join(moved, "Pack/minecraft") });
    // Prism's data folder is two levels above the instance only by default; a moved InstanceDir loses the shared libraries.
    expect(pack.check.mods).toBe(1);
    const bare = byName(candidates, "Bare")!;
    expect(bare).toMatchObject({ gameDir: join(moved, "Bare/.minecraft"), via: "folder", warnings: [expect.stringContaining("no readable mmc-pack.json")] });
    expect(bare.mcVersion).toBeUndefined();
  });

  it("reads the vanilla launcher's profiles: one candidate per game folder, loader from the version id", async () => {
    const home = await tempDir();
    const mc = join(home, ".minecraft");
    await writeTree(home, {
      ".minecraft/launcher_profiles.json": {
        profiles: {
          a: { name: "", type: "latest-release", lastVersionId: "latest-release" },
          b: { name: "NeoForge", type: "custom", lastVersionId: "neoforge-21.1.262" },
          c: { name: "Fabric pack", type: "custom", lastVersionId: "fabric-loader-0.16.5-1.21.1", gameDir: join(home, "packs/fabric") },
          d: { name: "Missing folder", type: "custom", lastVersionId: "1.21.1", gameDir: join(home, "nope") },
        },
      },
      ".minecraft/versions/1.21.1/1.21.1.jar": jar("1.21.1"),
      ".minecraft/versions/neoforge-21.1.262/neoforge-21.1.262.json": { id: "neoforge-21.1.262", inheritsFrom: "1.21.1" },
      "packs/fabric/mods/f.jar": makeZip({}),
    });
    const { candidates } = await discover(linux(home));
    expect(candidates).toHaveLength(2);
    expect(byName(candidates, "NeoForge")).toMatchObject({ folder: mc, mcVersion: "1.21.1", version: "1.21.1", loader: { name: "neoforge", version: "21.1.262" }, check: { ok: true } });
    expect(byName(candidates, "Fabric pack")).toMatchObject({
      folder: join(home, "packs/fabric"),
      loader: { name: "fabric", version: "0.16.5" },
      version: "1.21.1",
      baseJar: join(mc, "versions/1.21.1/1.21.1.jar"),
      check: { ok: true, mods: 1 },
    });
  });

  it("reads Modrinth's app.db read-only, running only statements on the named tables", async () => {
    const home = await tempDir();
    const app = join(home, ".local/share/ModrinthApp");
    const moved = join(home, "modrinth-data");
    await writeTree(home, {
      "modrinth-data/profiles/craftoria/mods/m.jar": makeZip({}),
      "modrinth-data/meta/versions/1.21.1/1.21.1.jar": jar("1.21.1"),
      "modrinth-data/profiles/vanilla-world/options.txt": "",
    });
    await writeTree(app, { ".keep": "" });
    makeDb(
      join(app, "app.db"),
      `CREATE TABLE settings (id INTEGER PRIMARY KEY, custom_dir TEXT, theme TEXT);
       INSERT INTO settings VALUES (0, '${moved}', 'dark');
       CREATE TABLE instances (id INTEGER PRIMARY KEY, path TEXT, name TEXT, applied_content_set_id INTEGER);
       CREATE TABLE instance_content_sets (id INTEGER PRIMARY KEY, game_version TEXT, loader TEXT, loader_version TEXT);
       INSERT INTO instance_content_sets VALUES (1, '1.21.1', 'neoforge', '21.1.262'), (2, '1.21.4', 'vanilla', NULL);
       INSERT INTO instances VALUES (10, 'craftoria', 'Craftoria (Modrinth)', 1), (11, 'vanilla-world', 'Plain', 2);
       CREATE TABLE minecraft_users (uuid TEXT, access_token TEXT);
       INSERT INTO minecraft_users VALUES ('u', 'secret');`,
    );
    const sql: string[] = [];
    const opened: string[] = [];
    const { candidates, warnings } = await discover(linux(home, { openDb: recordingDb(sql, opened) }));
    expect(warnings).toEqual([]);
    expect(opened).toEqual([join(app, "app.db")]);
    expect(sql).toEqual([MODRINTH_SQL.customDir, MODRINTH_SQL.instances]);
    // Every statement the reader can run reads only instances, instance_content_sets, profiles or settings.
    for (const s of Object.values(MODRINTH_SQL)) {
      expect(s).toMatch(/^SELECT /);
      const tables = [...s.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/g)].map((m) => m[1]);
      expect(tables.every((t) => ["instances", "instance_content_sets", "profiles", "settings"].includes(t!))).toBe(true);
    }
    expect(byName(candidates, "Craftoria (Modrinth)")).toMatchObject({
      launcher: "modrinth",
      folder: join(moved, "profiles/craftoria"),
      mcVersion: "1.21.1",
      loader: { name: "neoforge", version: "21.1.262" },
      baseJar: join(moved, "meta/versions/1.21.1/1.21.1.jar"),
      check: { ok: true, mods: 1 },
    });
    expect(byName(candidates, "Plain")).toMatchObject({ mcVersion: "1.21.4" });
    expect(byName(candidates, "Plain")!.loader).toBeUndefined();
  });

  it("opens app.db so that writes fail", async () => {
    const dir = await tempDir();
    makeDb(join(dir, "app.db"), "CREATE TABLE settings (custom_dir TEXT);");
    const db = await openReadOnly(join(dir, "app.db"));
    expect(() => db.all("INSERT INTO settings VALUES ('x')")).toThrow(/readonly/i);
    db.close();
  });

  it("reads Modrinth's older profiles table, and lists the profiles folder when no table is readable", async () => {
    const home = await tempDir();
    const app = join(home, ".local/share/ModrinthApp");
    await writeTree(app, { "profiles/old/mods/a.jar": makeZip({}) });
    makeDb(join(app, "app.db"), `CREATE TABLE profiles (path TEXT, name TEXT, game_version TEXT, mod_loader TEXT, mod_loader_version TEXT);
      INSERT INTO profiles VALUES ('old', 'Old Pack', '1.20.1', 'forge', '47.2.0');`);
    const sql: string[] = [];
    let r = await discover(linux(home, { openDb: recordingDb(sql, []) }));
    expect(r.candidates).toMatchObject([{ name: "Old Pack", mcVersion: "1.20.1", loader: { name: "forge", version: "47.2.0" }, via: "record" }]);
    expect(sql).toEqual([MODRINTH_SQL.customDir, MODRINTH_SQL.instances, MODRINTH_SQL.instancesBare, MODRINTH_SQL.profiles]);

    const home2 = await tempDir();
    const app2 = join(home2, ".local/share/com.modrinth.theseus");
    await writeTree(app2, { "profiles/listed/mods/a.jar": makeZip({}) });
    makeDb(join(app2, "app.db"), "CREATE TABLE something_else (x TEXT);");
    r = await discover(linux(home2, { openDb: recordingDb([], []) }));
    expect(r.candidates).toMatchObject([{ name: "listed", via: "folder", launcher: "modrinth", check: { ok: false, mods: 1 } }]);
    expect(r.warnings).toEqual([expect.stringMatching(/^Modrinth App: .*app\.db has no instance table I can read .*listing the profiles folder instead$/)]);
  });

  it("reads ATLauncher's instance.json files, listing an unreadable one by folder name", async () => {
    const home = await tempDir();
    await writeTree(home, {
      ".local/share/atlauncher/instances/Pack/instance.json": { id: "1.20.1", launcher: { name: "AT Pack", loaderVersion: { type: "Forge", version: "47.2.0" } } },
      ".local/share/atlauncher/instances/Pack/mods/a.jar": makeZip({}),
      ".local/share/atlauncher/instances/Broken/instance.json": "{",
      ".local/share/atlauncher/versions/1.20.1/1.20.1.jar": jar("1.20.1"),
    });
    const { candidates, warnings } = await discover(linux(home));
    expect(byName(candidates, "AT Pack")).toMatchObject({ launcher: "atlauncher", mcVersion: "1.20.1", loader: { name: "forge", version: "47.2.0" }, check: { ok: true, mods: 1 } });
    expect(byName(candidates, "Broken")).toMatchObject({ via: "folder" });
    expect(warnings).toEqual([expect.stringMatching(/^ATLauncher: .*Broken.*instance\.json isn't readable/)]);
  });

  it("reads GDLauncher's instance.json under a moved runtime path, never opening its database", async () => {
    const home = await tempDir();
    const runtime = join(home, "gdl-runtime");
    await writeTree(home, {
      ".local/share/gdlauncher_carbon/runtime_path_override": `${runtime}\n`,
      ".local/share/gdlauncher_carbon/data/gdl_conf.db": "not a database; must never be opened",
      "gdl-runtime/instances/pack1/instance.json": { name: "GDL Pack", game_configuration: { version: { release: "1.21.1", modloaders: [{ type_: "neoforge", version: "21.1.100" }] } } },
      "gdl-runtime/instances/pack1/instance/mods/a.jar": makeZip({}),
    });
    const opened: string[] = [];
    const { candidates } = await discover(linux(home, { openDb: recordingDb([], opened) }));
    expect(candidates).toMatchObject([{ name: "GDL Pack", launcher: "gdlauncher", mcVersion: "1.21.1", loader: { name: "neoforge", version: "21.1.100" }, folder: join(runtime, "instances/pack1/instance") }]);
    expect(opened).toEqual([]);
  });

  it("lists pointer files for folders no launcher knows, dropping gone folders and duplicates", async () => {
    const home = await tempDir();
    const games = join(home, ".autosketch/games");
    const server = join(home, "servers/craftoria");
    const cfInstance = join(home, "curseforge/minecraft/Instances/Pack");
    const pointer = (gameDir: string, extra = {}) => formatPointer({ format: 1, gameDir, minecraft: "1.21.1", loader: "neoforge", loaderVersion: "21.1.262", pairing: join(gameDir, "config/autosketch-bridge.toml"), ...extra });
    await writeTree(home, {
      [`.autosketch/games/${gameFolderHash(server)}.toml`]: pointer(server, { name: "Craftoria server" }),
      [`.autosketch/games/${gameFolderHash(cfInstance)}.toml`]: pointer(cfInstance),
      ".autosketch/games/0000000000000000.toml": pointer(join(home, "deleted")),
      ".autosketch/games/1111111111111111.toml": "format = 2\n",
      "servers/craftoria/mods/a.jar": makeZip({}),
      "curseforge/minecraft/Instances/Pack/minecraftinstance.json": { name: "CF Pack", gameVersion: "1.21.1" },
    });
    const { candidates, warnings } = await discover(linux(home));
    expect(candidates.map((c) => [c.name, c.launcher])).toEqual([["CF Pack", "curseforge"], ["Craftoria server", "pointer"]]);
    expect(byName(candidates, "Craftoria server")).toMatchObject({ via: "pointer", folder: server, mcVersion: "1.21.1", loader: { name: "neoforge", version: "21.1.262" } });
    expect(warnings).toEqual([`Autosketch mod: pointer file ${join(games, "1111111111111111.toml")} skipped (format 2, this version reads 1)`]);
  });

  it("reads the Windows profile under WSL through cmd.exe and wslpath (stubbed)", async () => {
    const home = await tempDir();
    const win = await tempDir();
    const toWsl = (p: string) => p.replace(/^C:[\\/]Users[\\/]me/i, win).replace(/\\/g, "/");
    const calls: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args].join(" "));
      if (cmd === "cmd.exe") return "C:\\Users\\me\r\n";
      if (cmd === "wslpath") return `${toWsl(args[1]!)}\n`;
      throw new Error(`unexpected ${cmd}`);
    };
    await writeTree(win, {
      "AppData/Roaming/CurseForge/agent/GameInstances/MinecraftGameInstance.json": [
        { name: "Craftoria", installPath: "C:\\Users\\me\\curseforge\\minecraft\\Instances\\Craftoria", gameVersion: "1.21.1", baseModLoader: { name: "neoforge-21.1.262" } },
      ],
      "curseforge/minecraft/Instances/Craftoria/minecraftinstance.json": { name: "Craftoria", gameVersion: "1.21.1" },
      "curseforge/minecraft/Install/versions/1.21.1/1.21.1.jar": jar("1.21.1"),
      [`.autosketch/games/${gameFolderHash("C:/Users/me/servers/test")}.toml`]: formatPointer({ format: 1, gameDir: "C:/Users/me/servers/test", minecraft: "1.21.1" }),
      "servers/test/mods/a.jar": makeZip({}),
    });
    const { candidates, warnings } = await discover({ platform: "linux", home, env: {}, autosketchHome: join(home, ".autosketch"), wsl: true, run });
    expect(warnings).toEqual([]);
    expect(calls[0]).toBe("cmd.exe /c echo %USERPROFILE%");
    expect(calls).toContain("wslpath -u C:\\Users\\me");
    expect(candidates.map((c) => [c.name, c.folder, c.check.ok])).toEqual([
      ["Craftoria", join(win, "curseforge/minecraft/Instances/Craftoria"), true],
      ["test", join(win, "servers/test"), false],
    ]);
  });

  it("warns and reads only the local profile when Windows can't be asked", async () => {
    const home = await tempDir();
    const { candidates, warnings } = await discover({ platform: "linux", home, env: {}, autosketchHome: join(home, ".autosketch"), wsl: true, run: async () => { throw new Error("not found"); } });
    expect(candidates).toEqual([]);
    expect(warnings).toEqual(["WSL: couldn't ask Windows for the user profile folder (cmd.exe: not found); Windows launchers not read"]);
  });

  it("gives unique ids and finds a candidate by id or folder", async () => {
    const home = await tempDir();
    await writeTree(home, {
      "curseforge/minecraft/Instances/A/minecraftinstance.json": { name: "Same Name", gameVersion: "1.21.1" },
      ".local/share/atlauncher/instances/B/instance.json": { id: "1.21.1", launcher: { name: "Same Name" } },
    });
    const { candidates } = await discover(linux(home));
    expect(candidates.map((c) => c.id)).toEqual(["same-name", "same-name-atlauncher"]);
    expect(findCandidate(candidates, "same-name-atlauncher")?.launcher).toBe("atlauncher");
    expect(findCandidate(candidates, join(home, "curseforge/minecraft/Instances/A/"))?.id).toBe("same-name");
    expect(findCandidate(candidates, "/nowhere")).toBeUndefined();
  });
});

describe("pointer file hash and version ids", () => {
  it("hashes the game folder as the game reports it, ignoring case and separators on Windows", () => {
    // Reference vectors for the mod side (14, Pointer file).
    expect(gameFolderHash("C:\\Users\\Me\\curseforge\\minecraft\\Instances\\Craftoria")).toBe("b5a55e002a16ad14");
    expect(gameFolderHash("c:/users/me/curseforge/minecraft/instances/craftoria/")).toBe("b5a55e002a16ad14");
    expect(gameFolderHash("/home/me/.local/share/PrismLauncher/instances/Pack/minecraft")).toBe("c3225877496e34ed");
    expect(gameFolderHash(windowsFormOfWslPath("/mnt/c/Users/Me/curseforge/minecraft/Instances/Craftoria"))).toBe("b5a55e002a16ad14");
  });

  it("parses loader ids from CurseForge and the vanilla launcher", () => {
    expect(curseForgeLoader("fabric-0.19.2-1.21.11", "1.21.11")).toEqual({ name: "fabric", version: "0.19.2" });
    expect(curseForgeLoader("forge-47.4.4")).toEqual({ name: "forge", version: "47.4.4" });
    expect(vanillaVersionId("neoforge-21.1.262")).toEqual({ mcVersion: "1.21.1", loader: { name: "neoforge", version: "21.1.262" } });
    expect(vanillaVersionId("neoforge-21.0.10")).toMatchObject({ mcVersion: "1.21" });
    expect(vanillaVersionId("1.20.1-forge-47.2.0")).toEqual({ mcVersion: "1.20.1", loader: { name: "forge", version: "47.2.0" } });
    expect(vanillaVersionId("quilt-loader-0.26.0-1.21")).toEqual({ mcVersion: "1.21", loader: { name: "quilt", version: "0.26.0" } });
    expect(vanillaVersionId("1.21.1")).toEqual({ mcVersion: "1.21.1" });
    expect(vanillaVersionId("my-custom")).toEqual({});
  });
});
