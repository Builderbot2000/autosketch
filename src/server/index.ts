#!/usr/bin/env node
/**
 * Autosketch MCP server (stdio).
 *
 *   autosketch --instance "/path/to/instance" [--version 1.21.1] [--base-jar client.jar] [--workspace ~/autosketch]
 *   (or AUTOSKETCH_INSTANCE / AUTOSKETCH_VERSION / AUTOSKETCH_BASE_JAR / AUTOSKETCH_WORKSPACE)
 *   settings: --set observe.log=false (or AUTOSKETCH_OBSERVE_LOG=false), see core/settings.ts
 *   viewer:   on by default on a free port (--set observe.http=<port> to pin one, =false to turn it
 *             off); the URL is printed to stderr and opened in the browser (--set observe.open=false)
 *   --set server.hideTools=analyze,render hides tools (eval ablations, docs/design/10)
 *
 *   autosketch observe <path> [--port <n>] [--instance <path>]
 *   opens a finished session log (a session folder, a document's observe/ folder or a document
 *   folder) in the viewer; no MCP session. Uses the instance's textures when --instance or
 *   AUTOSKETCH_INSTANCE is set, flat colours otherwise (docs/design/12, Replay).
 *
 * stdout carries the protocol; all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Settings } from "../core/settings.js";
import { startObserve, type Observer } from "../observe/index.js";
import { serveLog } from "../observe/offline.js";
import { openInBrowser } from "../observe/open.js";
import { OBSERVE_OPEN } from "../observe/settings.js";
import { scopeLimits } from "../scope/settings.js";
import { configFromEnv, loadInstanceContext } from "./context.js";
import { createServer, SERVER_VERSION } from "./server.js";
import { SERVER_HIDE_TOOLS } from "./settings.js";
import { defaultWorkspace, Session } from "./session.js";
import { bakerFor } from "./tools/shared.js";
import { LiveLink } from "../world/live-link.js";
import { worldSettings } from "../world/settings.js";
import { autoSyncHook, syncLink } from "../world/sync.js";

const log = (msg: string) => process.stderr.write(`[autosketch] ${msg}\n`);

async function main(): Promise<void> {
  const cfg = configFromEnv();
  if (!cfg) {
    log('no instance configured: pass --instance "<path to Minecraft instance>" or set AUTOSKETCH_INSTANCE');
    process.exit(2);
  }
  const ctx = loadInstanceContext(cfg, log);
  ctx.catch((e: Error) => log(`failed to load instance: ${e.message}`));
  const workspace = cfg.workspace ?? defaultWorkspace();
  let settings: Settings;
  let session: Session;
  try {
    settings = Settings.from();
    session = new Session(workspace, log, { scopeLimits: scopeLimits(settings) });
  } catch (e) {
    log((e as Error).message);
    process.exit(2);
  }
  // Observability (12): the process entry point is the one place that wires observe/ in; the
  // session, documents and tool wrapper only see the EventSink.
  let observer: Observer;
  let hideTools: string[];
  try {
    hideTools = settings.get(SERVER_HIDE_TOOLS);
    observer = startObserve({ workspace, settings, version: SERVER_VERSION, getDoc: () => session.doc, getScopeDoc: (id) => session.scopes.scopes.get(id)?.doc, getBaker: async () => bakerFor(await ctx), log });
  } catch (e) {
    log((e as Error).message);
    process.exit(2);
  }
  if (settings.get(OBSERVE_OPEN)) void observer.ready.then((url) => url && openInBrowser(url, log));
  session.events = observer.sink("base");
  session.eventsFor = (doc) => observer.sink(doc);
  // The live world link (13), wired in here like observe/: tools reach it only through the session.
  // It connects on doc_open({world: true}); its call hook runs before the auto-sync hook.
  let link: LiveLink;
  try {
    link = new LiveLink(session, { ...worldSettings(settings), log });
  } catch (e) {
    log((e as Error).message);
    process.exit(2);
  }
  link.setSync(syncLink);
  session.world = link;
  session.callHooks.push(autoSyncHook(() => session.world));
  const server = createServer(ctx, { session, hideTools, log });
  const transport = new StdioServerTransport();
  // Save the open document before exiting, so a closed client never loses the last op.
  let closing = false;
  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
    link.close();
    await session.close();
    await observer.close();
    process.exit(code);
  };
  transport.onclose = () => void shutdown(0);
  process.stdin.on("end", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(130));
  process.on("SIGTERM", () => void shutdown(143));
  await server.connect(transport);
  log(`listening on stdio; workspace ${workspace}`);
}

/** `autosketch observe <path>`: the viewer over a finished log, until interrupted. */
async function observeCommand(args: string[]): Promise<void> {
  const path = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!path) {
    log("usage: autosketch observe <session folder | <doc>/observe | <doc> folder> [--port <n>] [--instance <path>]");
    process.exit(2);
  }
  const i = args.indexOf("--port");
  const port = i >= 0 ? Number(args[i + 1]) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    log("--port must be 0..65535");
    process.exit(2);
  }
  const cfg = configFromEnv(args);
  let getBaker;
  if (cfg) {
    const ctx = loadInstanceContext(cfg, log);
    ctx.catch((e: Error) => log(`failed to load instance (drawing flat colours): ${e.message}`));
    getBaker = async () => bakerFor(await ctx);
  } else log("no instance configured: blocks are drawn as flat colour cubes (set AUTOSKETCH_INSTANCE for textures)");
  const viewer = await serveLog({ path, port, log, ...(getBaker ? { getBaker } : {}) });
  const l = viewer.log;
  log(`session ${l.sessionId}: ${l.events.length} events, ${l.deltaBytes ? `${l.deltaBytes} bytes of deltas` : "no deltas"}, ${l.snapshots.length} snapshots${l.dropped ? `, ${l.dropped} events dropped` : ""}`);
  process.stdout.write(`${viewer.url}\n`);
  const stop = () => void viewer.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const run = process.argv[2] === "observe" ? observeCommand(process.argv.slice(3)) : main();
run.catch((e: Error) => {
  log(`fatal: ${e.stack ?? e.message}`);
  process.exit(1);
});
