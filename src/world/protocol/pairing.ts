import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PAIRING_FILE } from "./messages.js";

/**
 * The pairing file `<instance>/config/autosketch-bridge.toml` (docs/design/13-live-world.md,
 * *Wire format*, *Pairing file*). A strict TOML subset: `key = value` lines with integer or
 * double-quoted string values (no escapes), `#` comments, blank lines.
 */

export interface Pairing {
  protocol: number;
  host: string;
  port: number;
  /** 64 lowercase hex digits. */
  token: string;
  pid?: number;
  started?: string;
}

export function formatPairing(p: Pairing): string {
  const lines = [
    "# Autosketch bridge pairing file. Written by the mod when the server starts, deleted when it stops.",
    "# Do not edit. The token lets a local Autosketch MCP server connect to this game.",
    `protocol = ${p.protocol}`,
    `host = "${p.host}"`,
    `port = ${p.port}`,
    `token = "${p.token}"`,
  ];
  if (p.pid !== undefined) lines.push(`pid = ${p.pid}`);
  if (p.started !== undefined) lines.push(`started = "${p.started}"`);
  return lines.join("\n") + "\n";
}

export function parsePairing(text: string): Pairing {
  const kv = new Map<string, string | number>();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+)\s*=\s*(?:"([^"\\]*)"|(-?[0-9]+))\s*(?:#.*)?$/.exec(line);
    if (!m) throw new Error(`pairing file line ${i + 1} is not key = "string" or key = integer: ${raw}`);
    kv.set(m[1]!, m[2] ?? Number(m[3]));
  }
  const int = (k: string): number => {
    const v = kv.get(k);
    if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new Error(`pairing file has no integer "${k}"`);
    return v;
  };
  const str = (k: string): string => {
    const v = kv.get(k);
    if (typeof v !== "string") throw new Error(`pairing file has no string "${k}"`);
    return v;
  };
  const p: Pairing = { protocol: int("protocol"), host: str("host"), port: int("port"), token: str("token") };
  if (p.port < 1 || p.port > 65535) throw new Error(`pairing file port ${p.port} is not a TCP port`);
  if (!/^[0-9a-f]{64}$/.test(p.token)) throw new Error("pairing file token must be 64 lowercase hex digits");
  if (kv.has("pid")) p.pid = int("pid");
  if (kv.has("started")) p.started = str("started");
  return p;
}

export function pairingPath(instanceDir: string): string {
  return join(instanceDir, PAIRING_FILE);
}

export async function readPairing(instanceDir: string): Promise<Pairing> {
  return parsePairing(await readFile(pairingPath(instanceDir), "utf8"));
}

/** Writes the file atomically (temporary file, then rename), as the mod does. */
export async function writePairing(instanceDir: string, p: Pairing): Promise<void> {
  const path = pairingPath(instanceDir);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, formatPairing(p), "utf8");
  await rename(tmp, path);
}

export async function removePairing(instanceDir: string): Promise<void> {
  await rm(pairingPath(instanceDir), { force: true });
}
