import { join } from "node:path";
import { iniValue, isDir, isFile, isObject, readJson, readText, str, subdirs } from "./fsutil.js";
import { LAUNCHER_NAMES, type Found, type LauncherId, type ReaderResult, type Roots } from "./types.js";
import { loaderName } from "./versions.js";

/**
 * Prism Launcher and MultiMC (`14`, *Instance discovery*; Prism checked on a real machine). The
 * launcher's config (`prismlauncher.cfg` / `multimc.cfg`) names `InstanceDir`, relative to its data
 * folder unless absolute (default `instances`). Each instance folder holds `instance.cfg` (`name=`)
 * and `mmc-pack.json` (components: `net.minecraft` and the loader), and the game folder
 * `minecraft/` (or `.minecraft/`).
 */
export async function readPrism(roots: Roots): Promise<ReaderResult> {
  const out: ReaderResult = { found: [], warnings: [] };
  for (const [launcher, dataDir, cfgName] of prismDataDirs(roots)) {
    if (!(await isDir(dataDir))) continue;
    const cfg = await readText(join(dataDir, cfgName));
    const instanceDir = await roots.local(iniValue(cfg ?? "", "InstanceDir") ?? "instances", dataDir);
    if (!(await isDir(instanceDir))) {
      if (cfg !== undefined) out.warnings.push(`${LAUNCHER_NAMES[launcher]}: instance folder ${instanceDir} (InstanceDir in ${cfgName}) not found`);
      continue;
    }
    for (const n of await subdirs(instanceDir)) {
      const f = await prismInstance(launcher, join(instanceDir, n), n);
      if (f) out.found.push(f);
    }
  }
  return out;
}

/** The data folders to try, per OS: Prism (native and Flatpak), then MultiMC where it has a fixed one. */
function prismDataDirs(roots: Roots): [LauncherId, string, string][] {
  const prism: [LauncherId, string, string][] = [["prism", join(roots.os === "win32" ? roots.config : roots.data, "PrismLauncher"), "prismlauncher.cfg"]];
  if (roots.os === "linux") prism.push(["prism", join(roots.home, ".var", "app", "org.prismlauncher.PrismLauncher", "data", "PrismLauncher"), "prismlauncher.cfg"]);
  // MultiMC is portable on Windows (no fixed folder); on Linux and macOS it uses the data folder.
  if (roots.os === "linux") prism.push(["multimc", join(roots.data, "multimc"), "multimc.cfg"]);
  if (roots.os === "darwin") prism.push(["multimc", join(roots.data, "MultiMC"), "multimc.cfg"]);
  return prism;
}

async function prismInstance(launcher: LauncherId, folder: string, dirName: string): Promise<Found | undefined> {
  const cfg = await readText(join(folder, "instance.cfg"));
  if (cfg === undefined) return undefined;
  const warnings: string[] = [];
  const pack = await readJson(join(folder, "mmc-pack.json"));
  let mcVersion: string | undefined;
  let loader: Found["loader"];
  const comps = pack && "value" in pack && isObject(pack.value) && Array.isArray(pack.value.components) ? pack.value.components : undefined;
  if (comps) {
    for (const c of comps) {
      if (!isObject(c)) continue;
      const uid = str(c.uid);
      if (uid === "net.minecraft") mcVersion = str(c.version);
      else if (!loader && uid && /neoforged|minecraftforge|fabric-loader|quilt-loader/.test(uid)) {
        const name = loaderName(uid);
        const version = str(c.version);
        if (name) loader = { name, ...(version ? { version } : {}) };
      }
    }
  } else warnings.push(`${LAUNCHER_NAMES[launcher]}: no readable mmc-pack.json in ${folder}; version and loader unknown`);
  let gameDir = join(folder, "minecraft");
  if (!(await isDir(gameDir)) && (await isDir(join(folder, ".minecraft")))) gameDir = join(folder, ".minecraft");
  return {
    name: iniValue(cfg, "name") ?? dirName,
    ...(mcVersion ? { mcVersion } : {}),
    ...(loader ? { loader } : {}),
    launcher,
    folder,
    gameDir,
    via: (await isFile(join(folder, "mmc-pack.json"))) ? "record" : "folder",
    warnings,
  };
}
