/** Loader and game version from the ids launchers record (`14`, *Instance discovery*). */

export type Loader = { name: string; version?: string };

/** A loader name as written by any launcher ("NeoForge", "net.neoforged", "fabric-loader", "Vanilla") → neoforge | forge | fabric | quilt, or undefined. */
export function loaderName(raw: string | undefined): string | undefined {
  const s = raw?.trim().toLowerCase().replace(/[\s_]/g, "");
  if (!s) return undefined;
  if (s.includes("neoforge") || s === "net.neoforged") return "neoforge";
  if (s.includes("forge")) return "forge";
  if (s.includes("fabric")) return "fabric";
  if (s.includes("quilt")) return "quilt";
  return undefined;
}

/**
 * CurseForge's `baseModLoader.name`: `neoforge-21.1.262`, `forge-47.4.4`, `fabric-0.19.2-1.21.11`
 * (fabric and quilt carry the game version last, dropped here).
 */
export function curseForgeLoader(raw: string | undefined, gameVersion?: string): Loader | undefined {
  const m = raw && /^(neoforge|forge|fabric|quilt)-(.+)$/i.exec(raw.trim());
  if (!m) return undefined;
  let version = m[2]!;
  if (gameVersion && version.endsWith(`-${gameVersion}`)) version = version.slice(0, -gameVersion.length - 1);
  return { name: m[1]!.toLowerCase(), version };
}

/**
 * A vanilla launcher version id → game version and loader:
 * `1.21.1`; `neoforge-21.1.262` (game version from the NeoForge major and minor: 1.21.1);
 * `fabric-loader-0.16.5-1.21.1`; `quilt-loader-0.26.0-1.21`; `1.20.1-forge-47.2.0`.
 */
export function vanillaVersionId(id: string): { mcVersion?: string; loader?: Loader } {
  let m = /^neoforge-((\d+)\.(\d+)\.[\w.+-]+)$/.exec(id);
  if (m) return { mcVersion: m[3] === "0" ? `1.${m[2]}` : `1.${m[2]}.${m[3]}`, loader: { name: "neoforge", version: m[1]! } };
  m = /^(fabric|quilt)-loader-([\w.+]+)-(.+)$/.exec(id);
  if (m) return { mcVersion: m[3]!, loader: { name: m[1]!, version: m[2]! } };
  m = /^(\d+\.\d+(?:\.\d+)?)-(forge|neoforge)-?([\w.+-]+)$/.exec(id);
  if (m) return { mcVersion: m[1]!, loader: { name: m[2]!, version: m[3]! } };
  if (/^\d+\.\d+(\.\d+)?$/.test(id) || /^\d+w\d+[a-z]$/.test(id)) return { mcVersion: id };
  return {};
}

/** A slug for ids: lower case, runs of other characters become "-". */
export const slug = (s: string): string =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "instance";
