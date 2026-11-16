/**
 * Builds the Claude Code plugin's skills from the starter knowledge packs (docs/design/14-distribution.md,
 * *Package and listings*): each `library/knowledge/<kind>/<name>.md` becomes
 * `packaging/claude-plugin/skills/<name>/SKILL.md`, with the pack's summary as the skill description.
 * The output is committed (a marketplace installs the plugin from git); a unit test checks it is current.
 *
 *   npm run package:plugin
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The generated skills: folder name → SKILL.md text. */
export function pluginSkills(root = ROOT): Map<string, string> {
  const out = new Map<string, string>();
  const base = join(root, "library", "knowledge");
  for (const kind of readdirSync(base).sort()) {
    for (const file of readdirSync(join(base, kind)).filter((f) => f.endsWith(".md")).sort()) {
      const src = `library/knowledge/${kind}/${file}`;
      const text = readFileSync(join(root, src), "utf8");
      const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
      if (!m) throw new Error(`${src}: no frontmatter`);
      const meta = Object.fromEntries(m[1]!.split("\n").map((l) => /^(\w+):\s*(.*)$/.exec(l)).filter((x): x is RegExpExecArray => !!x).map((x) => [x[1]!, x[2]!.trim()]));
      const name = file.replace(/\.md$/, "");
      if (out.has(name)) throw new Error(`two knowledge packs named ${name}`);
      const kindWord = meta.kind === "heuristic" ? "Advisory heuristic" : "Method";
      const description = `${meta.summary ?? meta.name ?? name} (${kindWord} for building with Autosketch: suggestions to weigh, not rules.)`;
      out.set(
        name,
        `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n<!-- Generated from ${src} by \`npm run package:plugin\`; edit that file instead. -->\n# ${meta.name ?? name}\n\n${m[2]!.trimStart()}`,
      );
    }
  }
  return out;
}

function main(): void {
  const dir = join(ROOT, "packaging", "claude-plugin", "skills");
  rmSync(dir, { recursive: true, force: true });
  for (const [name, text] of pluginSkills()) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), text);
  }
  process.stdout.write(`wrote ${readdirSync(dir).length} skills to ${dir}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
