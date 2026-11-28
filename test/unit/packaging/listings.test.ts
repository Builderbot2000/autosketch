import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginSkills } from "../../../scripts/build-plugin.js";
import { pluginHook } from "../../../src/observe/turn-hook.js";
import { launchEnv } from "../../../src/server/context.js";
import { defaultWorkspace } from "../../../src/server/session.js";
import { SERVER_VERSION } from "../../../src/server/server.js";

// The npm package and every listing wrapping it (docs/design/14-distribution.md, *Package and listings*).

const ROOT = join(import.meta.dirname, "../../..");
const json = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
const pkg = json("package.json");
const server = json("server.json");
const manifest = json("packaging/mcpb/manifest.json");
const plugin = json("packaging/claude-plugin/.claude-plugin/plugin.json");
const marketplace = json(".claude-plugin/marketplace.json");

describe("package and listings (14)", () => {
  it("carry one version (npm run package:version)", () => {
    expect([server.version, server.packages[0].version, manifest.version, plugin.version, SERVER_VERSION]).toEqual(Array(5).fill(pkg.version));
    expect(plugin.mcpServers.autosketch.args).toEqual(["-y", `autosketch@${pkg.version}`]);
    // The turn-end hook runs the same server version (19).
    const hookCommands = [...readFileSync(join(ROOT, "packaging/claude-plugin/hooks/hooks.json"), "utf8").matchAll(/autosketch@[^\s"]+/g)].map((m) => m[0]);
    expect(hookCommands).toEqual([`autosketch@${pkg.version}`, `autosketch@${pkg.version}`]);
  });

  it("name the npm package the MCP Registry entry points at", () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.packages).toMatchObject([{ registryType: "npm", identifier: pkg.name, transport: { type: "stdio" } }]);
  });

  it("ship what the server reads at runtime, and no game assets", () => {
    expect(pkg.bin).toEqual({ autosketch: "dist/server/index.js" });
    expect(readFileSync(join(ROOT, "src/server/index.ts"), "utf8").startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(pkg.files).toEqual(["dist/**/*.js", "data", "library/knowledge", "library/palettes", "library/prefabs", "server.json", "README.md", "LICENSE"]);
    // data/ holds only minecraft-data's block table (MIT; ids and properties, no assets).
    expect(readdirSync(join(ROOT, "data"), { recursive: true }).filter((f) => String(f).includes("."))).toEqual(["vanilla/1.21.1.json"]);
    expect(pkg.engines.node).toBe(">=22.13");
  });

  it("run the packed server from the MCPB bundle with the user's folders", () => {
    expect(manifest.server).toMatchObject({ type: "node", entry_point: "server/dist/server/index.js", mcp_config: { command: "node", args: ["${__dirname}/server/dist/server/index.js"] } });
    expect(manifest.server.mcp_config.env).toEqual({ AUTOSKETCH_INSTANCE: "${user_config.instance}", AUTOSKETCH_WORKSPACE: "${user_config.workspace}" });
    expect(Object.keys(manifest.user_config)).toEqual(["instance", "workspace"]);
    expect(manifest.compatibility.runtimes.node).toBe(">=22.13.0");
  });

  it("treat an empty or unexpanded launch variable as unset (MCPB optional fields)", () => {
    expect(launchEnv({ A: "${user_config.instance}" }, "A")).toBeUndefined();
    expect(launchEnv({ A: "  " }, "A")).toBeUndefined();
    expect(launchEnv({ A: "/games/pack" }, "A")).toBe("/games/pack");
    expect(defaultWorkspace({ AUTOSKETCH_WORKSPACE: "${user_config.workspace}" })).not.toContain("${");
  });

  it("bind the plugin's channel to its MCP server, and list the plugin in the marketplace", () => {
    expect(plugin.channels).toEqual([{ server: "autosketch", displayName: "Autosketch in-game requests" }]);
    expect(Object.keys(plugin.mcpServers)).toContain(plugin.channels[0].server);
    expect(marketplace.plugins).toMatchObject([{ name: plugin.name, source: "./packaging/claude-plugin" }]);
  });

  it("ship the turn-end hook on Stop and StopFailure, without blocking the turn (19)", () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, "packaging/claude-plugin/hooks/hooks.json"), "utf8"));
    for (const event of ["Stop", "StopFailure"]) {
      expect(hooks.hooks[event]).toEqual([{ hooks: [{ type: "command", command: `npx -y autosketch@${pkg.version} hook turn-end`, async: true, timeout: 10 }] }]);
    }
    expect(pluginHook({ CLAUDE_PLUGIN_ROOT: join(ROOT, "packaging/claude-plugin") })).toEqual({ state: "installed", root: join(ROOT, "packaging/claude-plugin") });
  });

  it("keep the plugin's skills generated from the knowledge packs (npm run package:plugin)", () => {
    const dir = join(ROOT, "packaging/claude-plugin/skills");
    const want = pluginSkills(ROOT);
    expect(readdirSync(dir).sort()).toEqual([...want.keys()].sort());
    for (const [name, text] of want) expect(readFileSync(join(dir, name, "SKILL.md"), "utf8")).toBe(text);
    expect(want.get("review")).toMatch(/^---\nname: review\ndescription: "A pass for checking your own work/);
  });
});
