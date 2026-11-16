/**
 * Server settings: named keys with defaults, read from the user's config file, server args and the
 * environment. Each area declares its own keys next to the code that uses them (e.g.
 * `observe/settings.ts`), so adding a setting never edits this module. Declaring a setting also
 * registers it (`registeredSettings()`), which is what the management UI's Settings tab and the
 * startup conflict report are built from (docs/design/15-management-ui.md, *Settings tab*).
 *
 * Sources, highest priority first (`15`, *Settings tab*; `12`, *Settings*):
 *   config.toml [settings]       the user's saved choice (core/config.ts), written by the UI and
 *                                `autosketch config`; it beats every launch value
 *   --set <key>=<value>          (repeatable; also --set=<key>=<value>)
 *   --<flag> <value>             only for a setting that declares a flag alias (e.g. --mod-order),
 *                                kept so flags that predate this module keep working
 *   AUTOSKETCH_<KEY>=<value>     key upper-cased, "." and "-" become "_" (observe.log → AUTOSKETCH_OBSERVE_LOG)
 *   the setting's default
 *
 * The middle three are the launch values: they fill every key config.toml doesn't set. A launch
 * value that loses to config.toml is never dropped silently: `resolve()` names it and `notes()` gives
 * the one stderr line per conflict the server logs at startup. No tool result mentions it (`15`,
 * principle 1). An invalid value in config.toml is reported the same way and skipped, so the next
 * source applies; an invalid launch value is an error, as before.
 */
import type { ConfigSnapshot } from "./config.js";

export interface Setting<T> {
  key: string;
  default: T;
  /** One line for help and error messages, e.g. "true or false". */
  accepts: string;
  /** Returns undefined when the text is not a valid value. */
  parse(raw: string): T | undefined;
  /** A CLI flag alias without the dashes (`mod-order` reads `--mod-order <value>`). */
  flag?: string;
  /** One line shown under the control in the Settings tab (`15`). */
  summary?: string;
  /** Section heading in the Settings tab (`Observe`, `Scopes`, …); `settingGroup()` gives the default. */
  group?: string;
  /** Read on each use (`live`) or at startup (`restart`); `settingApplies()` defaults it (`15`, *Live versus restart*). */
  applies?: SettingApplies;
}

export type SettingApplies = "live" | "restart";

export interface SettingOptions {
  flag?: string;
  summary?: string;
  group?: string;
  applies?: SettingApplies;
}

const registry = new Map<string, Setting<unknown>>();

/** Declares and registers a setting. Declaring a key again replaces the registered one. */
export function setting<T>(key: string, def: T, accepts: string, parse: (raw: string) => T | undefined, opts: SettingOptions = {}): Setting<T> {
  if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/.test(key)) throw new Error(`bad setting key "${key}"`);
  if (opts.flag !== undefined && !/^[a-z][a-z0-9-]*$/.test(opts.flag)) throw new Error(`bad flag alias "${opts.flag}"`);
  const s: Setting<T> = {
    key,
    default: def,
    accepts,
    parse,
    ...(opts.flag ? { flag: opts.flag } : {}),
    ...(opts.summary ? { summary: opts.summary } : {}),
    ...(opts.group ? { group: opts.group } : {}),
    ...(opts.applies ? { applies: opts.applies } : {}),
  };
  registry.set(key, s as Setting<unknown>);
  return s;
}

/** Every setting declared so far, in key order. A module's settings are declared when it is imported. */
export function registeredSettings(): Setting<unknown>[] {
  return [...registry.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The Settings tab section: `group`, else the key's first segment capitalised (`scope.maxDepth` → `Scope`). */
export const settingGroup = (s: Setting<unknown>): string => s.group ?? s.key.split(".")[0]!.replace(/^./, (c) => c.toUpperCase());

export const settingApplies = (s: Setting<unknown>): SettingApplies => s.applies ?? "restart";

export const parseBool = (raw: string): boolean | undefined => {
  const s = raw.trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(s) ? true : ["0", "false", "off", "no"].includes(s) ? false : undefined;
};

export const parseInt0 = (min: number, max: number) => (raw: string): number | undefined => {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

export const parseOneOf = <T extends string>(values: readonly T[]) => (raw: string): T | undefined => {
  const s = raw.trim();
  return (values as readonly string[]).includes(s) ? (s as T) : undefined;
};

/** A comma-separated list of non-empty, trimmed entries. */
export const parseList = (raw: string): string[] | undefined => {
  const items = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : undefined;
};

/** Any non-empty text, trimmed (validated later by the code that uses it). */
export const parseText = (raw: string): string | undefined => raw.trim() || undefined;

export const envName = (key: string): string => `AUTOSKETCH_${key.replace(/[.-]/g, "_").replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;

/** Where a value came from. `label` is what the UI and the log show: `config.toml`, `--set`, `--mod-order`, `AUTOSKETCH_MOD_ORDER`, `default`. */
export interface SettingSource {
  kind: "config" | "set" | "flag" | "env" | "default";
  label: string;
}

/** A value as text from one source. */
export interface SourcedText {
  source: SettingSource;
  raw: string;
}

/** One setting resolved against every source (`15`, *Settings tab*: "each row shows"). */
export interface Resolved<T> {
  setting: Setting<T>;
  /** The effective value (the default when `error` is set). */
  value: T;
  source: SettingSource;
  /** The text the value was parsed from; absent for the default. */
  raw?: string;
  /** The launch value config.toml overrides (the highest launch source that is set), so it is never dropped silently. */
  overrides?: SourcedText;
  /** A config.toml value that didn't parse: skipped, and the next source applied. */
  invalid?: SourcedText;
  /** An invalid launch value: `get` throws this message. */
  error?: string;
}

const DEFAULT_SOURCE: SettingSource = { kind: "default", label: "default" };
const CONFIG_SOURCE: SettingSource = { kind: "config", label: "config.toml" };

export class Settings {
  private file: Readonly<Record<string, string>>;
  private snapshot: ConfigSnapshot | undefined;

  /** `config` is config.toml as read by `readConfig` (core/config.ts); without it only launch values apply. */
  constructor(
    private readonly args: ReadonlyMap<string, string> = new Map(),
    private readonly env: Readonly<Record<string, string | undefined>> = {},
    private readonly argv: readonly string[] = [],
    config?: ConfigSnapshot,
  ) {
    this.snapshot = config;
    this.file = config?.config.settings ?? {};
  }

  /** Collects `--set key=value` args; the environment is read per key on `get`. */
  static from(argv: readonly string[] = process.argv.slice(2), env: Readonly<Record<string, string | undefined>> = process.env, config?: ConfigSnapshot): Settings {
    const args = new Map<string, string>();
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      const kv = a === "--set" ? argv[++i] : a.startsWith("--set=") ? a.slice(6) : undefined;
      if (kv === undefined) continue;
      const eq = kv.indexOf("=");
      if (eq <= 0) throw new Error(`--set takes key=value (got "${kv}")`);
      args.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
    return new Settings(args, env, argv, config);
  }

  /** The config.toml snapshot in use, if any (its `hash` is what a write must name). */
  get config(): ConfigSnapshot | undefined {
    return this.snapshot;
  }

  /**
   * Swaps in a newer read of config.toml. Values already read keep what they were; only settings read
   * through `get` on each use (`applies: "live"`, `15`, *Live versus restart*) see the change.
   */
  reload(config: ConfigSnapshot): void {
    this.snapshot = config;
    this.file = config.config.settings;
  }

  /** The setting's value. Throws with the key, source and accepted values when a launch value is invalid. */
  get<T>(s: Setting<T>): T {
    const r = this.resolve(s);
    if (r.error) throw new Error(r.error);
    return r.value;
  }

  /** The setting's value, where it came from, and what it overrides or skipped. Never throws. */
  resolve<T>(s: Setting<T>): Resolved<T> {
    const launch = this.launchValues(s)[0];
    const out: Resolved<T> = { setting: s, value: s.default, source: DEFAULT_SOURCE };
    const fileRaw = this.file[s.key];
    if (fileRaw !== undefined && fileRaw.trim() !== "") {
      const v = s.parse(fileRaw);
      if (v !== undefined) {
        Object.assign(out, { value: v, source: CONFIG_SOURCE, raw: fileRaw }, launch ? { overrides: launch } : {});
        return out;
      }
      out.invalid = { source: CONFIG_SOURCE, raw: fileRaw };
    }
    if (!launch) return out;
    const v = s.parse(launch.raw);
    if (v === undefined) out.error = `setting ${s.key} (${launch.source.label}) must be ${s.accepts} (got "${launch.raw}")`;
    else Object.assign(out, { value: v, source: launch.source, raw: launch.raw });
    return out;
  }

  /** `resolve` for every registered setting (the Settings tab's rows). */
  resolveAll(settings: readonly Setting<unknown>[] = registeredSettings()): Resolved<unknown>[] {
    return settings.map((s) => this.resolve(s));
  }

  /**
   * The lines the server logs once at startup (`15`, *Settings tab*): config.toml read problems, each
   * launch value config.toml overrides with a different value, each invalid config.toml value, and
   * each config.toml key no registered setting declares (a typo, or a key from a newer version).
   */
  notes(settings: readonly Setting<unknown>[] = registeredSettings()): string[] {
    const lines = [...(this.snapshot?.warnings ?? [])];
    for (const r of this.resolveAll(settings)) {
      const s = r.setting;
      if (r.invalid) lines.push(`config.toml: setting ${s.key} must be ${s.accepts} (got "${r.invalid.raw}"); ignored, using ${r.source.kind === "default" ? "the default" : r.source.label}`);
      if (r.overrides && !sameValue(s, r.overrides.raw, r.value)) lines.push(`setting ${s.key}: launch value ${launchText(s, r.overrides)} ignored; config.toml says ${r.raw}`);
    }
    const known = new Set(settings.map((s) => s.key));
    for (const key of Object.keys(this.file)) if (!known.has(key)) lines.push(`config.toml: unknown setting ${key}, ignored`);
    return lines;
  }

  /** The launch sources that are set for `s`, highest priority first. */
  private launchValues(s: Setting<unknown>): SourcedText[] {
    const name = envName(s.key);
    const all: [SettingSource, string | undefined][] = [
      [{ kind: "set", label: "--set" }, this.args.get(s.key)],
      [{ kind: "flag", label: `--${s.flag}` }, s.flag ? this.flagValue(s.flag) : undefined],
      [{ kind: "env", label: name }, this.env[name]],
    ];
    return all.filter((e): e is [SettingSource, string] => e[1] !== undefined && e[1] !== "").map(([source, raw]) => ({ source, raw }));
  }

  /** `--<flag> <value>` or `--<flag>=<value>`; the last occurrence wins. */
  private flagValue(flag: string): string | undefined {
    let out: string | undefined;
    for (let i = 0; i < this.argv.length; i++) {
      const a = this.argv[i]!;
      if (a === `--${flag}`) out = this.argv[++i];
      else if (a.startsWith(`--${flag}=`)) out = a.slice(flag.length + 3);
    }
    return out;
  }
}

/** Whether a launch value means the same as the effective value (then overriding it is not worth a log line). */
function sameValue<T>(s: Setting<T>, raw: string, value: T): boolean {
  const v = s.parse(raw);
  return v !== undefined && JSON.stringify(v) === JSON.stringify(value);
}

/** A launch value as it was written: `--set observe.snapshots=off`, `--mod-order a,b`, `AUTOSKETCH_X=y`. */
function launchText(s: Setting<unknown>, t: SourcedText): string {
  return t.source.kind === "set" ? `--set ${s.key}=${t.raw}` : t.source.kind === "flag" ? `${t.source.label} ${t.raw}` : `${t.source.label}=${t.raw}`;
}

