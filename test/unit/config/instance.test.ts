import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../../src/core/config.js";
import { configFromEnv, launchOptions, startupArg, startupArgNotes } from "../../../src/server/context.js";
import { instanceSourceText } from "../../../src/server/tools/instance.js";

const file = parseConfig('instance = "/saved/pack"\nworkspace = "~/builds"\n[settings]\n"tintBiome" = "jungle"\n');

describe("instance and workspace from config.toml (14 Setup, 15 Instance tab)", () => {
  it("prefers config.toml, then --instance, then AUTOSKETCH_INSTANCE, then none", () => {
    const argv = ["--instance", "/launch/pack"];
    const env = { AUTOSKETCH_INSTANCE: "/env/pack" };
    expect(startupArg("instance", argv, env, file)).toEqual({
      value: "/saved/pack",
      source: { kind: "config", label: "config.toml" },
      overrides: { source: { kind: "flag", label: "--instance" }, raw: "/launch/pack" },
    });
    expect(startupArg("instance", argv, env)).toEqual({ value: "/launch/pack", source: { kind: "flag", label: "--instance" } });
    expect(startupArg("instance", [], env, parseConfig(""))).toEqual({ value: "/env/pack", source: { kind: "env", label: "AUTOSKETCH_INSTANCE" } });
    expect(startupArg("instance", [], {}, parseConfig(""))).toBeUndefined();
    expect(startupArg("workspace", [], {}, file)?.value).toBe(join(homedir(), "builds"));
  });

  it("builds the server config from config.toml, dropping the launch instance's --version", () => {
    expect(configFromEnv(["--instance", "/launch/pack", "--version", "1.20.1", "--tint-biome", "swamp"], {}, file)).toEqual({
      instance: "/saved/pack",
      instanceSource: { kind: "config", label: "config.toml" },
      workspace: join(homedir(), "builds"),
      tintBiome: "jungle",
    });
    // The same instance on both sides keeps the launch --version.
    expect(configFromEnv(["--instance", "/saved/pack", "--version", "1.20.1"], {}, file)?.version).toBe("1.20.1");
    expect(configFromEnv([], {}, parseConfig('instance = "/only/saved"'))).toEqual({ instance: "/only/saved", instanceSource: { kind: "config", label: "config.toml" } });
  });

  it("logs one line per overridden launch instance or workspace, none when they agree", () => {
    expect(startupArgNotes(["--instance", "/launch/pack"], { AUTOSKETCH_WORKSPACE: "/w" }, file)).toEqual([
      "instance: launch value --instance /launch/pack ignored; config.toml says /saved/pack",
      `workspace: launch value AUTOSKETCH_WORKSPACE=/w ignored; config.toml says ${join(homedir(), "builds")}`,
    ]);
    expect(startupArgNotes(["--instance", "/saved/pack"], {}, file)).toEqual([]);
    expect(startupArgNotes(["--instance", "/launch/pack"], {})).toEqual([]);
  });

  it("names the source for instance_info", () => {
    expect(instanceSourceText({ kind: "config", label: "config.toml" })).toBe("config.toml");
    expect(instanceSourceText({ kind: "flag", label: "--instance" })).toBe("command line (--instance)");
    expect(instanceSourceText({ kind: "env", label: "AUTOSKETCH_INSTANCE" })).toBe("environment (AUTOSKETCH_INSTANCE)");
  });

  it("applies config.toml's version and baseJar only with its own instance, before the launch values", () => {
    const saved = parseConfig('instance = "/saved/pack"\nversion = "1.20.1"\nbaseJar = "/jars/client.jar"\n');
    expect(configFromEnv(["--instance", "/saved/pack", "--version", "1.21.1"], {}, saved)).toMatchObject({ instance: "/saved/pack", version: "1.20.1", baseJar: "/jars/client.jar" });
    expect(configFromEnv(["--instance", "/launch"], {}, parseConfig('version = "1.20.1"\n'))).toEqual({ instance: "/launch", instanceSource: { kind: "flag", label: "--instance" } });
    expect(launchOptions(["--tint-biome", "swamp", "--workspace", "/w"], {}, parseConfig(""))).toEqual({ tintBiome: "swamp", workspace: "/w" });
  });
});
