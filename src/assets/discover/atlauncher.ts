import { join } from "node:path";
import { firstFile, isDir, isObject, readJson, str, subdirs } from "./fsutil.js";
import type { Found, ReaderResult, Roots } from "./types.js";
import { loaderName } from "./versions.js";

/**
 * ATLauncher (`14`, *Instance discovery*; built from ATLauncher's `FileSystem.java` and
 * `Instance.java`, unverified on a real machine). It keeps everything beside the launcher, so only
 * the default locations are read: `%APPDATA%\ATLauncher` (the Windows installer's), the data folder
 * on macOS and Linux, and the Flatpak's. Instances: `<base>/instances/<name>/instance.json`, with
 * `id` (the Minecraft version), `launcher.name` and `launcher.loaderVersion` (`type`, `version`).
 * The instance folder is the game folder.
 */
export async function readAtLauncher(roots: Roots): Promise<ReaderResult> {
  const out: ReaderResult = { found: [], warnings: [] };
  for (const base of atLauncherDirs(roots)) {
    const dir = join(base, "instances");
    if (!(await isDir(dir))) continue;
    for (const n of await subdirs(dir)) {
      const folder = join(dir, n);
      const json = await readJson(join(folder, "instance.json"));
      if (!json) continue;
      const j = "value" in json && isObject(json.value) ? json.value : undefined;
      const launcher = j && isObject(j.launcher) ? j.launcher : undefined;
      if (!j) out.warnings.push(`ATLauncher: ${join(folder, "instance.json")} isn't readable (${"error" in json ? json.error : "unexpected shape"}); listed by folder name`);
      const mcVersion = j ? str(j.id) ?? (launcher ? str(launcher.minecraft) : undefined) : undefined;
      const lv = launcher && isObject(launcher.loaderVersion) ? launcher.loaderVersion : undefined;
      const ln = loaderName(lv ? str(lv.type) : undefined);
      const loaderVersion = lv ? str(lv.version) : undefined;
      const f: Found = {
        name: (launcher ? str(launcher.name) : undefined) ?? n,
        ...(mcVersion ? { mcVersion, version: mcVersion } : {}),
        ...(ln ? { loader: { name: ln, ...(loaderVersion ? { version: loaderVersion } : {}) } } : {}),
        launcher: "atlauncher",
        folder,
        gameDir: folder,
        via: j ? "record" : "folder",
        warnings: [],
      };
      if (mcVersion) {
        // Where ATLauncher keeps the game jar is unverified: its versions/ folder, else the libraries layout.
        const jar = await firstFile([join(base, "versions", mcVersion, `${mcVersion}.jar`), join(base, "libraries", "net", "minecraft", "client", mcVersion, `client-${mcVersion}.jar`)]);
        if (jar) f.baseJar = jar;
      }
      out.found.push(f);
    }
  }
  return out;
}

function atLauncherDirs(roots: Roots): string[] {
  if (roots.os === "win32") return [join(roots.config, "ATLauncher")];
  if (roots.os === "darwin") return [join(roots.data, "ATLauncher")];
  return [join(roots.data, "atlauncher"), join(roots.home, ".var", "app", "com.atlauncher.ATLauncher", "data", "atlauncher")];
}
