#!/usr/bin/env node
/**
 * Autosketch MCP server (stdio).
 *
 *   autosketch --instance "/path/to/instance" [--version 1.21.1] [--base-jar client.jar] [--workspace ~/autosketch]
 *   (or AUTOSKETCH_INSTANCE / AUTOSKETCH_VERSION / AUTOSKETCH_BASE_JAR / AUTOSKETCH_WORKSPACE)
 *
 * stdout carries the protocol; all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, loadInstanceContext } from "./context.js";
import { createServer } from "./server.js";
import { defaultWorkspace, Session } from "./session.js";

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
  const session = new Session(workspace, log);
  const server = createServer(ctx, { session });
  const transport = new StdioServerTransport();
  // Save the open document before exiting, so a closed client never loses the last op.
  let closing = false;
  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
    await session.flush();
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
