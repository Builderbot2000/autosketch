import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../src/core/config.js";
import { envName, parseBool, parseInt0, parseList, parseOneOf, registeredSettings, setting, settingApplies, settingGroup, Settings } from "../../../src/core/settings.js";

const FLAG = setting("observe.log", true, "true or false", parseBool);
const MODE = setting("observe.snapshots", "off", "merge, checkpoint, off", parseOneOf(["merge", "checkpoint", "off"] as const));
const N = setting("observe.retainSessions", 20, "an integer 1..100", parseInt0(1, 100));

describe("settings", () => {
  it("maps keys to env names", () => {
    expect(envName("observe.log")).toBe("AUTOSKETCH_OBSERVE_LOG");
    expect(envName("observe.retainSessions")).toBe("AUTOSKETCH_OBSERVE_RETAIN_SESSIONS");
  });

  it("uses defaults, then env, then --set (highest)", () => {
    expect(Settings.from([], {}).get(FLAG)).toBe(true);
    expect(Settings.from([], { AUTOSKETCH_OBSERVE_LOG: "off" }).get(FLAG)).toBe(false);
    expect(Settings.from(["--set", "observe.log=yes"], { AUTOSKETCH_OBSERVE_LOG: "off" }).get(FLAG)).toBe(true);
    expect(Settings.from(["--instance", "x", "--set=observe.snapshots=checkpoint"], {}).get(MODE)).toBe("checkpoint");
    expect(Settings.from([], { AUTOSKETCH_OBSERVE_RETAIN_SESSIONS: "5" }).get(N)).toBe(5);
  });

  it("reads a declared flag alias between --set and the environment", () => {
    const LIST = setting<string[] | undefined>("modOrder", undefined, "a list", parseList, { flag: "mod-order" });
    expect(envName("modOrder")).toBe("AUTOSKETCH_MOD_ORDER");
    expect(Settings.from([], {}).get(LIST)).toBeUndefined();
    expect(Settings.from([], { AUTOSKETCH_MOD_ORDER: "a, b" }).get(LIST)).toEqual(["a", "b"]);
    expect(Settings.from(["--mod-order", "c"], { AUTOSKETCH_MOD_ORDER: "a" }).get(LIST)).toEqual(["c"]);
    expect(Settings.from(["--mod-order=d,e"], {}).get(LIST)).toEqual(["d", "e"]);
    expect(Settings.from(["--mod-order", "c", "--set", "modOrder=z"], {}).get(LIST)).toEqual(["z"]);
    expect(() => Settings.from(["--mod-order", " , "], {}).get(LIST)).toThrow("setting modOrder (--mod-order) must be a list");
    // Settings without an alias ignore look-alike flags.
    expect(Settings.from(["--observe.log", "false"], {}).get(FLAG)).toBe(true);
    expect(() => setting("x", 1, "", () => 1, { flag: "--x" })).toThrow(/flag alias/);
  });

  it("rejects bad values with the key, source and accepted values", () => {
    expect(() => Settings.from(["--set", "observe.snapshots=always"], {}).get(MODE)).toThrow('setting observe.snapshots (--set) must be merge, checkpoint, off (got "always")');
    expect(() => Settings.from([], { AUTOSKETCH_OBSERVE_RETAIN_SESSIONS: "0" }).get(N)).toThrow("AUTOSKETCH_OBSERVE_RETAIN_SESSIONS");
    expect(() => Settings.from(["--set", "novalue"], {})).toThrow("key=value");
    expect(() => setting("Bad Key", 1, "", () => 1)).toThrow();
  });
});

describe("settings: config.toml layer (15, Settings tab)", () => {
  const file = (settings: string) => parseConfig(`[settings]\n${settings}\n`);
  const all = [FLAG, MODE, N];

  it("puts config.toml before --set, and names the launch value it overrides once", () => {
    const s = Settings.from(["--set", "observe.snapshots=off"], {}, file('"observe.snapshots" = "merge"'));
    expect(s.get(MODE)).toBe("merge");
    expect(s.resolve(MODE)).toMatchObject({
      value: "merge",
      source: { kind: "config", label: "config.toml" },
      raw: "merge",
      overrides: { source: { kind: "set", label: "--set" }, raw: "off" },
    });
    expect(s.notes(all)).toEqual(["setting observe.snapshots: launch value --set observe.snapshots=off ignored; config.toml says merge"]);
  });

  it("lets the --set value apply again once the key is removed from config.toml", () => {
    const s = Settings.from(["--set", "observe.snapshots=off"], {}, file('"observe.snapshots" = "merge"'));
    s.reload(parseConfig(""));
    expect(s.resolve(MODE)).toMatchObject({ value: "off", source: { kind: "set" } });
    expect(s.resolve(MODE).overrides).toBeUndefined();
    expect(Settings.from(["--set", "observe.snapshots=off"], {}, file("")).notes(all)).toEqual([]);
  });

  it("beats flag aliases and the environment too, and logs nothing when they agree", () => {
    const LIST = setting<string[] | undefined>("modOrder", undefined, "a list", parseList, { flag: "mod-order" });
    const s = Settings.from(["--mod-order", "a,b"], { AUTOSKETCH_OBSERVE_RETAIN_SESSIONS: "5", AUTOSKETCH_OBSERVE_LOG: "on" }, file('"modOrder" = ["c", "d"]\n"observe.retainSessions" = 7\n"observe.log" = true'));
    expect(s.get(LIST)).toEqual(["c", "d"]);
    expect(s.resolve(LIST).overrides).toEqual({ source: { kind: "flag", label: "--mod-order" }, raw: "a,b" });
    expect(s.get(N)).toBe(7);
    expect(s.resolve(N).overrides).toEqual({ source: { kind: "env", label: "AUTOSKETCH_OBSERVE_RETAIN_SESSIONS" }, raw: "5" });
    expect(s.resolve(FLAG).overrides?.raw).toBe("on");
    expect(s.notes([LIST, N, FLAG])).toEqual([
      "setting modOrder: launch value --mod-order a,b ignored; config.toml says c, d",
      "setting observe.retainSessions: launch value AUTOSKETCH_OBSERVE_RETAIN_SESSIONS=5 ignored; config.toml says 7",
    ]);
  });

  it("skips an invalid config.toml value with a note, so the next source applies", () => {
    const s = Settings.from([], { AUTOSKETCH_OBSERVE_RETAIN_SESSIONS: "9" }, file('"observe.snapshots" = "always"\n"observe.retainSessions" = 0'));
    expect(s.get(MODE)).toBe("off");
    expect(s.resolve(MODE)).toMatchObject({ source: { kind: "default" }, invalid: { source: { kind: "config" }, raw: "always" } });
    expect(s.get(N)).toBe(9);
    expect(s.notes(all)).toEqual([
      'config.toml: setting observe.snapshots must be merge, checkpoint, off (got "always"); ignored, using the default',
      'config.toml: setting observe.retainSessions must be an integer 1..100 (got "0"); ignored, using AUTOSKETCH_OBSERVE_RETAIN_SESSIONS',
    ]);
  });

  it("ignores an invalid launch value config.toml overrides; resolve never throws", () => {
    const s = Settings.from(["--set", "observe.snapshots=always"], {}, file('"observe.snapshots" = "merge"'));
    expect(s.get(MODE)).toBe("merge");
    const bad = Settings.from(["--set", "observe.snapshots=always"], {});
    expect(bad.resolve(MODE)).toMatchObject({ value: "off", error: 'setting observe.snapshots (--set) must be merge, checkpoint, off (got "always")' });
    expect(() => bad.get(MODE)).toThrow("must be merge");
  });

  it("notes unknown config.toml keys and the file's own warnings", () => {
    const s = Settings.from([], {}, parseConfig('[settings]\n"observe.snapshot" = "merge"\n"x" = { a = 1 }\n', "c.toml"));
    expect(s.notes(all)).toEqual(["c.toml: setting x must be text, a number, true/false or a list of those, ignored", "config.toml: unknown setting observe.snapshot, ignored"]);
  });

  it("registers settings with optional summary, group and applies", () => {
    const LIVE = setting("test.liveThing", 1, "a number", parseInt0(0, 9), { summary: "One line.", group: "Tests", applies: "live" });
    expect(LIVE).toMatchObject({ summary: "One line.", group: "Tests", applies: "live" });
    expect(registeredSettings()).toContain(LIVE);
    expect(settingGroup(LIVE)).toBe("Tests");
    expect(settingApplies(LIVE)).toBe("live");
    expect(settingGroup(N)).toBe("Observe");
    expect(settingApplies(N)).toBe("restart");
    expect(Object.keys(N)).not.toContain("summary");
    expect(Settings.from([], {}).resolveAll([N, FLAG]).map((r) => [r.setting.key, r.value, r.source.label])).toEqual([
      ["observe.retainSessions", 20, "default"],
      ["observe.log", true, "default"],
    ]);
  });
});
