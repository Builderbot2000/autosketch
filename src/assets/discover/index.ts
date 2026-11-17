import { homedir } from "node:os";
import { join } from "node:path";
import { autosketchHome } from "../../core/config.js";
import { readAtLauncher } from "./atlauncher.js";
import { checkInstance } from "./check.js";
import { readCurseForge } from "./curseforge.js";
import { folderKey, isDir } from "./fsutil.js";
import { readGdLauncher } from "./gdlauncher.js";
import { openReadOnly, readModrinth, type OpenDb } from "./modrinth.js";
import { readPointers } from "./pointer.js";
import { readPrism } from "./prism.js";
import { detectWsl, localRoots, runCommand, wslWindowsRoots, type Run } from "./roots.js";
import type { Candidate, Found, ReaderResult, Roots } from "./types.js";
import { readVanilla } from "./vanilla.js";
import { slug } from "./versions.js";

export type { Candidate, InstanceCheck, LauncherId } from "./types.js";
export { LAUNCHER_NAMES } from "./types.js";
export { checkInstance } from "./check.js";
export { chooseInstance, findCandidate, InstanceChoiceError, type InstanceChoice } from "./choose.js";
export { formatPointer, gameFolderHash, parsePointer, POINTER_FORMAT, windowsFormOfWslPath, type Pointer } from "./pointer.js";

/**
 * Instance discovery (docs/design/14-distribution.md, *Instance discovery*): fixed, known locations
 * only, never a search of the user's folders. For the local profile, and under WSL also the Windows
 * profile: each launcher's own record (CurseForge, Prism/MultiMC, vanilla, Modrinth App, ATLauncher,
 * GDLauncher), falling back to listing its default instance folder; then the companion mod's pointer
 * files. Every candidate goes through `02`'s check (`checkInstance`) before it is listed.
 */
export interface DiscoverOptions {
  platform?: NodeJS.Platform;
  /** The local user's home folder (default `os.homedir()`). */
  home?: string;
  /** Environment (`APPDATA`, `XDG_*`, `AUTOSKETCH_HOME`, `WSL_DISTRO_NAME`); default `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Where pointer files live: `<autosketch home>/games` (default `autosketchHome(env)`). */
  autosketchHome?: string;
  /** Read the Windows profile too (default: when running under WSL). */
  wsl?: boolean;
  /** Runs `cmd.exe` and `wslpath` (stubbed in tests). */
  run?: Run;
  /** Opens Modrinth's database read-only (stubbed in tests to record the SQL). */
  openDb?: OpenDb;
}

export interface Discovery {
  candidates: Candidate[];
  /** Problems worth showing (a launcher record that couldn't be read, WSL unavailable), each naming its source. */
  warnings: string[];
}

/** The candidates alone (the contract in docs/briefs/release/README.md). */
export async function discoverInstances(opts: DiscoverOptions = {}): Promise<Candidate[]> {
  return (await discover(opts)).candidates;
}

export async function discover(opts: DiscoverOptions = {}): Promise<Discovery> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const warnings: string[] = [];
  const profiles: Roots[] = [localRoots(platform, opts.home ?? homedir(), env)];
  if (opts.wsl ?? detectWsl(env, platform)) {
    const w = await wslWindowsRoots(opts.run ?? runCommand);
    if (w.roots) profiles.push(w.roots);
    if (w.warning) warnings.push(w.warning);
  }
  const found: Found[] = [];
  const take = (r: ReaderResult, label?: string) => {
    found.push(...r.found);
    warnings.push(...r.warnings.map((w) => (label ? `${w} (${label})` : w)));
  };
  for (const roots of profiles) {
    const results = await Promise.all([
      readCurseForge(roots),
      readPrism(roots),
      readVanilla(roots),
      readModrinth(roots, opts.openDb ?? openReadOnly),
      readAtLauncher(roots),
      readGdLauncher(roots),
    ]);
    for (const r of results) take(r, roots.label);
  }
  // Pointer files: this profile's, and under WSL the Windows profile's (the mod runs on Windows).
  take(await readPointers(join(opts.autosketchHome ?? autosketchHome(env), "games"), profiles[0]!));
  for (const roots of profiles.slice(1)) take(await readPointers(join(roots.home, ".autosketch", "games"), roots), roots.label);

  // One candidate per game folder: launcher records first, pointers only for folders no launcher knows.
  // A launcher's candidate still notes that the mod wrote a pointer for its folder (16, *Command line*).
  const pointed = new Set(found.filter((f) => f.via === "pointer").map((f) => folderKey(f.gameDir)));
  const seen = new Set<string>();
  const unique: Found[] = [];
  for (const f of found) {
    const key = folderKey(f.gameDir);
    if (seen.has(key) || !(await isDir(f.folder))) continue;
    seen.add(key);
    unique.push(f);
  }
  const ids = new Set<string>();
  const candidates = await Promise.all(
    unique.map(async (f): Promise<Candidate> => {
      const check = await checkInstance(f.folder, f.gameDir, { ...(f.version ? { version: f.version } : {}), ...(f.baseJar ? { baseJar: f.baseJar } : {}) });
      return { id: "", ...f, ...(pointed.has(folderKey(f.gameDir)) ? { pointer: true as const } : {}), check };
    }),
  );
  for (const c of candidates) c.id = uniqueId(c, ids);
  return { candidates, warnings };
}

function uniqueId(c: Candidate, taken: Set<string>): string {
  const base = slug(c.name);
  let id = taken.has(base) ? `${base}-${c.launcher}` : base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${c.launcher}-${i}`;
  taken.add(id);
  return id;
}
