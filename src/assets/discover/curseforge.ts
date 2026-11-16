import { basename, join } from "node:path";
import { isDir, isFile, isObject, readJson, str, subdirs } from "./fsutil.js";
import type { Found, ReaderResult, Roots } from "./types.js";
import { curseForgeLoader } from "./versions.js";

/**
 * CurseForge (`14`, *Instance discovery*; checked on a real machine). The app's record
 * `<config>/CurseForge/agent/GameInstances/MinecraftGameInstance.json` lists every instance with
 * `name`, `installPath`, `gameVersion` and `baseModLoader.name`, wherever it lives. Without it, the
 * modding folder (`minecraftRoot` in `storage.json`'s `minecraft-settings`, else the default) is
 * listed: `<root>/Instances/*` with a `minecraftinstance.json`.
 */
export async function readCurseForge(roots: Roots): Promise<ReaderResult> {
  const warnings: string[] = [];
  const app = join(roots.os === "darwin" ? roots.data : roots.config, "CurseForge");
  const recordPath = join(app, "agent", "GameInstances", "MinecraftGameInstance.json");
  const record = await readJson(recordPath);
  if (record && "value" in record && Array.isArray(record.value)) {
    const found: Found[] = [];
    let skipped = 0;
    for (const e of record.value) {
      const path = isObject(e) ? str(e.installPath) : undefined;
      if (!path) {
        skipped++;
        continue;
      }
      const folder = await roots.local(path);
      const gameVersion = str(e.gameVersion);
      const loader = curseForgeLoader(isObject(e.baseModLoader) ? str(e.baseModLoader.name) : undefined, gameVersion);
      found.push({
        name: str(e.name) ?? basename(folder),
        ...(gameVersion ? { mcVersion: gameVersion } : {}),
        ...(loader ? { loader } : {}),
        launcher: "curseforge",
        folder,
        gameDir: folder,
        via: "record",
        warnings: [],
      });
    }
    if (skipped) warnings.push(`CurseForge: ${skipped} entr${skipped === 1 ? "y" : "ies"} in ${recordPath} without installPath, skipped`);
    return { found, warnings };
  }
  if (record) warnings.push(`CurseForge: ${recordPath} is not the list it used to be (${"error" in record ? record.error : "not a list"}); listing the instance folder instead`);
  const root = await minecraftRoot(roots, app);
  const found: Found[] = [];
  const dir = join(root, "Instances");
  for (const n of await subdirs(dir)) {
    const folder = join(dir, n);
    if (!(await isFile(join(folder, "minecraftinstance.json")))) continue;
    const meta = await readJson(join(folder, "minecraftinstance.json"));
    const m = meta && "value" in meta && isObject(meta.value) ? meta.value : {};
    const gameVersion = str(m.gameVersion);
    const loader = curseForgeLoader(isObject(m.baseModLoader) ? str(m.baseModLoader.name) : undefined, gameVersion);
    found.push({ name: str(m.name) ?? n, ...(gameVersion ? { mcVersion: gameVersion } : {}), ...(loader ? { loader } : {}), launcher: "curseforge", folder, gameDir: folder, via: "folder", warnings: [] });
  }
  return { found, warnings };
}

/** `minecraftRoot` from `storage.json` → `minecraft-settings` (an object, or JSON text holding one), else the default per OS. */
async function minecraftRoot(roots: Roots, app: string): Promise<string> {
  const storage = await readJson(join(app, "storage.json"));
  if (storage && "value" in storage && isObject(storage.value)) {
    let settings: unknown = storage.value["minecraft-settings"];
    if (typeof settings === "string") {
      try {
        settings = JSON.parse(settings);
      } catch {
        settings = undefined;
      }
    }
    const root = isObject(settings) ? str(settings.minecraftRoot) : undefined;
    if (root) {
      const local = await roots.local(root);
      if (await isDir(local)) return local;
    }
  }
  return roots.os === "darwin" ? join(roots.home, "Documents", "curseforge", "minecraft") : join(roots.home, "curseforge", "minecraft");
}
