import { join } from "node:path";
import { firstFile, isDir, isFile, str, subdirs } from "./fsutil.js";
import type { Found, ReaderResult, Roots } from "./types.js";
import { loaderName } from "./versions.js";

/**
 * Modrinth App (`14`, *Instance discovery*; built from modrinth/code `packages/app-lib`, unverified on
 * a real machine). Its SQLite `app.db` in the settings folder (`<data>/ModrinthApp`, formerly
 * `<data>/com.modrinth.theseus`) lists the instances. The same file holds Minecraft account data, so
 * it is opened read-only and only these statements ever run: the instance tables (the 2026 schema,
 * then the older `profiles`) and `settings.custom_dir`. Instance folders are
 * `<config dir>/profiles/<path>`, where the config dir is `custom_dir` when the user moved it.
 * When the database can't be read, the profiles folder is listed instead, with a warning.
 */
export const MODRINTH_SQL = {
  customDir: "SELECT custom_dir FROM settings",
  instances:
    "SELECT i.path AS path, i.name AS name, c.game_version AS game_version, c.loader AS loader, c.loader_version AS loader_version " +
    "FROM instances AS i LEFT JOIN instance_content_sets AS c ON c.id = i.applied_content_set_id",
  instancesBare: "SELECT path, name FROM instances",
  profiles: "SELECT path, name, game_version, mod_loader AS loader, mod_loader_version AS loader_version FROM profiles",
} as const;

/** A read-only query handle on a SQLite file. */
export interface SqlReader {
  all(sql: string): Record<string, unknown>[];
  close(): void;
}

export type OpenDb = (path: string) => Promise<SqlReader>;

/**
 * Opens a SQLite file read-only with Node's built-in `node:sqlite` (Node ≥ 22.13, no flag), loaded
 * on first use. Its "experimental" warning is dropped so it never reaches the log.
 */
export const openReadOnly: OpenDb = async (path) => {
  const { DatabaseSync } = await loadSqlite();
  const db = new DatabaseSync(path, { readOnly: true });
  return { all: (sql) => db.prepare(sql).all() as Record<string, unknown>[], close: () => db.close() };
};

let sqlite: Promise<typeof import("node:sqlite")> | undefined;
function loadSqlite(): Promise<typeof import("node:sqlite")> {
  if (!sqlite) {
    const emit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const msg = typeof warning === "string" ? warning : warning.message;
      if (/SQLite/i.test(msg)) return;
      (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
    }) as typeof process.emitWarning;
    sqlite = import("node:sqlite").finally(() => {
      process.emitWarning = emit;
    });
  }
  return sqlite;
}

export async function readModrinth(roots: Roots, openDb: OpenDb = openReadOnly): Promise<ReaderResult> {
  const out: ReaderResult = { found: [], warnings: [] };
  for (const settingsDir of [join(roots.data, "ModrinthApp"), join(roots.data, "com.modrinth.theseus")]) {
    if (!(await isDir(settingsDir))) continue;
    const r = await readSettingsDir(roots, settingsDir, openDb);
    out.found.push(...r.found);
    out.warnings.push(...r.warnings);
  }
  return out;
}

interface Row {
  path?: string;
  name?: string;
  mcVersion?: string;
  loader?: string;
  loaderVersion?: string;
}

async function readSettingsDir(roots: Roots, settingsDir: string, openDb: OpenDb): Promise<ReaderResult> {
  const warnings: string[] = [];
  const dbPath = join(settingsDir, "app.db");
  let configDir = settingsDir;
  let rows: Row[] | undefined;
  if (await isFile(dbPath)) {
    let db: SqlReader | undefined;
    try {
      db = await openDb(dbPath);
      const custom = tryAll(db, MODRINTH_SQL.customDir)?.map((r) => str(r.custom_dir)).find(Boolean);
      if (custom) {
        const local = await roots.local(custom);
        if (await isDir(local)) configDir = local;
        else warnings.push(`Modrinth App: moved data folder ${local} (settings.custom_dir) not found; using ${settingsDir}`);
      }
      const raw = tryAll(db, MODRINTH_SQL.instances) ?? tryAll(db, MODRINTH_SQL.instancesBare) ?? tryAll(db, MODRINTH_SQL.profiles);
      if (raw) rows = raw.map(toRow);
      else warnings.push(`Modrinth App: ${dbPath} has no instance table I can read (the schema may have changed); listing the profiles folder instead`);
    } catch (e) {
      warnings.push(`Modrinth App: can't open ${dbPath} read-only (${(e as Error).message.split("\n")[0]}); listing the profiles folder instead`);
    } finally {
      db?.close();
    }
  }
  const profiles = join(configDir, "profiles");
  const found: Found[] = [];
  if (rows) {
    for (const r of rows) {
      if (!r.path) continue;
      found.push(await modrinthFound(configDir, join(profiles, r.path), r, "record"));
    }
  } else {
    for (const n of await subdirs(profiles)) found.push(await modrinthFound(configDir, join(profiles, n), { name: n }, "folder"));
  }
  return { found, warnings };
}

function tryAll(db: SqlReader, sql: string): Record<string, unknown>[] | undefined {
  try {
    return db.all(sql);
  } catch {
    return undefined;
  }
}

const toRow = (r: Record<string, unknown>): Row => {
  const out: Row = {};
  const path = str(r.path), name = str(r.name), mc = str(r.game_version), loader = str(r.loader), lv = str(r.loader_version);
  if (path) out.path = path;
  if (name) out.name = name;
  if (mc) out.mcVersion = mc;
  if (loader) out.loader = loader;
  if (lv) out.loaderVersion = lv;
  return out;
};

async function modrinthFound(configDir: string, folder: string, r: Row, via: Found["via"]): Promise<Found> {
  const ln = loaderName(r.loader);
  const f: Found = {
    name: r.name ?? folder.split(/[\\/]/).pop()!,
    ...(r.mcVersion ? { mcVersion: r.mcVersion } : {}),
    ...(ln ? { loader: { name: ln, ...(r.loaderVersion ? { version: r.loaderVersion } : {}) } } : {}),
    launcher: "modrinth",
    folder,
    gameDir: folder,
    via,
    warnings: [],
  };
  if (r.mcVersion) {
    // The game jar sits in the app's shared meta folder (unverified layout), outside the instance.
    f.version = r.mcVersion;
    const jar = await firstFile([join(configDir, "meta", "versions", r.mcVersion, `${r.mcVersion}.jar`)]);
    if (jar) f.baseJar = jar;
  }
  return f;
}
