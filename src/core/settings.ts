/**
 * Server settings: named keys with defaults, read from server args and the environment. Each area
 * declares its own keys next to the code that uses them (e.g. `observe/settings.ts`), so adding
 * a setting never edits this module.
 *
 * Sources, highest priority first:
 *   --set <key>=<value>          (repeatable; also --set=<key>=<value>)
 *   --<flag> <value>             only for a setting that declares a flag alias (e.g. --mod-order),
 *                                kept so flags that predate this module keep working
 *   AUTOSKETCH_<KEY>=<value>     key upper-cased, "." and "-" become "_" (observe.log → AUTOSKETCH_OBSERVE_LOG)
 *   the setting's default
 */

export interface Setting<T> {
  key: string;
  default: T;
  /** One line for help and error messages, e.g. "true or false". */
  accepts: string;
  /** Returns undefined when the text is not a valid value. */
  parse(raw: string): T | undefined;
  /** A CLI flag alias without the dashes (`mod-order` reads `--mod-order <value>`). */
  flag?: string;
}

export function setting<T>(key: string, def: T, accepts: string, parse: (raw: string) => T | undefined, opts: { flag?: string } = {}): Setting<T> {
  if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/.test(key)) throw new Error(`bad setting key "${key}"`);
  if (opts.flag !== undefined && !/^[a-z][a-z0-9-]*$/.test(opts.flag)) throw new Error(`bad flag alias "${opts.flag}"`);
  return { key, default: def, accepts, parse, ...(opts.flag ? { flag: opts.flag } : {}) };
}

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

export class Settings {
  constructor(
    private readonly args: ReadonlyMap<string, string> = new Map(),
    private readonly env: Readonly<Record<string, string | undefined>> = {},
    private readonly argv: readonly string[] = [],
  ) {}

  /** Collects `--set key=value` args; the environment is read per key on `get`. */
  static from(argv: readonly string[] = process.argv.slice(2), env: Readonly<Record<string, string | undefined>> = process.env): Settings {
    const args = new Map<string, string>();
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]!;
      const kv = a === "--set" ? argv[++i] : a.startsWith("--set=") ? a.slice(6) : undefined;
      if (kv === undefined) continue;
      const eq = kv.indexOf("=");
      if (eq <= 0) throw new Error(`--set takes key=value (got "${kv}")`);
      args.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
    return new Settings(args, env, argv);
  }

  /** The setting's value. Throws with the key, source and accepted values when a value is invalid. */
  get<T>(s: Setting<T>): T {
    const name = envName(s.key);
    const sources: [string, string | undefined][] = [
      ["--set", this.args.get(s.key)],
      [`--${s.flag}`, s.flag ? this.flagValue(s.flag) : undefined],
      [name, this.env[name]],
    ];
    const hit = sources.find(([, v]) => v !== undefined && v !== "");
    if (!hit) return s.default;
    const [source, raw] = hit as [string, string];
    const v = s.parse(raw);
    if (v === undefined) throw new Error(`setting ${s.key} (${source}) must be ${s.accepts} (got "${raw}")`);
    return v;
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
