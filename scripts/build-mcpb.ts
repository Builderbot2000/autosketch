/**
 * Builds the MCPB bundle for Claude Desktop (docs/design/14-distribution.md, *Package and listings*):
 * the npm package exactly as published (`npm pack`), its production dependencies, and
 * `packaging/mcpb/manifest.json`, zipped as `build/autosketch-<version>.mcpb`. Claude Desktop runs it
 * with its own Node.
 *
 *   npm run package:mcpb
 *
 * Needs the npm registry (or npm's cache) for the dependencies. Nothing is published.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, type Zippable } from "fflate";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "build");
const STAGE = join(OUT, "mcpb");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", shell: process.platform === "win32" });

const version = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;
const manifest = JSON.parse(readFileSync(join(ROOT, "packaging", "mcpb", "manifest.json"), "utf8")) as { version: string };
if (manifest.version !== version) throw new Error(`manifest.json says ${manifest.version}, package.json ${version}: run npm run package:version`);

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
// The published package (prepack builds dist/), unpacked as server/.
const tgz = run(npm, ["pack", "--json", "--pack-destination", OUT], ROOT);
const file = (JSON.parse(tgz) as { filename: string }[])[0]!.filename;
run("tar", ["-xzf", join(OUT, file), "-C", STAGE], ROOT);
const server = join(STAGE, "server");
execFileSync(process.platform === "win32" ? "cmd" : "mv", process.platform === "win32" ? ["/c", "move", join(STAGE, "package"), server] : [join(STAGE, "package"), server]);
run(npm, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false"], server);
writeFileSync(join(STAGE, "manifest.json"), readFileSync(join(ROOT, "packaging", "mcpb", "manifest.json")));
// The same icon as the Claude Code plugin (scripts/make-icon.py draws it).
writeFileSync(join(STAGE, "icon.png"), readFileSync(join(ROOT, "packaging", "claude-plugin", ".claude-plugin", "icon.png")));
for (const extra of ["LICENSE", "README.md"]) writeFileSync(join(STAGE, extra), readFileSync(join(ROOT, extra)));

const files: Zippable = {};
const walk = (dir: string) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else files[relative(STAGE, p).split("\\").join("/")] = [readFileSync(p), { level: 9 }];
  }
};
walk(STAGE);
const bundle = join(OUT, `autosketch-${version}.mcpb`);
writeFileSync(bundle, zipSync(files));
process.stdout.write(`${bundle}: ${Object.keys(files).length} files, ${(statSync(bundle).size / 1e6).toFixed(1)} MB\n`);
