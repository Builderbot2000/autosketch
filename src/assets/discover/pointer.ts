import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse, stringify } from "smol-toml";
import { isDir, readText } from "./fsutil.js";
import type { Found, ReaderResult, Roots } from "./types.js";
import { loaderName } from "./versions.js";

/**
 * The companion mod's pointer files (`14`, *Instance discovery*, *Pointer file*: the contract with
 * the mod). When the game starts, the mod writes `<user.home>/.autosketch/games/<hash>.toml`, where
 * `<hash>` is `gameFolderHash` of the game folder; discovery lists every file there whose game folder
 * still exists.
 */

/** The pointer format version this reader understands. */
export const POINTER_FORMAT = 1;

export interface Pointer {
  format: number;
  /** The game folder as the game sees it (`/` separators). */
  gameDir: string;
  /** Minecraft version. */
  minecraft: string;
  loader?: string;
  loaderVersion?: string;
  /** The live-link pairing file (`13`, *Pairing file*). */
  pairing?: string;
  /** Instance or pack name, when the mod can tell. */
  name?: string;
  modVersion?: string;
  /** When the file was written, ISO 8601 text. */
  updated?: string;
}

/**
 * The pointer file name for a game folder (`14`, *Pointer file*): the absolute, normalized path as
 * the game's JVM reports it, with every `\` turned into `/` and a trailing `/` dropped; lower-cased
 * whole when it starts with a drive letter (Windows paths ignore case). Then the first 16 hex
 * characters of the SHA-256 of its UTF-8 bytes.
 */
export function gameFolderHash(gameDir: string): string {
  let p = gameDir.replace(/\\/g, "/");
  if (p.length > 1 && !/^[a-zA-Z]:\/$/.test(p)) p = p.replace(/\/+$/, "");
  if (/^[a-zA-Z]:\//.test(p)) p = p.toLowerCase();
  return createHash("sha256").update(p, "utf8").digest("hex").slice(0, 16);
}

/**
 * A WSL path on a Windows drive (`/mnt/c/Users/me/x`) in the form the game on Windows reports
 * (`C:/Users/me/x`), for computing `gameFolderHash` from inside WSL. Other paths are returned as given.
 */
export function windowsFormOfWslPath(p: string): string {
  const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(p);
  return m ? `${m[1]!.toUpperCase()}:${m[2] ?? "/"}` : p;
}

/** Parses a pointer file. Returns the reason when it isn't one this version can use. */
export function parsePointer(text: string): { pointer: Pointer } | { error: string } {
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch (e) {
    return { error: `not valid TOML: ${(e as Error).message.split("\n")[0]}` };
  }
  const format = typeof doc.format === "number" ? doc.format : undefined;
  if (format !== POINTER_FORMAT) return { error: format === undefined ? "no format number" : `format ${format}, this version reads ${POINTER_FORMAT}` };
  const text_ = (k: string) => (typeof doc[k] === "string" && (doc[k] as string).trim() ? (doc[k] as string).trim() : undefined);
  const gameDir = text_("gameDir");
  const minecraft = text_("minecraft");
  if (!gameDir || !minecraft) return { error: "gameDir and minecraft are required" };
  const pointer: Pointer = { format, gameDir, minecraft };
  for (const k of ["loader", "loaderVersion", "pairing", "name", "modVersion", "updated"] as const) {
    const v = text_(k);
    if (v) pointer[k] = v;
  }
  return { pointer };
}

/** A pointer file's text, as the mod writes it (for tests and as the reference for the mod side). */
export function formatPointer(p: Pointer): string {
  return `# Autosketch pointer file: written by the companion mod when the game starts (docs/design/14, Instance discovery).\n${stringify(p)}\n`;
}

/** Reads every pointer file in `dir` (a `games/` folder), dropping those whose game folder is gone. */
export async function readPointers(dir: string, roots: Pick<Roots, "local">): Promise<ReaderResult> {
  const out: ReaderResult = { found: [], warnings: [] };
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".toml")).sort();
  } catch {
    return out;
  }
  for (const n of names) {
    const text = await readText(join(dir, n));
    if (text === undefined) continue;
    const r = parsePointer(text);
    if ("error" in r) {
      out.warnings.push(`Autosketch mod: pointer file ${join(dir, n)} skipped (${r.error})`);
      continue;
    }
    const p = r.pointer;
    const gameDir = await roots.local(p.gameDir);
    if (!(await isDir(gameDir))) continue; // the game folder is gone; the mod removes such files itself
    const ln = loaderName(p.loader);
    const f: Found = {
      name: p.name ?? basename(gameDir),
      mcVersion: p.minecraft,
      ...(ln ? { loader: { name: ln, ...(p.loaderVersion ? { version: p.loaderVersion } : {}) } } : {}),
      launcher: "pointer",
      folder: gameDir,
      gameDir,
      version: p.minecraft,
      via: "pointer",
      warnings: [],
    };
    out.found.push(f);
  }
  return out;
}
