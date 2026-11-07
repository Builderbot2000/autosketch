import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Library roots (docs/design/07-library.md, Layout). A root is a folder with any of `prefabs/`,
 * `palettes/`, `procedures/` and `knowledge/`. Several roots are searched in order and the first
 * one holding a name wins, so a user's own entries shadow the starter library's.
 */

export type RootKind = "library" | "axiom";

export interface LibraryRoot {
  path: string;
  /** Short label shown in listings ("user", "starter", "axiom"). */
  label: string;
  kind: RootKind;
  /** Saves (prefab_save, palette_save) go to the first writable root. */
  readOnly: boolean;
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
  /** Include the starter library (default true). */
  starter?: boolean;
}

/**
 * User roots first (writable), then the starter library, then the instance's Axiom blueprint
 * folder (read-only: 07's open question, resolved as the doc proposed).
 */
export function libraryRoots(opts: RootOptions): LibraryRoot[] {
  const configured = (opts.env?.AUTOSKETCH_LIBRARY ?? "").split(delimiter).map((s) => s.trim()).filter(Boolean);
  const user = configured.length ? configured : [join(opts.workspace, "library")];
  const roots: LibraryRoot[] = user.map((p, i) => ({ path: resolve(p), label: i === 0 ? "user" : `user${i + 1}`, kind: "library", readOnly: false }));
  if (opts.starter !== false) roots.push(starterRoot());
  if (opts.instanceRoot) roots.push({ path: join(opts.instanceRoot, "config", "axiom", "blueprints"), label: "axiom", kind: "axiom", readOnly: true });
  return roots;
}

export function writableRoot(roots: readonly LibraryRoot[]): LibraryRoot {
  const r = roots.find((x) => !x.readOnly);
  if (!r) throw new Error("no writable library root is configured (set AUTOSKETCH_LIBRARY)");
  return r;
}

/** Library entry names: letters, digits, _ and -, optionally in sub-folders ("styles/gothic"). */
export const ENTRY_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function checkEntryName(kind: string, name: string): void {
  if (!ENTRY_NAME.test(name)) throw new Error(`${kind} name must start with a letter or digit and use letters, digits, _ or - (max 64; got "${name}")`);
}
