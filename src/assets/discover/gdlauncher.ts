import { join } from "node:path";
import { firstFile, isDir, isObject, readJson, readText, str, subdirs } from "./fsutil.js";
import type { Found, ReaderResult, Roots } from "./types.js";
import { loaderName } from "./versions.js";

/**
 * GDLauncher Carbon (`14`, *Instance discovery*; built from its docs *Anatomy of an Instance Folder*
 * and *Runtime path vs app data*, unverified on a real machine). App data: `<data>/gdlauncher_carbon`.
 * The runtime path is `<app data>/data/`, or the one-line `<app data>/runtime_path_override` when the
 * user moved it. Instances: `<runtime>/instances/<shortpath>/instance.json`, with the game folder in
 * `instance/` beneath it. Its database (`gdl_conf.db`) holds account tokens and is never opened.
 */
export async function readGdLauncher(roots: Roots): Promise<ReaderResult> {
  const out: ReaderResult = { found: [], warnings: [] };
  const app = join(roots.data, "gdlauncher_carbon");
  if (!(await isDir(app))) return out;
  let runtime = join(app, "data");
  const override = (await readText(join(app, "runtime_path_override")))?.trim();
  if (override) {
    const local = await roots.local(override, app);
    if (await isDir(local)) runtime = local;
    else out.warnings.push(`GDLauncher: runtime folder ${local} (runtime_path_override) not found; using ${runtime}`);
  }
  const dir = join(runtime, "instances");
  for (const n of await subdirs(dir)) {
    const folder = join(dir, n);
    const json = await readJson(join(folder, "instance.json"));
    if (!json) continue;
    const j = "value" in json && isObject(json.value) ? json.value : undefined;
    if (!j) out.warnings.push(`GDLauncher: ${join(folder, "instance.json")} isn't readable (${"error" in json ? json.error : "unexpected shape"}); listed by folder name`);
    const game = j && isObject(j.game_configuration) ? j.game_configuration : j;
    const version = game && isObject(game.version) ? game.version : undefined;
    const mcVersion = version ? str(version.release) ?? str(version.id) : game ? str(game.version) : undefined;
    const mods = version && Array.isArray(version.modloaders) ? version.modloaders.find(isObject) : undefined;
    const ln = loaderName(mods ? str(mods.type_) ?? str(mods.type) : undefined);
    const loaderVersion = mods ? str(mods.version) : undefined;
    const gameDir = join(folder, "instance");
    const f: Found = {
      name: (j ? str(j.name) : undefined) ?? n,
      ...(mcVersion ? { mcVersion, version: mcVersion } : {}),
      ...(ln ? { loader: { name: ln, ...(loaderVersion ? { version: loaderVersion } : {}) } } : {}),
      launcher: "gdlauncher",
      folder: gameDir,
      gameDir,
      via: j ? "record" : "folder",
      warnings: [],
    };
    if (mcVersion) {
      // Where Carbon keeps the game jar is unverified: the two common libraries layouts.
      const libs = join(runtime, "libraries");
      const jar = await firstFile([join(libs, "com", "mojang", "minecraft", mcVersion, `minecraft-${mcVersion}-client.jar`), join(libs, "net", "minecraft", "client", mcVersion, `client-${mcVersion}.jar`)]);
      if (jar) f.baseJar = jar;
    }
    out.found.push(f);
  }
  return out;
}
