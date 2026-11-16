#!/usr/bin/env node
/**
 * Autosketch MCP server (stdio).
 *
 *   autosketch --instance "/path/to/instance" [--version 1.21.1] [--base-jar client.jar] [--workspace ~/autosketch]
 *   (or AUTOSKETCH_INSTANCE / AUTOSKETCH_VERSION / AUTOSKETCH_BASE_JAR / AUTOSKETCH_WORKSPACE);
 *   ~/.autosketch/config.toml (instance, workspace, [settings]) beats all of these, see core/config.ts
 *   settings: --set observe.log=false (or AUTOSKETCH_OBSERVE_LOG=false), see core/settings.ts
 *   viewer:   on by default on a free port (--set observe.http=<port> to pin one, =false to turn it
 *             off); the URL is printed to stderr and opened in the browser on the first tool call (--set observe.open=false)
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
import { readConfig } from "../core/config.js";
import { configFromEnv, loadInstanceContext, startupArgNotes } from "./context.js";
import { createServer, SERVER_VERSION } from "./server.js";
import { SERVER_HIDE_TOOLS } from "./settings.js";
import { defaultWorkspace, Session } from "./session.js";
import { bakerFor } from "./tools/shared.js";
import { LiveLink } from "../world/live-link.js";
import { promptSettings, worldSettings } from "../world/settings.js";
import { CHANNEL_INSTRUCTIONS, CHANNEL_METHOD, InGameRequests } from "../world/prompt.js";
import { autoSyncHook, syncLink } from "../world/sync.js";

const log = (msg: string) => process.stderr.write(`[autosketch] ${msg}\n`);

async function main(): Promise<void> {
  // The user's saved choices come first (core/config.ts; 15, *Settings tab*), read once here.
  const file = readConfig();
  const argv = process.argv.slice(2);
  let settings: Settings;
  let cfg: ReturnType<typeof configFromEnv>;
  try {
    settings = Settings.from(argv, process.env, file);
    cfg = configFromEnv(argv, process.env, file);
  } catch (e) {
    log((e as Error).message);
    process.exit(2);
  }
  // One line per launch value config.toml overrides, and per problem in the file: logged, never in a tool result.
  for (const line of [...settings.notes(), ...startupArgNotes(argv, process.env, file)]) log(line);
  if (!cfg) {
    log(`no instance configured: pass --instance "<path to Minecraft instance>", set AUTOSKETCH_INSTANCE, or set instance in ${file.path}`);
    process.exit(2);
  }
  const ctx = loadInstanceContext(cfg, log);
  ctx.catch((e: Error) => log(`failed to load instance: ${e.message}`));
  const workspace = cfg.workspace ?? defaultWorkspace();
  let session: Session;
  try {
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
  // The browser opens on the first tool call, not at startup: clients start MCP servers with every
  // session, and a session that never uses autosketch shouldn't pop a tab.
  if (settings.get(OBSERVE_OPEN)) {
    let opened = false;
    session.callHooks.push({
      before: () => {
        if (opened) return;
        opened = true;
        void observer.ready.then((url) => url && openInBrowser(url, log));
      },
    });
  }
  session.events = observer.sink("base");
  session.eventsFor = (doc) => observer.sink(doc);
  // The live world link (13), wired in here like observe/: tools reach it only through the session.
  // It connects on its own once the instance is loaded (world.autoLink), or on doc_open({world: true});
  // its call hook runs before the auto-sync hook.
  let link: LiveLink;
  let autoLink: boolean;
  try {
    const ws = worldSettings(settings);
    autoLink = ws.autoLink;
    link = new LiveLink(session, { ...ws, log });
  } catch (e) {
    log((e as Error).message);
    process.exit(2);
  }
  link.setSync(syncLink);
  session.world = link;
  session.callHooks.push(autoSyncHook(() => session.world));
  const server = createServer(ctx, { session, hideTools, log, channel: { instructions: CHANNEL_INSTRUCTIONS } });
  // In-game requests (13, *Prompting from the game*): pushed into the session as Claude Code channel
  // events. Whether the session loaded the server as a channel can't be seen from here, so delivery
  // is optimistic once a client has initialized.
  let inGame: InGameRequests;
  try {
    inGame = new InGameRequests(link, {
      ...promptSettings(settings),
      subscribe: (fn) => session.subscribe(fn),
      notify: (content, meta) => server.server.notification({ method: CHANNEL_METHOD, params: { content, meta } } as never),
      listening: () => server.server.getClientCapabilities() !== undefined,
      touch: () => session.touch(),
      log,
    });
  } catch (e) {
    log((e as Error).message);
    process.exit(2);
  }
  session.inGame = inGame;
  // Request modes (13, B6): while an ask, plan or scan request is open, edits on the linked document are refused.
  session.callHooks.push(inGame.modeRule);
  if (autoLink) void ctx.then((c) => link.autoLink({ instanceDir: c.info.root, plugins: c.plugins, palettes: c.book }), () => {});
  const transport = new StdioServerTransport();
  // Save the open document before exiting, so a closed client never loses the last op.
  let closing = false;
  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
    inGame.close();
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
  const cfg = configFromEnv(args, process.env, readConfig());
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
