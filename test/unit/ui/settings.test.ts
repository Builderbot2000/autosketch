import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../../src/core/config.js";
import { registeredSettings, settingControl, Settings } from "../../../src/core/settings.js";
import { OBSERVE_SNAPSHOTS } from "../../../src/observe/settings.js";
import { SCOPE_MAX_DEPTH } from "../../../src/scope/settings.js";
import { UiRequestError } from "../../../src/ui/errors.js";
import { SettingsRows } from "../../../src/ui/settings.js";
// Every area that declares settings, so the registry is the server's.
import "../../../src/assets/settings.js";
import "../../../src/server/settings.js";
import "../../../src/world/settings.js";

/** Settings rows for the in-game settings screen (16, *Settings screen*; 13, `settings.*`), from 15's Settings tab. */

const roots: string[] = [];
afterAll(() => roots.forEach((d) => rmSync(d, { recursive: true, force: true })));

function rows(argv: string[] = [], env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "autosketch-ui-settings-"));
  roots.push(dir);
  const path = join(dir, "config.toml");
  writeFileSync(path, '[settings]\n"scope.maxDepth" = 2\n');
  const settings = Settings.from(argv, env, readConfig(path));
  return { path, settings, rows: new SettingsRows(settings, path) };
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    if (e instanceof UiRequestError) return e.code;
    throw e;
  }
  return undefined;
};

describe("settings rows", () => {
  it("lists every registered setting with control, source, overridden launch value and restart note", () => {
    const { rows: r } = rows(["--set", "observe.snapshots=checkpoint", "--set", "scope.maxDepth=4"], { AUTOSKETCH_OBSERVE_LOG: "false" });
    let view = r.list();
    expect(view.settings.map((s) => s.key)).toEqual(registeredSettings().map((s) => s.key));
    const row = (k: string) => view.settings.find((s) => s.key === k);
    expect(row("scope.maxDepth")).toMatchObject({
      group: "Scopes",
      applies: "restart",
      control: { type: "number", min: 1, max: 16 },
      value: 2,
      source: { kind: "config", label: "config.toml" },
      overrides: { label: "--set", raw: "4", same: false, note: "launch command sets --set scope.maxDepth=4; ignored, config.toml says 2" },
      restartNeeded: false,
    });
    expect(row("observe.snapshots")).toMatchObject({ control: { type: "select", options: ["merge", "checkpoint", "off"] }, value: "checkpoint", source: { kind: "set", label: "command line (--set)" } });
    expect(row("observe.log")).toMatchObject({ control: { type: "toggle" }, value: false, source: { kind: "env", label: "environment: AUTOSKETCH_OBSERVE_LOG" } });
    expect(row("modOrder")).toMatchObject({ group: "Assets", control: { type: "list" }, value: null, default: null });
    for (const s of view.settings) expect(s.summary, s.key).toBeTruthy();

    // Saving: config.toml beats the launch value, and the running value is now stale.
    const hash = r.set("observe.snapshots", "merge", view.hash);
    view = r.list();
    expect(view.hash).toBe(hash);
    expect(row("observe.snapshots")).toMatchObject({ value: "merge", source: { kind: "config" }, restartNeeded: true, running: "checkpoint", overrides: { note: "launch command sets --set observe.snapshots=checkpoint; ignored, config.toml says merge" } });
    // Reset: the launch value applies again, and matches what is running.
    r.unset("observe.snapshots", hash);
    view = r.list();
    expect(row("observe.snapshots")).toMatchObject({ value: "checkpoint", source: { kind: "set" }, restartNeeded: false });
    expect(row("observe.snapshots")!.overrides).toBeUndefined();
  });

  it("round-trips through config.toml, follows outside edits, and refuses stale or invalid writes", () => {
    const { rows: r, path, settings } = rows();
    let view = r.list();
    expect(code(() => r.set("scope.maxDepth", 99, view.hash))).toBe("bad_request");
    expect(code(() => r.set("no.such", 1, view.hash))).toBe("not_found");
    expect(code(() => r.set("scope.maxDepth", 5, undefined))).toBe("bad_request");
    const hash = r.set("scope.maxDepth", 5, view.hash);
    expect(readConfig(path).config.settings["scope.maxDepth"]).toBe("5");
    expect(settings.get(SCOPE_MAX_DEPTH)).toBe(5);

    // `autosketch config set` (the same store) changes the file behind the screen's back.
    const snap = readConfig(path);
    writeConfig({ ...snap.config, settings: { ...snap.config.settings, "observe.snapshots": "merge" } }, snap.hash, path);
    expect(code(() => r.set("scope.maxDepth", 7, hash))).toBe("conflict");
    expect(readConfig(path).config.settings).toEqual({ "scope.maxDepth": "5", "observe.snapshots": "merge" });
    view = r.list();
    expect(view.settings.find((s) => s.key === "observe.snapshots")).toMatchObject({ value: "merge", source: { kind: "config" } });
    expect(settings.get(OBSERVE_SNAPSHOTS)).toBe("merge");

    // A file with problems is reported and never rewritten (a save would drop what didn't parse).
    writeFileSync(path, "[settings\n");
    view = r.list();
    expect(view.warnings[0]).toMatch(/not valid TOML/);
    expect(code(() => r.set("scope.maxDepth", 3, view.hash))).toBe("conflict");
    expect(readFileSync(path, "utf8")).toBe("[settings\n");

    // An invalid value written by hand shows on its row, and the next source applies.
    writeFileSync(path, '[settings]\n"scope.maxDepth" = "deep"\n"other.key" = "x"\n');
    view = r.list();
    expect(view.settings.find((s) => s.key === "scope.maxDepth")).toMatchObject({ value: 3, source: { kind: "default" }, invalid: { raw: "deep" } });
    expect(view.unknown).toEqual(["other.key"]);
  });

  it("reloads Settings when config.toml changes on disk, with no request", async () => {
    const { rows: r, path, settings } = rows();
    r.watch(50);
    const snap = readConfig(path);
    writeConfig({ ...snap.config, settings: { "scope.maxDepth": "6" } }, snap.hash, path);
    const end = Date.now() + 10_000;
    while (settings.get(SCOPE_MAX_DEPTH) !== 6 && Date.now() < end) await new Promise((res) => setTimeout(res, 20));
    expect(settings.get(SCOPE_MAX_DEPTH)).toBe(6);
    r.close();
  });

  it("picks the control from the parser", () => {
    const byKey = new Map(registeredSettings().map((s) => [s.key, settingControl(s)]));
    expect(byKey.get("observe.log")).toEqual({ type: "toggle" });
    expect(byKey.get("observe.http")).toEqual({ type: "text" });
    expect(byKey.get("world.promptPlayers")).toEqual({ type: "list" });
    expect(byKey.get("observe.deltas")).toEqual({ type: "select", options: ["auto", "on", "off"] });
  });
});
