import { join } from "node:path";
import { locateInstance, type LocateOptions } from "../locate.js";
import { countJars } from "./fsutil.js";
import type { InstanceCheck } from "./types.js";

/**
 * `02`'s check on a folder before it is offered (`14`, *Instance discovery*): the asset locator run
 * on it, as loading would, without opening any jar. `ok` means the folder can be loaded as is; else
 * `detail` says why (most often a game jar outside the folder, which `--base-jar` supplies).
 */
export async function checkInstance(folder: string, gameDir: string = folder, opts: Pick<LocateOptions, "version" | "baseJar"> = {}): Promise<InstanceCheck> {
  try {
    const info = await locateInstance(folder, opts);
    const mods = info.layers.filter((l) => l.role === "mod").length;
    const loader = info.loader ? `, ${info.loader.name} ${info.loader.version}` : "";
    return { ok: true, mods, detail: `Minecraft ${info.mcVersion}${loader}, ${mods} mod jar${mods === 1 ? "" : "s"}` };
  } catch (e) {
    const mods = await countJars(join(gameDir, "mods"));
    return { ok: false, mods, detail: `${mods ? `mods/ has ${mods} jar${mods === 1 ? "" : "s"}, but ` : ""}${(e as Error).message}` };
  }
}
