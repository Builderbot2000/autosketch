import { homedir } from "node:os";
import { join } from "node:path";

/** $AUTOSKETCH_CACHE, else $XDG_CACHE_HOME/autosketch, else ~/.cache/autosketch. */
export function defaultCacheDir(): string {
  return process.env.AUTOSKETCH_CACHE ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "autosketch");
}
