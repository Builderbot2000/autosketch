/**
 * Copies package.json's version into every listing (docs/design/14-distribution.md, *Package and
 * listings*): server.json (top level and the npm package), the MCPB manifest, the Claude Code
 * plugin (its version and the `autosketch@<version>` it and its turn-end hook run) and SERVER_VERSION in server.ts.
 * Run after `npm version <x>`; a unit test fails while they disagree.
 *
 *   npm run package:version
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const writeJson = (p: string, v: unknown) => writeFileSync(join(ROOT, p), `${JSON.stringify(v, null, 2)}\n`);

const version = (JSON.parse(read("package.json")) as { version: string }).version;

const server = JSON.parse(read("server.json")) as { version: string; packages: { version: string }[] };
server.version = version;
for (const p of server.packages) p.version = version;
writeJson("server.json", server);

const manifest = JSON.parse(read("packaging/mcpb/manifest.json")) as { version: string };
manifest.version = version;
writeJson("packaging/mcpb/manifest.json", manifest);

const pluginPath = "packaging/claude-plugin/.claude-plugin/plugin.json";
const plugin = JSON.parse(read(pluginPath)) as { version: string; mcpServers: Record<string, { args: string[] }> };
plugin.version = version;
for (const s of Object.values(plugin.mcpServers)) s.args = s.args.map((a) => (a.startsWith("autosketch@") ? `autosketch@${version}` : a));
writeJson(pluginPath, plugin);

// The turn-end hook runs the same server version (19).
const hooksPath = "packaging/claude-plugin/hooks/hooks.json";
writeFileSync(join(ROOT, hooksPath), read(hooksPath).replace(/autosketch@[^\s"]+/g, `autosketch@${version}`));

const serverTs = "src/server/server.ts";
writeFileSync(join(ROOT, serverTs), read(serverTs).replace(/export const SERVER_VERSION = "[^"]*";/, `export const SERVER_VERSION = "${version}";`));

process.stdout.write(`listings set to ${version}\n`);
