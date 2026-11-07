import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { InstanceContext } from "./context.js";
import { INSTRUCTIONS } from "./instructions.js";
import { defaultWorkspace, Session } from "./session.js";
import { TOOL_GROUPS } from "./tools/index.js";
import { fail, type Result, type ToolFn } from "./tools/shared.js";

export const SERVER_NAME = "autosketch";
export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
  /** Document session; defaults to one over the default workspace (~/autosketch). */
  session?: Session;
}

/**
 * Builds the MCP server. The instance context is a promise so the server can answer the handshake
 * immediately while the instance loads (seconds on a warm cache, longer the first time).
 * Tool definitions live in tools/, one module per feature area.
 */
export function createServer(ctx: Promise<InstanceContext>, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const session = opts.session ?? new Session(defaultWorkspace());

  const tool: ToolFn = <S extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: S; readOnly?: boolean },
    run: (c: InstanceContext, args: z.infer<z.ZodObject<S>>) => Promise<Result> | Result,
  ) =>
    server.registerTool(
      name,
      { title: config.title, description: config.description, inputSchema: config.inputSchema, annotations: { readOnlyHint: config.readOnly ?? true, openWorldHint: false } },
      (async (args: z.infer<z.ZodObject<S>>) => {
        let c: InstanceContext;
        try {
          c = await ctx;
        } catch (e) {
          return fail(`The Minecraft instance failed to load: ${(e as Error).message}`);
        }
        try {
          return await run(c, args);
        } catch (e) {
          return fail((e as Error).message);
        }
      }) as never,
    );

  for (const register of TOOL_GROUPS) register({ tool, session });
  return server;
}
