/**
 * The user's saved choices: `~/.autosketch/config.toml` (docs/design/14-distribution.md, *Setup*;
 * docs/design/15-management-ui.md, *Settings tab*). One file, edited by the management UI, the
 * `autosketch setup` / `autosketch config` commands and by hand, and it beats the launch command:
 *
 *   instance = "C:/Users/me/curseforge/minecraft/Instances/Craftoria"
 *   version = "1.21.1"              (optional: `setup --version`, applies only with that instance)
 *   baseJar = "/path/to/client.jar" (optional: `setup --base-jar`, likewise)
 *   workspace = "~/autosketch"
 *   [settings]
 *   "observe.snapshots" = "merge"
 *   "scope.maxDepth" = 2
 *
 * Settings values are kept as text and go through each setting's own `parse` (core/settings.ts), so
 * a number, boolean or list in the file is turned into the text a launch value would carry (a list
 * becomes "a, b"). Top-level keys this module doesn't know are kept and written back unchanged.
 *
 * Reads and writes are synchronous: the file is tiny, the startup path that reads it is synchronous,
 * and a write's compare-and-set can't interleave with another write from this process. Writes are
 * whole-file (a temp file, then rename) and refused when the file changed since the caller read it
 * (`15`, *Library tab*, *Concurrent edits*: the same rule for every UI write). Comments in a
 * hand-edited file are not preserved by a write.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";

/** What `config.toml` holds. Absent keys are unset, so launch values or defaults apply. */
export interface AutosketchConfig {
  /** The remembered instance folder (`14`, *Setup*). `config unset instance` unlinks it. */
  instance?: string;
  /**
   * The locator's game version and client jar for that instance (`setup --version`, `--base-jar`;
   * `14`, *Setup*). They describe the `instance` they were saved with: they apply only while it is
   * set, and setting or unsetting the instance clears them.
   */
  version?: string;
  baseJar?: string;
  /** Folder for documents. */
  workspace?: string;
  /** `[settings]`: setting key → value text (`15`, *Settings tab*). */
  settings: Record<string, string>;
  /** Top-level keys this version doesn't use, written back as they were read. */
  extra: Record<string, unknown>;
}

/** One read of the file: its content, and the hash a later write must name. */
export interface ConfigSnapshot {
  path: string;
  exists: boolean;
  /** sha256 of the file's bytes, or `ABSENT` when there is no file. Pass it to `writeConfig`. */
  hash: string;
  config: AutosketchConfig;
  /** Problems found while reading (bad TOML, wrongly typed values). Those parts are left out of `config`. */
  warnings: string[];
}

/** The hash of a file that doesn't exist; `writeConfig(…, ABSENT)` creates the file only if it is still missing. */
export const ABSENT = "absent";

/** A write refused because the file changed since it was read. Re-read, re-apply, and try again. */
export class ConfigConflictError extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`${path} changed since it was read; reload it and try again`);
    this.name = "ConfigConflictError";
  }
}

/** `~/.autosketch`, or `AUTOSKETCH_HOME` when set (tests, portable setups). Pointer files live here too (`14`). */
export function autosketchHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return env.AUTOSKETCH_HOME || join(homedir(), ".autosketch");
}

export function configPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  return join(autosketchHome(env), "config.toml");
}

/** `~` or `~/…` at the start of a path saved in the file, resolved against the user's home. */
export function expandHome(path: string): string {
  return path === "~" ? homedir() : /^~[\\/]/.test(path) ? join(homedir(), path.slice(2)) : path;
}

export const hashText = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");

/** Reads the file. A missing file is an empty config; unreadable TOML is an empty config with a warning. */
export function readConfig(path: string = configPath()): ConfigSnapshot {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { path, exists: false, hash: ABSENT, config: emptyConfig(), warnings: [] };
    return { path, exists: true, hash: ABSENT, config: emptyConfig(), warnings: [`${path}: ${(e as Error).message}`] };
  }
  return { ...parseConfig(bytes.toString("utf8"), path), exists: true, hash: hashText(bytes) };
}

/** The parsing half of `readConfig`, for text already in hand. `hash` is that of `text`. */
export function parseConfig(text: string, path = "config.toml"): ConfigSnapshot {
  const config = emptyConfig();
  const warnings: string[] = [];
  const snap = { path, exists: true, hash: hashText(text), config, warnings };
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch (e) {
    warnings.push(`${path}: not valid TOML, ignored: ${(e as Error).message.split("\n")[0]}`);
    return snap;
  }
  for (const [k, v] of Object.entries(doc)) {
    if (k === "instance" || k === "workspace") {
      if (typeof v === "string" && v.trim()) config[k] = v.trim();
      else warnings.push(`${path}: ${k} must be a folder path (text), ignored`);
    } else if (k === "baseJar") {
      if (typeof v === "string" && v.trim()) config.baseJar = v.trim();
      else warnings.push(`${path}: baseJar must be a file path (text), ignored`);
    } else if (k === "version") {
      if (typeof v === "string" && v.trim()) config.version = v.trim();
      else warnings.push(`${path}: version must be a Minecraft version as text (e.g. "1.21.1"), ignored`);
    } else if (k === "settings") {
      if (!isTable(v)) {
        warnings.push(`${path}: settings must be a table ([settings]), ignored`);
        continue;
      }
      for (const [key, val] of Object.entries(v)) {
        const s = settingText(val);
        if (s === undefined) warnings.push(`${path}: setting ${key} must be text, a number, true/false or a list of those, ignored`);
        else config.settings[key] = s;
      }
    } else config.extra[k] = v;
  }
  return snap;
}

/** The file's text for a config (stable key order: instance, version, baseJar, workspace, other keys, [settings]). */
export function formatConfig(config: AutosketchConfig): string {
  const doc: Record<string, unknown> = {};
  if (config.instance !== undefined) doc.instance = config.instance;
  if (config.version !== undefined) doc.version = config.version;
  if (config.baseJar !== undefined) doc.baseJar = config.baseJar;
  if (config.workspace !== undefined) doc.workspace = config.workspace;
  Object.assign(doc, config.extra);
  if (Object.keys(config.settings).length) doc.settings = { ...config.settings };
  const out = stringify(doc).trim();
  return out ? `${out}\n` : "";
}

/**
 * Replaces the whole file with `config`, provided it still has hash `expectedHash` (from the snapshot
 * the caller edited), else throws `ConfigConflictError`. Writes a temp file beside it, then renames,
 * so a reader never sees half a file. Returns the new snapshot.
 */
export function writeConfig(config: AutosketchConfig, expectedHash: string, path: string = configPath()): ConfigSnapshot {
  const current = currentHash(path);
  if (current !== expectedHash) throw new ConfigConflictError(path, expectedHash, current);
  const text = formatConfig(config);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { path, exists: true, hash: hashText(text), config: structuredClone(config), warnings: [] };
}

/**
 * Read, change, write, for writers that hold no earlier snapshot (the command line): applies `edit`
 * to a fresh read and writes it with that read's hash, starting over from a new read when another
 * writer got in between (a few times, then `ConfigConflictError`). The UI, which shows the user what
 * it read, passes its own hash to `writeConfig` instead.
 */
export function updateConfig(edit: (config: AutosketchConfig) => void, path: string = configPath()): ConfigSnapshot {
  for (let attempt = 0; ; attempt++) {
    const snap = readConfig(path);
    const config = structuredClone(snap.config);
    edit(config);
    try {
      return writeConfig(config, snap.hash, path);
    } catch (e) {
      if (!(e instanceof ConfigConflictError) || attempt >= 4) throw e;
    }
  }
}

/** Saves an instance choice into `config`: `version` and `baseJar` go with it, so stale ones from an earlier choice are cleared. */
export function setInstance(config: AutosketchConfig, instance: string, opts: { version?: string; baseJar?: string } = {}): void {
  config.instance = instance;
  delete config.version;
  delete config.baseJar;
  if (opts.version) config.version = opts.version;
  if (opts.baseJar) config.baseJar = opts.baseJar;
}

/** Unlinks the instance (`config unset instance`, the UI's *Unlink instance*): `version` and `baseJar` go with it. */
export function unsetInstance(config: AutosketchConfig): void {
  delete config.instance;
  delete config.version;
  delete config.baseJar;
}

function currentHash(path: string): string {
  try {
    return hashText(readFileSync(path));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return ABSENT;
    throw e;
  }
}

const emptyConfig = (): AutosketchConfig => ({ settings: {}, extra: {} });

const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);

/** A TOML value as the text a launch value would carry, or undefined for tables and dates. */
function settingText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const items = v.map((x) => (typeof x === "object" && x !== null ? undefined : settingText(x)));
    return items.every((x) => x !== undefined) ? items.join(", ") : undefined;
  }
  return undefined;
}
