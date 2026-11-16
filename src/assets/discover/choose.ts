import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { expandHome } from "../../core/config.js";
import { checkInstance } from "./check.js";
import { folderKey } from "./fsutil.js";
import type { Candidate, InstanceCheck } from "./types.js";

/**
 * The candidate `setup --instance <id | path>` names: an id from the list, else a candidate whose
 * folder or game folder is that path. Undefined when neither matches (a path is then used as given).
 */
export function findCandidate(candidates: readonly Candidate[], idOrPath: string): Candidate | undefined {
  const byId = candidates.find((c) => c.id === idOrPath);
  if (byId) return byId;
  const key = folderKey(expandHome(idOrPath));
  return candidates.find((c) => folderKey(c.folder) === key || folderKey(c.gameDir) === key);
}

/**
 * Turning what the user typed or clicked into an instance choice (`14`, *Setup*), the same way for
 * `autosketch setup`, `autosketch config set instance` and the UI's Instance tab: an id from
 * discovery or a folder path, with the candidate's locator hints unless given, checked before it is
 * saved. Writing it is the caller's (`setInstance` in core/config.ts).
 */
export interface InstanceChoice {
  /** Absolute folder to save as `instance`. */
  folder: string;
  name: string;
  version?: string;
  baseJar?: string;
  check: InstanceCheck;
  /** The discovered candidate it matched, if any. */
  candidate?: Candidate;
}

/** Why a choice can't be saved: unknown id, missing folder, or a folder the locator can't load. */
export class InstanceChoiceError extends Error {
  constructor(
    message: string,
    readonly check?: InstanceCheck,
  ) {
    super(message);
    this.name = "InstanceChoiceError";
  }
}

export async function chooseInstance(idOrPath: string, opts: { version?: string; baseJar?: string }, candidates: readonly Candidate[]): Promise<InstanceChoice> {
  const candidate = findCandidate(candidates, idOrPath);
  let folder: string;
  if (candidate) folder = candidate.folder;
  else {
    folder = resolve(expandHome(idOrPath));
    if (!existsSync(folder)) {
      const ids = candidates.map((c) => c.id);
      throw new InstanceChoiceError(`no instance with id "${idOrPath}" and no folder at ${folder}${ids.length ? ` (ids: ${ids.join(", ")})` : ""}`);
    }
  }
  const version = opts.version ?? candidate?.version;
  const baseJar = opts.baseJar ? resolve(expandHome(opts.baseJar)) : candidate?.baseJar;
  const hints = { ...(version ? { version } : {}), ...(baseJar ? { baseJar } : {}) };
  const check = await checkInstance(folder, candidate?.gameDir ?? folder, hints);
  if (!check.ok) {
    const hint = !baseJar && /baseJar|base game jar/.test(check.detail) ? " (give the game's client jar with --base-jar <jar> and --version <v>)" : "";
    throw new InstanceChoiceError(`can't use ${folder}: ${check.detail}${hint}`, check);
  }
  return { folder, name: candidate?.name ?? basename(folder), ...hints, check, ...(candidate ? { candidate } : {}) };
}
