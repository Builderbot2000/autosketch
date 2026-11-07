/**
 * Server settings: named keys with defaults, read from server args and the environment. Each area
 * declares its own keys next to the code that uses them (e.g. `observe/settings.ts`), so adding
 * a setting never edits this module.
 *
 * Sources, highest priority first:
 *   --set <key>=<value>          (repeatable; also --set=<key>=<value>)
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
}

export function setting<T>(key: string, def: T, accepts: string, parse: (raw: string) => T | undefined): Setting<T> {
  if (!/^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/.test(key)) throw new Error(`bad setting key "${key}"`);
  return { key, default: def, accepts, parse };
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

export const envName = (key: string): string => `AUTOSKETCH_${key.replace(/[.-]/g, "_").replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}`;

export class Settings {
  constructor(
    private readonly args: ReadonlyMap<string, string> = new Map(),
    private readonly env: Readonly<Record<string, string | undefined>> = {},
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
    return new Settings(args, env);
  }

  /** The setting's value. Throws with the key, source and accepted values when a value is invalid. */
  get<T>(s: Setting<T>): T {
    const fromArg = this.args.get(s.key);
    const name = envName(s.key);
    const raw = fromArg ?? this.env[name];
    if (raw === undefined || raw === "") return s.default;
    const v = s.parse(raw);
    if (v === undefined) throw new Error(`setting ${s.key} (${fromArg !== undefined ? "--set" : name}) must be ${s.accepts} (got "${raw}")`);
    return v;
  }
}
