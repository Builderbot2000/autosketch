import { describe, expect, it } from "vitest";
import { envName, parseBool, parseInt0, parseOneOf, setting, Settings } from "../../../src/core/settings.js";

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

  it("rejects bad values with the key, source and accepted values", () => {
    expect(() => Settings.from(["--set", "observe.snapshots=always"], {}).get(MODE)).toThrow('setting observe.snapshots (--set) must be merge, checkpoint, off (got "always")');
    expect(() => Settings.from([], { AUTOSKETCH_OBSERVE_RETAIN_SESSIONS: "0" }).get(N)).toThrow("AUTOSKETCH_OBSERVE_RETAIN_SESSIONS");
    expect(() => Settings.from(["--set", "novalue"], {})).toThrow("key=value");
    expect(() => setting("Bad Key", 1, "", () => 1)).toThrow();
  });
});
