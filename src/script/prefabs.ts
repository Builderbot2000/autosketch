import type { LoadedPrefab, Prefab } from "../library/prefabs.js";

/**
 * Prefabs for `stamp` inside scripts (docs/design/05-operations.md, Scripting; 07 stamp). Loading a
 * prefab reads its file, which is asynchronous, but a script op must finish before the script goes
 * on and the whole run is one journal entry. So `runScript` loads the prefabs a script can stamp
 * before the run starts: every string literal passed to `stamp(...)` in the source, plus names the
 * caller lists (for names computed at run time). The script then stamps from memory.
 */

/** Where scripts find prefabs: the library's resolver (name, or a cell of the last sheet) and loader. */
export interface PrefabSource {
  resolve(ref: string): Promise<Prefab>;
  load(p: Prefab): Promise<LoadedPrefab>;
}

export type PreloadedPrefabs = Map<string, { prefab: Prefab; loaded: LoadedPrefab } | Error>;

/** At most this many distinct prefabs are loaded for one run. */
export const MAX_PRELOAD = 64;

/** The string literals passed as the first argument of `stamp(` in a script's source. */
export function stampLiterals(source: string): string[] {
  const out = new Set<string>();
  const re = /\bstamp\s*\(\s*(["'`])((?:(?!\1)[^\\\n])+)\1/g;
  for (let m = re.exec(source); m; m = re.exec(source)) out.add(m[2]!);
  return [...out];
}

/**
 * Loads the prefabs a run may stamp. A name that fails to resolve is kept as its error, thrown
 * only if the script really stamps it (a literal in a comment shouldn't fail the run).
 */
export async function preloadPrefabs(source: PrefabSource, refs: readonly string[]): Promise<PreloadedPrefabs> {
  const names = [...new Set(refs)];
  if (names.length > MAX_PRELOAD) throw new Error(`a script may stamp at most ${MAX_PRELOAD} different prefabs (got ${names.length})`);
  const out: PreloadedPrefabs = new Map();
  for (const ref of names) {
    try {
      const prefab = await source.resolve(ref);
      out.set(ref, { prefab, loaded: await source.load(prefab) });
    } catch (e) {
      out.set(ref, e instanceof Error ? e : new Error(String(e)));
    }
  }
  return out;
}
