import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, readConfig } from "../core/config.js";
import { parseBool, parseList, setting, Settings } from "../core/settings.js";

/**
 * Library roots (docs/design/07-library.md, Layout). A root is a folder with any of `prefabs/`,
 * `palettes/`, `procedures/` and `knowledge/`. Several roots are searched in order and the first
 * one holding a name wins, so a user's own entries shadow the starter library's.
 *
 * Which roots, and which entries are hidden, are settings (docs/design/15-management-ui.md,
 * *Library settings*): `library.roots`, `library.starter`, `library.axiom`, `library.hidden`.
 * `AUTOSKETCH_LIBRARY` keeps working as an alias for `library.roots`. Folders and files whose name
 * starts with a dot are never entries, so a root's `.trash/` (the library screen's recoverable
 * delete, docs/design/16-in-game-ui.md) never shows in a listing.
 */

export type RootKind = "library" | "axiom";

export interface LibraryRoot {
  path: string;
  /** Short label shown in listings ("user", "starter", "axiom"). */
  label: string;
  kind: RootKind;
  /** Saves (prefab_save, palette_save) go to the first writable root. */
  readOnly: boolean;
  /**
   * Entries of this root left out of every listing (`library.hidden`), as `<kind>/<name>`
   * (`prefabs/park_bench`). Only read-only roots carry it: hiding is how a starter or Axiom entry
   * is put away without deleting it; a user's own entry is deleted (recoverably) instead.
   */
  hidden?: ReadonlySet<string>;
}

/** Whether `<kind>/<name>` is hidden in `root` (`library.hidden`). */
export const isHidden = (root: LibraryRoot, kind: string, name: string): boolean => !!root.hidden?.has(`${kind}/${name}`);

// Read through `Settings` on each library call (the tools build them with `librarySettings()`), so
// a change applies at once: "live".
export const LIBRARY_ROOTS = setting<string[]>("library.roots", [], "a comma-separated list of folders", parseList, {
  group: "Library",
  summary: "Your library folders in search order; the first is where saves go. Empty: <workspace>/library. AUTOSKETCH_LIBRARY still works too.",
  applies: "live",
});
export const LIBRARY_STARTER = setting("library.starter", true, "true or false", parseBool, { group: "Library", summary: "Include the starter library shipped with Autosketch.", applies: "live" });
export const LIBRARY_AXIOM = setting("library.axiom", true, "true or false", parseBool, { group: "Library", summary: "Include the instance's Axiom blueprints as a read-only root.", applies: "live" });
export const LIBRARY_HIDDEN = setting<string[]>("library.hidden", [], "a comma-separated list of <kind>/<name>, e.g. prefabs/park_bench", parseList, {
  group: "Library",
  summary: "Starter or Axiom entries left out of every listing, as <kind>/<name>.",
  applies: "live",
});

/** The settings a library call reads now: config.toml as it is on disk, then the launch values. */
export function librarySettings(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Settings {
  return Settings.from(argv, env, readConfig());
}

/** The starter library shipped in the repo (`library/`), next to `src/` and `dist/`. */
export function starterRoot(): LibraryRoot {
  return { path: fileURLToPath(new URL("../../library/", import.meta.url)), label: "starter", kind: "library", readOnly: true };
}

export interface RootOptions {
  /** The workspace (default ~/autosketch); the default user root is `<workspace>/library`. */
  workspace: string;
  /** Minecraft instance root: adds a read-only root over `config/axiom/blueprints`. */
  instanceRoot?: string;
  /** Reads AUTOSKETCH_LIBRARY: user roots separated by the platform path delimiter, replacing the default. */
  env?: NodeJS.ProcessEnv;
  /** Include the starter library (default true, or `library.starter`). */
  starter?: boolean;
  /** The `library.*` settings; without them only `env` and the options above apply. */
  settings?: Settings;
}

/**
 * User roots first (writable), then the starter library, then the instance's Axiom blueprint
 * folder (read-only: 07's open question, resolved as the doc proposed).
 */
export function libraryRoots(opts: RootOptions): LibraryRoot[] {
  const s = opts.settings;
  const set = s?.resolve(LIBRARY_ROOTS);
  // library.roots (config.toml, --set, AUTOSKETCH_LIBRARY_ROOTS) first, then the older AUTOSKETCH_LIBRARY.
  const env = opts.env ?? (s ? process.env : undefined);
  const configured = set && set.source.kind !== "default" && !set.error ? set.value : (env?.AUTOSKETCH_LIBRARY ?? "").split(delimiter).map((x) => x.trim()).filter(Boolean);
  const user = configured.length ? configured : [join(opts.workspace, "library")];
  const roots: LibraryRoot[] = user.map((p, i) => ({ path: resolve(expandHome(p)), label: i === 0 ? "user" : `user${i + 1}`, kind: "library", readOnly: false }));
  const hidden = new Set(s ? safe(() => s.get(LIBRARY_HIDDEN), []) : []);
  const withHidden = (r: LibraryRoot): LibraryRoot => (hidden.size ? { ...r, hidden } : r);
  if (opts.starter ?? (s ? safe(() => s.get(LIBRARY_STARTER), true) : true)) roots.push(withHidden(starterRoot()));
  if (opts.instanceRoot && (s ? safe(() => s.get(LIBRARY_AXIOM), true) : true))
    roots.push(withHidden({ path: join(opts.instanceRoot, "config", "axiom", "blueprints"), label: "axiom", kind: "axiom", readOnly: true }));
  return roots;
}

/** An invalid launch value for a library setting falls back to the default rather than failing every library call. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function writableRoot(roots: readonly LibraryRoot[]): LibraryRoot {
  const r = roots.find((x) => !x.readOnly);
  if (!r) throw new Error("no writable library root is configured (set library.roots)");
  return r;
}

/** Library entry names: letters, digits, _ and -, optionally in sub-folders ("styles/gothic"). */
export const ENTRY_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function checkEntryName(kind: string, name: string): void {
  if (!ENTRY_NAME.test(name)) throw new Error(`${kind} name must start with a letter or digit and use letters, digits, _ or - (max 64; got "${name}")`);
}
