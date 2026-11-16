import { chooseInstance, InstanceChoiceError, type Candidate } from "../assets/discover/index.js";
import { folderKey } from "../assets/discover/fsutil.js";
import { ConfigConflictError, expandHome, readConfig, setInstance, unsetInstance, writeConfig, type AutosketchConfig, type ConfigSnapshot } from "../core/config.js";
import type { ApiReply } from "./settings-api.js";

/**
 * The Instance tab's endpoints (docs/design/15-management-ui.md, *Instance tab and first-run setup*,
 * *Endpoints*):
 *
 *   GET    /api/instance   the instance in use and how it was chosen, its registry and the live
 *                          link's status (read-only), what config.toml remembers, the launch
 *                          command's instance, and what discovery found (`14`)
 *   PUT    /api/instance   {id | path, version?, baseJar?, hash?} → `instance` in config.toml, then
 *                          loaded in place when nothing is loaded; otherwise a restart applies it
 *   DELETE /api/instance   {hash?} unlink: removes `instance` (the wizard shows on the next start)
 *
 * The choice goes through the same `chooseInstance` as `autosketch setup` (an id or a folder,
 * checked by the locator before anything is saved) and the same `setInstance` / `unsetInstance`
 * edits, written with `writeConfig`'s compare-and-set: a stale `hash` answers 409.
 *
 * The server side (the session, discovery, the link) comes in through `InstanceHost`, which the
 * entry point builds (src/server/instance-host.ts); `observe/` never imports `server/`.
 */

/** The instance the server is using, as the tab shows it. */
export interface InstanceStatus {
  state: "none" | "loading" | "loaded" | "failed";
  /** The instance folder as it was given (config.toml, --instance, or chosen here). */
  folder?: string;
  /** How it was chosen: `config.toml`, `--instance`, `AUTOSKETCH_INSTANCE`, or `this page`. */
  source?: { kind: string; label: string };
  name?: string;
  mcVersion?: string;
  loader?: { name: string; version?: string };
  launcher?: string;
  /** The game folder (mods/, config/). */
  gameDir?: string;
  mods?: number;
  /** Blocks in the asset registry (`02`). */
  blocks?: number;
  warnings?: string[];
  /** Why the last load failed (state `failed`, or `none` after a failed choice). */
  error?: string;
}

export interface InstanceHost {
  status(): InstanceStatus;
  /** True while an instance is loaded or loading (`session.hasInstance`): a new choice then needs a restart. */
  hasInstance(): boolean;
  /** Loads an instance in place (`session.loadInstance`). Resolves once loaded; rejects with the reason. */
  load(folder: string, opts: { version?: string; baseJar?: string }): Promise<unknown>;
  /** The instance the launch command or environment names, offered first in the wizard. */
  launch?: { folder: string; label: string };
  /** Instance discovery (`14`), cached by the host. */
  discover(refresh?: boolean): Promise<{ candidates: Candidate[]; warnings: string[] }>;
  /** The live world link (`13`), read-only. */
  link?(): { state: string; dimension?: string } | undefined;
}

export interface InstanceView {
  path: string;
  hash: string;
  warnings: string[];
  current: InstanceStatus;
  /** What config.toml remembers; null when nothing (then the page is the setup wizard). */
  saved: { folder: string; version?: string; baseJar?: string } | null;
  wizard: boolean;
  launch: { folder: string; label: string; loaded: boolean } | null;
  /** The current instance isn't the saved one: a restart switches. */
  restartNeeded: boolean;
  link: { state: string; dimension?: string } | null;
  candidates: Candidate[];
  discoveryWarnings: string[];
}

export class InstanceApi {
  constructor(
    private readonly host: InstanceHost,
    readonly path: string,
    private readonly log?: (msg: string) => void,
  ) {}

  async view(refresh = false): Promise<InstanceView> {
    const snap = readConfig(this.path);
    const found = await this.host.discover(refresh);
    const current = this.host.status();
    const saved = savedOf(snap.config);
    const launch = this.host.launch;
    return {
      path: this.path,
      hash: snap.hash,
      warnings: snap.warnings,
      current,
      saved,
      wizard: !saved,
      launch: launch ? { ...launch, loaded: sameFolder(launch.folder, current.folder) && current.state !== "none" } : null,
      restartNeeded: !!saved && current.state !== "none" && current.state !== "failed" && !sameFolder(saved.folder, current.folder),
      link: this.host.link?.() ?? null,
      candidates: found.candidates,
      discoveryWarnings: found.warnings,
    };
  }

  async put(body: unknown): Promise<ApiReply> {
    const b = (body ?? {}) as { id?: unknown; path?: unknown; version?: unknown; baseJar?: unknown; hash?: unknown };
    const target = typeof b.id === "string" && b.id.trim() ? b.id.trim() : typeof b.path === "string" && b.path.trim() ? b.path.trim() : undefined;
    if (!target) return { status: 400, body: { error: "give an instance id from the list, or a folder path" } };
    const opts = { ...(typeof b.version === "string" && b.version.trim() ? { version: b.version.trim() } : {}), ...(typeof b.baseJar === "string" && b.baseJar.trim() ? { baseJar: b.baseJar.trim() } : {}) };
    let choice;
    try {
      choice = await chooseInstance(target, opts, (await this.host.discover()).candidates);
    } catch (e) {
      if (e instanceof InstanceChoiceError) return { status: 400, body: { error: e.message, ...(e.check ? { check: e.check } : {}) } };
      throw e;
    }
    const hints = { ...(choice.version ? { version: choice.version } : {}), ...(choice.baseJar ? { baseJar: choice.baseJar } : {}) };
    const written = this.write(typeof b.hash === "string" ? b.hash : undefined, (c) => setInstance(c, choice.folder, hints));
    if ("status" in written) return written;
    // The first choice loads in place; switching away from a loaded instance needs a restart (15).
    const current = this.host.status();
    let loading = false;
    if (!this.host.hasInstance()) {
      loading = true;
      this.host.load(choice.folder, hints).catch((e: Error) => this.log?.(`setup: loading ${choice.folder} failed: ${e.message}`));
    }
    const restartNeeded = !loading && !sameFolder(choice.folder, current.folder);
    return { status: 200, body: { saved: savedOf(written.config), hash: written.hash, name: choice.name, loading, restartNeeded } };
  }

  remove(body: unknown): ApiReply {
    const hash = (body as { hash?: unknown } | undefined)?.hash;
    const written = this.write(typeof hash === "string" ? hash : undefined, unsetInstance);
    if ("status" in written) return written;
    return { status: 200, body: { saved: null, hash: written.hash, note: "Unlinked. The instance in use stays until the server restarts; the next start opens this page to choose one." } };
  }

  private write(expected: string | undefined, edit: (c: AutosketchConfig) => void): ConfigSnapshot | ApiReply {
    const snap = readConfig(this.path);
    if (expected !== undefined && expected !== snap.hash) return conflict(this.path);
    if (snap.warnings.length) return { status: 409, body: { error: `${this.path} has problems; fix them by hand first (a save would drop what didn't parse)`, warnings: snap.warnings } };
    const config = structuredClone(snap.config);
    edit(config);
    try {
      return writeConfig(config, snap.hash, this.path);
    } catch (e) {
      if (e instanceof ConfigConflictError) return conflict(this.path);
      throw e;
    }
  }
}

const conflict = (path: string): ApiReply => ({ status: 409, body: { error: `${path} changed since it was read; reload and try again`, conflict: true } });

function savedOf(c: AutosketchConfig): InstanceView["saved"] {
  if (!c.instance) return null;
  return { folder: c.instance, ...(c.version ? { version: c.version } : {}), ...(c.baseJar ? { baseJar: c.baseJar } : {}) };
}

/** Whether two instance folders are the same (`~` expanded, case-insensitive on Windows drives). */
export function sameFolder(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && folderKey(expandHome(a)) === folderKey(expandHome(b));
}
