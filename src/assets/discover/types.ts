/**
 * Instance discovery types (docs/design/14-distribution.md, *Instance discovery*). The `Candidate`
 * shape is the contract the management UI's Instance tab and `autosketch instances` use.
 */

/** Which reader found a candidate. `pointer` is the companion mod's pointer file. */
export type LauncherId = "curseforge" | "prism" | "multimc" | "vanilla" | "modrinth" | "atlauncher" | "gdlauncher" | "pointer";

/** Names shown to the user, e.g. in warnings ("Modrinth App: …"). */
export const LAUNCHER_NAMES: Record<LauncherId, string> = {
  curseforge: "CurseForge",
  prism: "Prism Launcher",
  multimc: "MultiMC",
  vanilla: "Minecraft Launcher",
  modrinth: "Modrinth App",
  atlauncher: "ATLauncher",
  gdlauncher: "GDLauncher",
  pointer: "Autosketch mod",
};

/** What `02`'s check found for a candidate folder: the asset locator run on it. */
export interface InstanceCheck {
  /** The locator recognised the folder and found the game jar: the instance can be loaded as is. */
  ok: boolean;
  /** One line: "Minecraft 1.21.1, 532 mod jars", or why it can't be loaded yet. */
  detail: string;
  /** Mod jars in the game folder's `mods/`. */
  mods: number;
}

/** One instance discovery found (`14`, *Instance discovery*; the contract in docs/briefs/release/README.md). */
export interface Candidate {
  /** Short id for `autosketch setup --instance <id>`: the name as a slug, made unique. */
  id: string;
  name: string;
  /** Minecraft version as the launcher records it, when it does. */
  mcVersion?: string;
  loader?: { name: string; version?: string };
  launcher: LauncherId;
  /** The folder `setup --instance` saves (the instance folder the locator takes). */
  folder: string;
  /** The game folder (mods/, config/, schematics/); the same as `folder` for most launchers. */
  gameDir: string;
  /** Locator hints the folder alone doesn't give (a game jar outside it); `setup` saves them with the instance. */
  version?: string;
  baseJar?: string;
  /** How it was found: the launcher's own record, a listing of its instance folder, or a pointer file. */
  via: "record" | "folder" | "pointer";
  check: InstanceCheck;
  warnings: string[];
}

/** What a reader returns before ids and checks are added. */
export type Found = Omit<Candidate, "id" | "check">;

/** A reader's result: what it found, and problems worth telling the user (each naming the launcher). */
export interface ReaderResult {
  found: Found[];
  warnings: string[];
}

/**
 * The folders one user profile's launchers live under, as local paths. On Windows `data` and
 * `config` are both `%APPDATA%`; on macOS both `~/Library/Application Support`; on Linux
 * `$XDG_DATA_HOME` (`~/.local/share`) and `$XDG_CONFIG_HOME` (`~/.config`).
 */
export interface Roots {
  /** The OS the launchers run on (under WSL: `win32` for the Windows profile). */
  os: "win32" | "darwin" | "linux";
  home: string;
  data: string;
  config: string;
  /** Shown in warnings when it isn't the local profile ("Windows profile"). */
  label?: string;
  /**
   * Turns a path written in a launcher's file into a local path: absolute Windows paths go through
   * `wslpath` under WSL, relative paths are resolved against `base`.
   */
  local(path: string, base?: string): Promise<string>;
}
