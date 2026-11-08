import { lstat, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** $AUTOSKETCH_CACHE, else $XDG_CACHE_HOME/autosketch, else ~/.cache/autosketch. */
export function defaultCacheDir(): string {
  return process.env.AUTOSKETCH_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "autosketch");
}

export interface PruneOptions {
  /**
   * Which files in the directory belong to this cache. Capture group 1 is the file's key group:
   * files sharing a group are kept or removed together (e.g. all sheets of one palette index).
   * Files that don't match are never touched.
   */
  match: RegExp;
  /** The group in use now; always kept. */
  current: string;
  /** How many other groups to keep, most recently modified first (default 2). */
  keep?: number;
  /** Leftover `<file>.<pid>.<hex>.tmp` writes of matching files older than this are removed (default 1 h). */
  tmpAgeMs?: number;
  /** Clock for tests. */
  now?: number;
}

export const DEFAULT_PRUNE_KEEP = 2;
const TMP_SUFFIX = /\.\d+\.[0-9a-f]+\.tmp$/;

/**
 * Removes stale cache files (02, Cache): files keyed by an older stack fingerprint, plugin set or
 * code hash stop being read but would otherwise stay forever. Keeps the current group and the
 * `keep` most recently modified others (another instance or settings set may share the cache), by
 * the newest mtime in each group. Only plain files directly inside `dir` whose names match are
 * considered (no recursion, no symlinks), so nothing outside the cache is touched. Never throws;
 * returns the names removed.
 */
export async function pruneCache(dir: string, opts: PruneOptions): Promise<string[]> {
  const keep = Math.max(0, opts.keep ?? DEFAULT_PRUNE_KEEP);
  const now = opts.now ?? Date.now();
  const tmpAge = opts.tmpAgeMs ?? 3_600_000;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const groups = new Map<string, { files: string[]; mtime: number }>();
  const removable: string[] = [];
  for (const name of names) {
    const tmp = TMP_SUFFIX.test(name);
    const m = opts.match.exec(tmp ? name.replace(TMP_SUFFIX, "") : name);
    if (!m) continue;
    let st;
    try {
      st = await lstat(join(dir, name));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (tmp) {
      if (now - st.mtimeMs > tmpAge) removable.push(name);
      continue;
    }
    const key = m[1] ?? m[0];
    const g = groups.get(key) ?? { files: [], mtime: 0 };
    g.files.push(name);
    g.mtime = Math.max(g.mtime, st.mtimeMs);
    groups.set(key, g);
  }
  const others = [...groups].filter(([k]) => k !== opts.current).sort((a, b) => b[1].mtime - a[1].mtime || (a[0] < b[0] ? -1 : 1));
  for (const [, g] of others.slice(keep)) removable.push(...g.files);
  const removed: string[] = [];
  for (const name of removable.sort()) {
    try {
      await unlink(join(dir, name));
      removed.push(name);
    } catch {
      /* already gone, or not ours to remove */
    }
  }
  return removed;
}
