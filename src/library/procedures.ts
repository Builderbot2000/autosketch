import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { walk } from "./files.js";
import type { LibraryRoot } from "./roots.js";

/**
 * Procedures (docs/design/07-library.md): saved scripts (05) under `procedures/`, each starting
 * with a header comment that describes it and its parameters:
 *
 *   /**
 *    * Window bay: a row of windows along a face.
 *    * @param face   component face, e.g. "keep.front"
 *    * @param spacing blocks between windows (default 3)
 *    *\/
 *
 * Running them needs the script sandbox (silo C); until then they are stored and listed only.
 */

export interface ProcedureParam {
  name: string;
  description: string;
}

export interface Procedure {
  /** Path under procedures/ without .js. */
  name: string;
  summary: string;
  params: ProcedureParam[];
  root: string;
  file: string;
}

export async function listProcedures(roots: readonly LibraryRoot[], query?: string): Promise<Procedure[]> {
  const seen = new Map<string, Procedure>();
  for (const root of roots) {
    if (root.kind !== "library") continue;
    const dir = join(root.path, "procedures");
    for (const rel of await walk(dir, (n) => n.endsWith(".js"))) {
      const name = rel.slice(0, -3);
      if (seen.has(name)) continue;
      const file = join(dir, rel);
      seen.set(name, { name, ...parseHeader(await readFile(file, "utf8")), root: root.label, file });
    }
  }
  const q = query?.trim().toLowerCase();
  return [...seen.values()].filter((p) => !q || p.name.toLowerCase().includes(q) || p.summary.toLowerCase().includes(q));
}

/** Reads the leading block comment (or run of // lines): free text is the summary, @param lines the parameters. */
export function parseHeader(source: string): { summary: string; params: ProcedureParam[] } {
  const s = source.replace(/^﻿/, "").replace(/^#!.*\n/, "").trimStart();
  let lines: string[] = [];
  const block = /^\/\*\*?([\s\S]*?)\*\//.exec(s);
  if (block) lines = block[1]!.split(/\r?\n/).map((l) => l.replace(/^\s*\*?\s?/, ""));
  else for (const l of s.split(/\r?\n/)) {
    const m = /^\s*\/\/\s?(.*)$/.exec(l);
    if (!m) break;
    lines.push(m[1]!);
  }
  const params: ProcedureParam[] = [];
  const text: string[] = [];
  // A one-line header may carry its tags inline: "/** Window bay. @param face the face */".
  for (const l of lines.flatMap((x) => x.split(/\s+(?=@\w)/))) {
    const p = /^@param\s+(?:\{[^}]*\}\s*)?(\[?[\w.]+\]?)\s*-?\s*(.*)$/.exec(l.trim());
    if (p) params.push({ name: p[1]!.replace(/^\[|\]$/g, ""), description: p[2]!.trim() });
    else if (l.trim() && !l.trim().startsWith("@")) text.push(l.trim());
  }
  return { summary: text.join(" ") || "(no description)", params };
}

export function formatProcedureList(list: readonly Procedure[]): string {
  if (!list.length) return "No procedures. Save scripts as <library>/procedures/<name>.js with a header comment describing their parameters.";
  return list.map((p) => `${p.name}(${p.params.map((x) => x.name).join(", ")}): ${p.summary}${p.params.length ? `\n  ${p.params.map((x) => `${x.name}: ${x.description}`).join("; ")}` : ""}`).join("\n");
}
