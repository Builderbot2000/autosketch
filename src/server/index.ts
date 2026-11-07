#!/usr/bin/env node
/**
 * Autosketch MCP server (stdio).
 *
 *   autosketch --instance "/path/to/instance" [--version 1.21.1] [--base-jar client.jar]
 *   (or AUTOSKETCH_INSTANCE / AUTOSKETCH_VERSION / AUTOSKETCH_BASE_JAR)
 *
 * stdout carries the protocol; all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, loadInstanceContext } from "./context.js";
import { createServer } from "./server.js";

const log = (msg: string) => process.stderr.write(`[autosketch] ${msg}\n`);

async function main(): Promise<void> {
  const cfg = configFromEnv();
  if (!cfg) {
    log('no instance configured: pass --instance "<path to Minecraft instance>" or set AUTOSKETCH_INSTANCE');
    process.exit(2);
  }
  const ctx = loadInstanceContext(cfg, log);
  ctx.catch((e: Error) => log(`failed to load instance: ${e.message}`));
  const server = createServer(ctx);
  await server.connect(new StdioServerTransport());
  log("listening on stdio");
}

main().catch((e: Error) => {
  log(`fatal: ${e.stack ?? e.message}`);
  process.exit(1);
});
