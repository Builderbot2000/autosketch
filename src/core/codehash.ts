import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Hash of the source of the given sibling modules, for cache keys: derived data is invalidated
 * automatically whenever the code that derives it changes. Works from compiled .js and from .ts
 * (tsx/vitest), since the same relative names resolve in both layouts.
 */
export function codeHash(baseUrl: string, modules: string[]): string {
  const h = createHash("sha1");
  for (const m of modules) {
    for (const ext of [".js", ".ts"]) {
      try {
        h.update(readFileSync(fileURLToPath(new URL(m + ext, baseUrl))));
        break;
      } catch {
        /* try next extension */
      }
    }
  }
  return h.digest("hex").slice(0, 12);
}
