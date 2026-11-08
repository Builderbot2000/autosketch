#!/usr/bin/env node
/**
 * Autosketch MCP server (stdio).
 *
 *   autosketch --instance "/path/to/instance" [--version 1.21.1] [--base-jar client.jar] [--workspace ~/autosketch]
 *   (or AUTOSKETCH_INSTANCE / AUTOSKETCH_VERSION / AUTOSKETCH_BASE_JAR / AUTOSKETCH_WORKSPACE)
 *   settings: --set observe.log=false (or AUTOSKETCH_OBSERVE_LOG=false), see core/settings.ts
 *   viewer:   --set observe.http=true (a free port) or =<port>; the URL is printed to stderr
 *
 * stdout carries the protocol; all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Settings } from "../core/settings.js";
import { startObserve, type Observer } from "../observe/index.js";
import { scopeLimits } from "../scope/settings.js";
import { configFromEnv, loadInstanceContext } from "./context.js";
import { createServer, SERVER_VERSION } from "./server.js";
import { defaultWorkspace, Session } from "./session.js";
import { bakerFor } from "./tools/shared.js";

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
  try {
    observer = startObserve({ workspace, settings, version: SERVER_VERSION, getDoc: () => session.doc, getBaker: async () => bakerFor(await ctx), log });
  } catch (e) {
    log((e as Error).message);
    process.exit(2);
  }
  session.events = observer.sink("base");
  session.eventsFor = (doc) => observer.sink(doc);
  const server = createServer(ctx, { session });
  const transport = new StdioServerTransport();
  // Save the open document before exiting, so a closed client never loses the last op.
  let closing = false;
  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
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

main().catch((e: Error) => {
  log(`fatal: ${e.stack ?? e.message}`);
  process.exit(1);
});
