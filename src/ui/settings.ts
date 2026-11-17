import { unwatchFile, watchFile } from "node:fs";
import { ConfigConflictError, readConfig, writeConfig, type ConfigSnapshot } from "../core/config.js";
import {
  registeredSettings,
  settingApplies,
  settingControl,
  settingGroup,
  type Resolved,
  type Setting,
  type SettingApplies,
  type SettingControl,
  type Settings,
  type SourcedText,
} from "../core/settings.js";
import { UiRequestError } from "./errors.js";

/**
 * Settings rows for the in-game settings screen (docs/design/16-in-game-ui.md, *Settings screen*;
 * `13`, `settings.list`, `settings.set`, `settings.unset`), rewritten from the browser's
 * `/api/settings` (`15`, *Settings tab*) over the same `core/settings.ts` and `core/config.ts`.
 *
 * Writes go through `writeConfig`'s compare-and-set: the client sends the hash it last read, and a
 * file changed since (by `autosketch config`, a hand edit or the agent's own process) is `conflict`,
 * so the screen reloads instead of overwriting. A file with read problems (bad TOML, wrongly typed
 * values) is never rewritten, since a whole-file write would drop the parts that didn't parse.
 *
 * The file is watched, and re-read before every list, so the running `Settings` follows it
 * (`Settings.reload`): settings marked `live` take a change at once, `restart` ones show
 * *restart needed* while the saved value differs from the one read at startup.
 */

export interface SettingRow {
  key: string;
  group: string;
  summary?: string;
  applies: SettingApplies;
  accepts: string;
  control: SettingControl;
  /** JSON values (`null` for an unset default). */
  default: unknown;
  value: unknown;
  /** The value as text, as a control edits it (lists comma-separated). */
  text: string;
  source: { kind: string; label: string };
  /** The launch value config.toml overrides, with a sentence for the row. */
  overrides?: { label: string; raw: string; same: boolean; note: string };
  /** A config.toml value that didn't parse (skipped; the next source applied). */
  invalid?: { raw: string; note: string };
  /** An invalid launch value (the server refused to start with it, or will). */
  error?: string;
  /** The saved value differs from the one the server read at startup. */
  restartNeeded: boolean;
  /** The value in use since startup, when restart is needed. */
  running?: unknown;
}

export interface SettingsList {
  path: string;
  hash: string;
  warnings: string[];
  /** config.toml keys no registered setting declares. */
  unknown: string[];
  settings: SettingRow[];
}

export class SettingsRows {
  /** JSON of each value as read at startup (what `restart` settings are running with). */
  private readonly running = new Map<string, string>();
  private watching = false;

  constructor(
    private readonly settings: Settings,
    readonly path: string,
    private readonly log?: (msg: string) => void,
  ) {
    for (const r of settings.resolveAll()) this.running.set(r.setting.key, json(r.value));
  }

  /** Re-reads config.toml and swaps it into `Settings` when its hash changed. */
  refresh(): ConfigSnapshot {
    const snap = readConfig(this.path);
    if (snap.hash !== this.settings.config?.hash) this.settings.reload(snap);
    return snap;
  }

  /** Watches config.toml (polling: it is replaced by rename, and may not exist yet). */
  watch(intervalMs = 1000): void {
    if (this.watching) return;
    this.watching = true;
    watchFile(this.path, { persistent: false, interval: intervalMs }, this.onChange);
    // watchFile takes its first stat asynchronously; a change made before that is its baseline and
    // never fires, so check once more after the first interval.
    setTimeout(this.onChange, intervalMs * 1.5).unref();
  }

  close(): void {
    if (this.watching) unwatchFile(this.path, this.onChange);
    this.watching = false;
  }

  private readonly onChange = (): void => {
    try {
      this.refresh();
    } catch (e) {
      this.log?.(`ui: re-reading ${this.path} failed: ${(e as Error).message}`);
    }
  };

  list(): SettingsList {
    const snap = this.refresh();
    const all = registeredSettings();
    const known = new Set(all.map((s) => s.key));
    return {
      path: this.path,
      hash: snap.hash,
      warnings: snap.warnings,
      unknown: Object.keys(snap.config.settings).filter((k) => !known.has(k)),
      settings: this.settings.resolveAll(all).map((r) => this.row(r)),
    };
  }

  /** Saves a value (text, as a launch value carries it). Returns the file's new hash. */
  set(key: string, value: unknown, hash: unknown): string {
    const s = find(key);
    const text = valueText(value);
    if (text === undefined) throw new UiRequestError("bad_request", "value must be text (a list comma-separated)");
    if (s.parse(text) === undefined) throw new UiRequestError("bad_request", `${key} must be ${s.accepts} (got "${text}")`);
    return this.write(hash, (settings) => ({ ...settings, [key]: text }));
  }

  /** Removes a key from config.toml, so the launch value or default applies. Returns the new hash. */
  unset(key: string, hash: unknown): string {
    find(key);
    return this.write(hash, (settings) => {
      const { [key]: _gone, ...rest } = settings;
      return rest;
    });
  }

  /** A compare-and-set edit of `[settings]`; `conflict` on a stale hash. Returns the file's hash after. */
  write(expected: unknown, edit: (settings: Record<string, string>) => Record<string, string>): string {
    if (typeof expected !== "string") throw new UiRequestError("bad_request", "hash must be the one settings.list gave");
    const snap = readConfig(this.path);
    if (expected !== snap.hash) throw new UiRequestError("conflict", `${this.path} changed since it was read; reload and try again`);
    if (snap.warnings.length) throw new UiRequestError("conflict", `${this.path} has problems (${snap.warnings.join("; ")}); fix them by hand first, since a save would drop what didn't parse`);
    const settings = edit(snap.config.settings);
    if (json(settings) === json(snap.config.settings)) return snap.hash;
    let written: ConfigSnapshot;
    try {
      written = writeConfig({ ...snap.config, settings }, snap.hash, this.path);
    } catch (e) {
      if (e instanceof ConfigConflictError) throw new UiRequestError("conflict", `${this.path} changed since it was read; reload and try again`);
      throw e;
    }
    this.settings.reload(written);
    return written.hash;
  }

  private row(r: Resolved<unknown>): SettingRow {
    const s = r.setting;
    const applies = settingApplies(s);
    const running = this.running.get(s.key);
    const restartNeeded = applies === "restart" && running !== undefined && running !== json(r.value);
    const row: SettingRow = {
      key: s.key,
      group: settingGroup(s),
      ...(s.summary ? { summary: s.summary } : {}),
      applies,
      accepts: s.accepts,
      control: settingControl(s),
      default: s.default ?? null,
      value: r.value ?? null,
      text: displayText(r.value),
      source: { kind: r.source.kind, label: sourceLabel(r.source.kind, r.source.label) },
      restartNeeded,
      ...(restartNeeded ? { running: JSON.parse(running!) as unknown } : {}),
    };
    if (r.overrides) {
      const same = json(s.parse(r.overrides.raw)) === json(r.value);
      const by = r.overrides.source.kind === "env" ? "environment sets" : "launch command sets";
      row.overrides = {
        label: r.overrides.source.label,
        raw: r.overrides.raw,
        same,
        note: `${by} ${launchText(s, r.overrides)}; ${same ? "same value as" : "ignored,"} config.toml says ${r.raw}`,
      };
    }
    if (r.invalid) row.invalid = { raw: r.invalid.raw, note: `config.toml says "${r.invalid.raw}", which isn't ${s.accepts}; ignored, using ${r.source.kind === "default" ? "the default" : r.source.label}` };
    if (r.error) row.error = r.error;
    return row;
  }
}

function find(key: unknown): Setting<unknown> {
  const s = typeof key === "string" ? registeredSettings().find((x) => x.key === key) : undefined;
  if (!s) throw new UiRequestError("not_found", `no setting "${String(key)}"`);
  return s;
}

/** Stable JSON for comparing values (`undefined` as null). */
const json = (v: unknown): string => JSON.stringify(v ?? null);

/** A value as the text a launch value would carry (a list joined with ", "). */
function valueText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.join(", ");
  return undefined;
}

function displayText(v: unknown): string {
  if (v === undefined || v === null) return "";
  return Array.isArray(v) ? v.join(", ") : String(v);
}

/** The row's source as `15` words it: `config.toml`, `command line (--set)`, `environment: AUTOSKETCH_…`, `default`. */
function sourceLabel(kind: string, label: string): string {
  return kind === "env" ? `environment: ${label}` : kind === "set" || kind === "flag" ? `command line (${label})` : label;
}

/** A launch value as it was written: `--set observe.snapshots=off`, `--mod-order a,b`, `AUTOSKETCH_X=y`. */
function launchText(s: Setting<unknown>, t: SourcedText): string {
  return t.source.kind === "set" ? `--set ${s.key}=${t.raw}` : t.source.kind === "flag" ? `${t.source.label} ${t.raw}` : `${t.source.label}=${t.raw}`;
}
