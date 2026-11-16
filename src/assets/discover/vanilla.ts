import { join, resolve } from "node:path";
import { isDir, isFile, isObject, readJson, str, subdirs } from "./fsutil.js";
import type { Found, ReaderResult, Roots } from "./types.js";
import { vanillaVersionId } from "./versions.js";

/**
 * The vanilla Minecraft Launcher (`14`, *Instance discovery*; checked on a real machine).
 * `<.minecraft>/launcher_profiles.json` lists profiles with `gameDir` (absent: `.minecraft` itself)
 * and `lastVersionId`. The loader comes from the version id, and the game version from the version's
 * own json (`inheritsFrom`) when it is installed. Profiles sharing a game folder are one candidate
 * (a modded profile is preferred). A game folder outside `.minecraft` gets the version and the jar in
 * `.minecraft/versions/` as locator hints.
 */
export async function readVanilla(roots: Roots): Promise<ReaderResult> {
  const warnings: string[] = [];
  const mc = vanillaDir(roots);
  if (!(await isDir(mc))) return { found: [], warnings };
  const record = await readJson(join(mc, "launcher_profiles.json"));
  const profiles = record && "value" in record && isObject(record.value) && isObject(record.value.profiles) ? record.value.profiles : undefined;
  if (record && !profiles) warnings.push(`Minecraft Launcher: ${join(mc, "launcher_profiles.json")} has no profiles list I can read (${"error" in record ? record.error : "unexpected shape"}); listing ${mc} instead`);
  const byDir = new Map<string, Found & { rank: number }>();
  for (const p of Object.values(profiles ?? {})) {
    if (!isObject(p)) continue;
    const gameDirRaw = str(p.gameDir);
    const gameDir = gameDirRaw ? await roots.local(gameDirRaw, mc) : mc;
    const id = str(p.lastVersionId);
    const parsed = id && !id.startsWith("latest-") ? await versionInfo(mc, id) : {};
    const type = str(p.type);
    const name = str(p.name) || (type === "latest-release" ? "Minecraft (latest release)" : type === "latest-snapshot" ? "Minecraft (latest snapshot)" : "Minecraft");
    const rank = (parsed.loader ? 2 : 0) + (gameDirRaw ? 1 : 0);
    const key = resolve(gameDir);
    const prev = byDir.get(key);
    if (prev && prev.rank >= rank) continue;
    const f: Found & { rank: number } = {
      name,
      ...(parsed.mcVersion ? { mcVersion: parsed.mcVersion } : {}),
      ...(parsed.loader ? { loader: parsed.loader } : {}),
      launcher: "vanilla",
      folder: gameDir,
      gameDir,
      via: "record",
      warnings: [],
      rank,
    };
    if (parsed.mcVersion) {
      f.version = parsed.mcVersion;
      if (key !== resolve(mc)) {
        const jar = join(mc, "versions", parsed.mcVersion, `${parsed.mcVersion}.jar`);
        if (await isFile(jar)) f.baseJar = jar;
      }
    }
    byDir.set(key, f);
  }
  if (!byDir.size && (await isDir(join(mc, "versions")))) {
    // No readable profiles: the game folder itself, with whichever single version is installed.
    const versions: string[] = [];
    for (const v of await subdirs(join(mc, "versions"))) if (await isFile(join(mc, "versions", v, `${v}.jar`))) versions.push(v);
    byDir.set(resolve(mc), { name: "Minecraft", ...(versions.length === 1 ? { mcVersion: versions[0]!, version: versions[0]! } : {}), launcher: "vanilla", folder: mc, gameDir: mc, via: "folder", warnings: [], rank: 0 });
  }
  return { found: [...byDir.values()].map(({ rank: _, ...f }) => f), warnings };
}

/** `.minecraft`: `%APPDATA%\.minecraft`, `~/Library/Application Support/minecraft`, `~/.minecraft`. */
export function vanillaDir(roots: Roots): string {
  return roots.os === "win32" ? join(roots.config, ".minecraft") : roots.os === "darwin" ? join(roots.data, "minecraft") : join(roots.home, ".minecraft");
}

/** Game version and loader of an installed version id: its json's `inheritsFrom` beats what the id says. */
async function versionInfo(mc: string, id: string): Promise<ReturnType<typeof vanillaVersionId>> {
  const parsed = vanillaVersionId(id);
  const json = await readJson(join(mc, "versions", id, `${id}.json`));
  const inherits = json && "value" in json && isObject(json.value) ? str(json.value.inheritsFrom) : undefined;
  return inherits ? { ...parsed, mcVersion: inherits } : parsed;
}
