import { parseInt0, setting, type Settings } from "../core/settings.js";

/**
 * Over-nesting limits for scoped sessions (docs/design/11-scoped-sessions.md, *Over-nesting
 * safeguard*). Mechanical size checks only: whether to delegate stays with the agent.
 */

export interface ScopeLimits {
  /** The child's work volume may be at most this fraction of the parent's work volume (or the base's bounds). */
  maxWorkRatio: number;
  /** The child's work volume must have at least this many blocks. */
  minWorkBlocks: number;
  /** Maximum fork depth below the base build. */
  maxDepth: number;
}

const parseRatio = (raw: string): number | undefined => {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined;
};

export const SCOPE_MAX_WORK_RATIO = setting("scope.maxWorkRatio", 0.5, "a number above 0 and at most 1", parseRatio);
export const SCOPE_MIN_WORK_BLOCKS = setting("scope.minWorkBlocks", 512, "an integer 1..1000000000", parseInt0(1, 1_000_000_000));
export const SCOPE_MAX_DEPTH = setting("scope.maxDepth", 3, "an integer 1..16", parseInt0(1, 16));

export const DEFAULT_SCOPE_LIMITS: ScopeLimits = { maxWorkRatio: 0.5, minWorkBlocks: 512, maxDepth: 3 };

export function scopeLimits(s: Settings): ScopeLimits {
  return { maxWorkRatio: s.get(SCOPE_MAX_WORK_RATIO), minWorkBlocks: s.get(SCOPE_MIN_WORK_BLOCKS), maxDepth: s.get(SCOPE_MAX_DEPTH) };
}
