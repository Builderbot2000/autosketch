import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/** A folder for comparing: resolved, `/` separators, no trailing `/`, and lower-cased on Windows drives (`/mnt/c/…`, `C:\…`). */
export const folderKey = (p: string): string => {
  const r = resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  return /^(\/mnt\/[a-z]\/|[a-zA-Z]:\/)/i.test(r) ? r.toLowerCase() : r;
};

/** Small tolerant file helpers for the launcher readers: a missing or unreadable file is `undefined`, never a throw. */

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

export async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export async function readText(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

/** The parsed JSON, `undefined` when the file is missing, or `{ error }` when it exists but doesn't parse. */
export async function readJson(p: string): Promise<{ value: unknown } | { error: string } | undefined> {
  const text = await readText(p);
  if (text === undefined) return undefined;
  try {
    return { value: JSON.parse(text.replace(/^﻿/, "")) as unknown };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** Sub-folders of `dir`, sorted; none when it is missing. */
export async function subdirs(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const n of names.sort()) if (await isDir(join(dir, n))) out.push(n);
  return out;
}

/** Number of `.jar` files in `dir` (a game folder's `mods/`). */
export async function countJars(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((f) => f.toLowerCase().endsWith(".jar")).length;
  } catch {
    return 0;
  }
}

/** The first of `paths` that is a file. */
export async function firstFile(paths: string[]): Promise<string | undefined> {
  for (const p of paths) if (await isFile(p)) return p;
  return undefined;
}

export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A simple `key=value` INI read (Prism's `prismlauncher.cfg`, `instance.cfg`), ignoring sections. Surrounding quotes are dropped. */
export function iniValue(text: string, key: string): string | undefined {
  const m = new RegExp(`^\\s*${key}\\s*=(.*)$`, "m").exec(text);
  const v = m?.[1]?.trim().replace(/^"(.*)"$/, "$1");
  return v || undefined;
}
