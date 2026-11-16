import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { autosketchHome } from "../core/config.js";
import { gameFolderHash, windowsFormOfWslPath } from "./discover/pointer.js";
import type { BlockInfo, Registry } from "./registry.js";

/**
 * The companion mod's registry report (docs/design/14-distribution.md, *Version-specific data lives
 * in the mod*): every block the running game knows, with all its properties, allowed values and
 * default state, which blocks have a block entity, the block tags and the DataVersion, read from the
 * game's live registries. The mod writes it at server start to
 * `<autosketch home>/games/<game-folder hash>.registry.json.gz`, beside its pointer file, and serves
 * the same bytes over the link (`registry`, protocol 3).
 *
 * Order of trust when canonicalizing a block (`02`): the report, then the instance's blockstate
 * files, then the bundled vanilla tables. `applyReport` puts the report on top of a registry built
 * from the other two: blocks it names take its properties, defaults and tags; blocks it names that
 * the assets don't (no blockstate file) are added; blocks only the assets name (client-only mods,
 * resource packs) are left as they were.
 */

/** Format 1, as the mod's `RegistryReport` writes it. */
export interface RegistryReport {
  format: number;
  minecraft: string;
  dataVersion: number;
  loader?: string;
  loaderVersion?: string;
  blocks: Record<string, { properties?: Record<string, string[]>; default?: Record<string, string>; blockEntity?: boolean }>;
  tags: Record<string, string[]>;
}

/** The report formats this reader understands. */
export const REPORT_FORMAT = 1;

export interface LoadedReport {
  report: RegistryReport;
  /** First 8 bytes of SHA-256 over the uncompressed JSON, as 16 hex digits (the protocol's `hash`). */
  hash: string;
  /** Where it came from: a file path, or "the game" for one fetched over the link. */
  source: string;
}

/** Parses the gzip report (the file, or a `registry.result` body). Throws on anything else. */
export function parseReport(gzip: Uint8Array, source: string): LoadedReport {
  const json = gunzipSync(gzip);
  const report = JSON.parse(json.toString("utf8")) as RegistryReport;
  if (report.format !== REPORT_FORMAT) throw new Error(`registry report format ${report.format}; this Autosketch reads format ${REPORT_FORMAT}`);
  if (typeof report.blocks !== "object" || report.blocks === null || !Number.isSafeInteger(report.dataVersion)) throw new Error("not a registry report (no blocks or dataVersion)");
  report.tags ??= {};
  return { report, hash: createHash("sha256").update(json).digest("hex").slice(0, 16), source };
}

/**
 * The report file for a game folder, or undefined when there is none (the game hasn't run with the
 * mod since it was installed, or its pointer is turned off). Tries the folder and its `.minecraft` /
 * `minecraft` subfolder, each as given and in the Windows form of a WSL path. A file that can't be
 * read as a report is skipped, with the reason in `warnings`.
 */
export async function readReportFor(instanceRoot: string, warnings: string[] = [], home = autosketchHome()): Promise<LoadedReport | undefined> {
  const dirs = [instanceRoot, join(instanceRoot, ".minecraft"), join(instanceRoot, "minecraft")];
  const hashes = [...new Set(dirs.flatMap((d) => [gameFolderHash(d), gameFolderHash(windowsFormOfWslPath(d))]))];
  for (const h of hashes) {
    const file = join(home, "games", `${h}.registry.json.gz`);
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      continue;
    }
    try {
      return parseReport(bytes, file);
    } catch (e) {
      warnings.push(`registry report ${file} skipped: ${(e as Error).message}`);
    }
  }
  return undefined;
}

/** What `applyReport` changed. */
export interface ReportApplied {
  /** Blocks whose properties or defaults differ from what the assets said. */
  corrected: number;
  /** Blocks the assets didn't define. */
  added: number;
}

/**
 * Puts the report on top of the registry, in place (every holder of the registry sees it). Blocks it
 * names take its properties, defaults, block-entity flag and tags (marked `exactProperties`).
 */
export function applyReport(registry: Registry, loaded: LoadedReport): ReportApplied {
  const { report } = loaded;
  const tagsOf = new Map<string, string[]>();
  for (const [tag, members] of Object.entries(report.tags)) for (const id of members) (tagsOf.get(id) ?? tagsOf.set(id, []).get(id)!).push(tag);
  let corrected = 0, added = 0;
  for (const [id, b] of Object.entries(report.blocks)) {
    const properties = b.properties ?? {};
    const defaults = b.default ?? {};
    const tags = (tagsOf.get(id) ?? []).sort();
    const known = registry.get(id);
    if (known) {
      if (JSON.stringify(sortKeys(known.properties)) !== JSON.stringify(sortKeys(properties)) || JSON.stringify(sortKeys(known.defaults)) !== JSON.stringify(sortKeys(defaults))) corrected++;
      registry.upsert({ ...known, properties: sortKeys(properties), defaults, tags, exactProperties: true, ...(b.blockEntity ? { blockEntity: true } : {}) });
    } else {
      added++;
      const i = id.indexOf(":");
      const info: BlockInfo = {
        id,
        namespace: id.slice(0, i),
        properties: sortKeys(properties),
        defaults,
        shape: "none",
        renderable: "fallback",
        faceTextures: {},
        textures: [],
        tinted: false,
        tags,
        source: "registry-report",
        exactProperties: true,
        ...(b.blockEntity ? { blockEntity: true } : {}),
      };
      registry.upsert(info);
    }
  }
  registry.report = { hash: loaded.hash, dataVersion: report.dataVersion, minecraft: report.minecraft, source: loaded.source };
  return { corrected, added };
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]!]));
}

/** A `registry.result` as `refreshFromGame` needs it (structurally the protocol's). */
export type RegistryAnswer = { hash: string; unchanged: true } | { hash: string; report: Uint8Array };

/**
 * Asks the linked game for its report (protocol 3, `registry`), sending the hash of the one the
 * registry already holds, and applies it when it differs: the modset may have changed since the file
 * was read, and under WSL the game's file lives in the Windows home, out of reach. Resolves with what
 * changed, or undefined when the game's report is the one already applied.
 */
export async function refreshFromGame(registry: Registry, ask: (have: string | undefined) => Promise<RegistryAnswer>): Promise<ReportApplied | undefined> {
  const r = await ask(registry.report?.hash);
  if ("unchanged" in r || r.hash === registry.report?.hash) return undefined;
  return applyReport(registry, parseReport(r.report, "the game"));
}

/** What `watchGameReport` uses of the bridge (structurally `world/bridge.ts`'s connection). */
export interface ReportSource {
  supports(feature: "registry"): boolean;
  onConnection(fn: (state: "up" | "down") => void): () => void;
  request(m: { type: "registry"; have?: string }): Promise<RegistryAnswer>;
}

/**
 * Refreshes the registry from the game on every connection to a mod that serves `registry`
 * (`refreshFromGame`). Returns the unsubscribe function.
 */
export function watchGameReport(bridge: ReportSource, registry: () => Promise<Registry>, log: (msg: string) => void = () => {}): () => void {
  return bridge.onConnection((state) => {
    if (state !== "up" || !bridge.supports("registry")) return;
    void registry()
      .then((r) => refreshFromGame(r, (have) => bridge.request({ type: "registry", ...(have ? { have } : {}) })))
      .then((r) => r && log(`registry report from the game: ${r.corrected} blocks corrected, ${r.added} added`))
      .catch((e: Error) => log(`registry report from the game failed: ${e.message}`));
  });
}
