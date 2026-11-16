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

/**
 * The Settings tab's endpoints (docs/design/15-management-ui.md, *Settings tab*, *Endpoints*):
 *
 *   GET    /api/settings          every registered setting, resolved (value, source, overridden
 *                                 launch value, invalid file value, restart needed), plus the
 *                                 file's path and hash
 *   PUT    /api/settings/<key>    {value, hash?} → config.toml [settings]
 *   DELETE /api/settings/<key>    {hash?}        → removes the key, so the launch value or default applies
 *
 * Writes go through `writeConfig`'s compare-and-set: the UI sends the hash it last read, and a
 * file changed since (by `autosketch config`, a hand edit or the agent's own process) answers 409,
 * so the UI reloads instead of overwriting. A file with read problems (bad TOML, wrongly typed
 * values) is never rewritten, since a whole-file write would drop the parts that didn't parse.
 *
 * The file is watched, and re-read before every GET, so the running `Settings` follows it
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

export interface SettingsView {
  path: string;
  exists: boolean;
  hash: string;
  warnings: string[];
  /** config.toml keys no registered setting declares. */
  unknown: string[];
  settings: SettingRow[];
}

export interface ApiReply {
  status: number;
  body: unknown;
}

export class SettingsApi {
  /** JSON of each value as read at startup (what `restart` settings are running with). */
  private readonly running = new Map<string, string>();
  private watching = false;

  constructor(
    private readonly settings: Settings,
    readonly path: string,
    private readonly opts: { log?: (msg: string) => void } = {},
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
  }

  close(): void {
    if (this.watching) unwatchFile(this.path, this.onChange);
    this.watching = false;
  }

  private readonly onChange = (): void => {
    try {
      this.refresh();
    } catch (e) {
      this.opts.log?.(`observe: re-reading ${this.path} failed: ${(e as Error).message}`);
    }
  };

  view(): SettingsView {
    const snap = this.refresh();
    const all = registeredSettings();
    const known = new Set(all.map((s) => s.key));
    return {
      path: this.path,
      exists: snap.exists,
      hash: snap.hash,
      warnings: snap.warnings,
      unknown: Object.keys(snap.config.settings).filter((k) => !known.has(k)),
      settings: this.settings.resolveAll(all).map((r) => this.row(r)),
    };
  }

  put(key: string, body: unknown): ApiReply {
    const s = find(key);
    if (!s) return { status: 404, body: { error: `no setting "${key}"` } };
    const b = (body ?? {}) as { value?: unknown; hash?: unknown };
    const text = valueText(b.value);
    if (text === undefined) return { status: 400, body: { error: "value must be text, a number, true/false or a list of text" } };
    if (s.parse(text) === undefined) return { status: 400, body: { error: `${key} must be ${s.accepts} (got "${text}")` } };
    return this.write(s, typeof b.hash === "string" ? b.hash : undefined, (settings) => ({ ...settings, [key]: text }));
  }

  remove(key: string, body: unknown): ApiReply {
    const s = find(key);
    if (!s) return { status: 404, body: { error: `no setting "${key}"` } };
    const hash = (body as { hash?: unknown } | undefined)?.hash;
    return this.write(s, typeof hash === "string" ? hash : undefined, (settings) => {
      const { [key]: _gone, ...rest } = settings;
      return rest;
    });
  }

  private write(s: Setting<unknown>, expected: string | undefined, edit: (settings: Record<string, string>) => Record<string, string>): ApiReply {
    const snap = readConfig(this.path);
    if (expected !== undefined && expected !== snap.hash) return conflict(this.path);
    if (snap.warnings.length) return { status: 409, body: { error: `${this.path} has problems; fix them by hand first (a save would drop what didn't parse)`, warnings: snap.warnings } };
    const settings = edit(snap.config.settings);
    if (json(settings) === json(snap.config.settings)) return { status: 200, body: this.row(this.settings.resolve(s)) };
    let written: ConfigSnapshot;
    try {
      written = writeConfig({ ...snap.config, settings }, snap.hash, this.path);
    } catch (e) {
      if (e instanceof ConfigConflictError) return conflict(this.path);
      throw e;
    }
    this.settings.reload(written);
    return { status: 200, body: { ...this.row(this.settings.resolve(s)), hash: written.hash } };
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

const find = (key: string): Setting<unknown> | undefined => registeredSettings().find((s) => s.key === key);

const conflict = (path: string): ApiReply => ({ status: 409, body: { error: `${path} changed since it was read; reload and try again`, conflict: true } });

/** Stable JSON for comparing values (`undefined` as null). */
const json = (v: unknown): string => JSON.stringify(v ?? null);

/** A PUT value as the text a launch value would carry (a list joined with ", "). */
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
