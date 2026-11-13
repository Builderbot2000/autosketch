import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadInstanceContext, type InstanceContext } from "../../../src/server/context.js";
import { createServer } from "../../../src/server/server.js";
import { Session } from "../../../src/server/session.js";
import { LiveLink } from "../../../src/world/live-link.js";
import { autoSyncHook, syncLink } from "../../../src/world/sync.js";
import type { Compound } from "../../../src/world/protocol/index.js";
import { Rcon } from "./rcon.js";

/**
 * The end-to-end world tier (docs/design/10, *Optional e2e world tier*): the real MCP server code,
 * wired as `server/index.ts` wires it, against a running NeoForge server with the companion mod.
 *
 *   AUTOSKETCH_E2E_SERVER    the server folder (holds config/autosketch-bridge.toml and server.properties)
 *   AUTOSKETCH_E2E_INSTANCE  the client instance for the registry and assets (default AUTOSKETCH_INSTANCE)
 *
 * Without AUTOSKETCH_E2E_SERVER the tier is skipped. Start the server first with
 * `test/e2e/world/server.sh start <server dir>`.
 */

export const SERVER_DIR = process.env.AUTOSKETCH_E2E_SERVER ?? "";
export const INSTANCE = process.env.AUTOSKETCH_E2E_INSTANCE ?? process.env.AUTOSKETCH_INSTANCE ?? "";
export const ENABLED = !!SERVER_DIR && !!INSTANCE && existsSync(SERVER_DIR);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "server.sh");

export type Vec3 = [number, number, number];

function props(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(join(SERVER_DIR, "server.properties"), "utf8").split("\n")) {
    const m = /^([^#=]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

export async function rcon(): Promise<Rcon> {
  const p = props();
  return Rcon.open(Number(p["rcon.port"] ?? 25575), p["rcon.password"] ?? "autosketch-e2e");
}

/** Stops and starts the server with the script, waiting until the bridge is listening again. */
export function restartServer(): void {
  execFileSync("bash", [SCRIPT, "stop", SERVER_DIR], { stdio: "ignore" });
  execFileSync("bash", [SCRIPT, "start", SERVER_DIR], { stdio: "ignore" });
  execFileSync("bash", [SCRIPT, "wait", SERVER_DIR, "900"], { stdio: "ignore" });
}

export function killServer(): void {
  execFileSync("bash", [SCRIPT, "stop", SERVER_DIR], { stdio: "ignore" });
}

export function startServer(): void {
  execFileSync("bash", [SCRIPT, "start", SERVER_DIR], { stdio: "ignore" });
  execFileSync("bash", [SCRIPT, "wait", SERVER_DIR, "900"], { stdio: "ignore" });
}

let ctxPromise: Promise<InstanceContext> | undefined;
export function instanceContext(): Promise<InstanceContext> {
  return (ctxPromise ??= loadInstanceContext({ instance: INSTANCE }));
}

export interface Mcp {
  session: Session;
  link: LiveLink;
  client: Client;
  workspace: string;
  /** Calls a tool and returns its text; throws when the result is an error, with the text. */
  call(name: string, args?: Record<string, unknown>): Promise<string>;
  /** Calls a tool and returns its text and error flag. */
  tryCall(name: string, args?: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

/** The MCP side, as `server/index.ts` builds it (without observe/ and in-game requests). */
export async function startMcp(opts: { ackWaitMs?: number } = {}): Promise<Mcp> {
  const workspace = mkdtempSync(join(tmpdir(), "autosketch-e2e-world-"));
  const session = new Session(workspace);
  const link = new LiveLink(session, { gameDir: SERVER_DIR, ackWaitMs: opts.ackWaitMs ?? 5000, backoff: { minMs: 200, maxMs: 2000 } });
  link.setSync(syncLink);
  session.world = link;
  session.callHooks.push(autoSyncHook(() => session.world));
  const server = createServer(instanceContext(), { session });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "e2e", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const tryCall = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    return { text, isError: r.isError === true };
  };
  return {
    session,
    link,
    client,
    workspace,
    tryCall,
    async call(name, args = {}) {
      const r = await tryCall(name, args);
      if (r.isError) throw new Error(`${name} failed: ${r.text}`);
      return r.text;
    },
    async close() {
      link.close();
      await client.close().catch(() => {});
      await session.close();
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

/** Reads world blocks through the mod's snapshot (the world, not the cache). Box inclusive, world coordinates. */
export async function worldBlocks(link: LiveLink, min: Vec3, max: Vec3): Promise<{ states: Map<string, string>; nbt: Map<string, Compound> }> {
  const dimension = link.volumes?.dimension ?? "minecraft:overworld";
  const snap = await link.bridge.request({ type: "snapshot", dimension, boxes: [{ min, max }] });
  const states = new Map<string, string>();
  const nbt = new Map<string, Compound>();
  const r = snap.regions[0]!;
  let i = 0;
  for (let y = min[1]; y <= max[1]; y++)
    for (let z = min[2]; z <= max[2]; z++) for (let x = min[0]; x <= max[0]; x++) states.set(`${x},${y},${z}`, snap.palette[r.states[i++]!]!);
  for (const be of r.blockEntities) nbt.set(be.pos.join(","), be.nbt);
  return { states, nbt };
}

export async function worldBlock(link: LiveLink, p: Vec3): Promise<string> {
  return (await worldBlocks(link, p, p)).states.get(p.join(","))!;
}

/** Sets the work volume (and optionally a reference context box) through the mod's console commands. */
export async function setVolumes(r: Rcon, work: { min: Vec3; max: Vec3 }, reference?: { min: Vec3; max: Vec3 }, link?: LiveLink): Promise<void> {
  await r.command("autosketch context clear");
  await r.command("autosketch mode work");
  await r.command(`autosketch pos1 ${work.min.join(" ")}`);
  const out = await r.command(`autosketch pos2 ${work.max.join(" ")}`);
  if (!out.includes("work volume")) throw new Error(`setting the work volume failed: ${out}`);
  if (reference) {
    await r.command("autosketch mode context");
    await r.command(`autosketch pos1 ${reference.min.join(" ")}`);
    await r.command(`autosketch pos2 ${reference.max.join(" ")}`);
    const add = await r.command("autosketch context add");
    if (!add.includes("added")) throw new Error(`context add failed: ${add}`);
    await r.command("autosketch mode work");
  }
  // RCON answers before the mod's `volumes` message reaches the MCP; a player can't be that fast.
  if (link?.bridge.connected) {
    const same = (b: { min: number[]; max: number[] } | null | undefined, c: { min: Vec3; max: Vec3 }) => !!b && b.min.join() === c.min.join() && b.max.join() === c.max.join();
    await until(() => same(link.bridge.volumes?.work, work) && (!reference || !!link.bridge.volumes?.context.some((b) => same(b, reference))), 10_000, "volumes from the mod");
    await sleep(200);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until fn returns true (or throws after timeoutMs). */
export async function until(fn: () => boolean | Promise<boolean>, timeoutMs = 10_000, what = "condition"): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}
