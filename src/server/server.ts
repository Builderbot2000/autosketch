import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { InstanceContext } from "./context.js";
import { INSTRUCTIONS } from "./instructions.js";
import { noteError, observeCall } from "./observe-call.js";
import { defaultWorkspace, Session } from "./session.js";
import { TOOL_GROUPS } from "./tools/index.js";
import { fail, scopeSchema, type ResourceFn, type Result, type ToolFn } from "./tools/shared.js";

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
    config: { title: string; description: string; inputSchema: S; readOnly?: boolean; doc?: boolean },
    run: (c: InstanceContext, args: z.infer<z.ZodObject<S>>) => Promise<Result> | Result,
  ) => {
    // Document tools take `scope` (11, Addressing); mutating ones must name it while scopes are open.
    const scoped = config.doc !== false;
    const inputSchema = scoped ? { ...config.inputSchema, scope: scopeSchema } : config.inputSchema;
    const mutating = scoped && config.readOnly === false;
    return server.registerTool(
      name,
      { title: config.title, description: config.description, inputSchema, annotations: { readOnlyHint: config.readOnly ?? true, openWorldHint: false } },
      observeCall(() => session.events, name, async (args: z.infer<z.ZodObject<S>>) => {
        let c: InstanceContext;
        try {
          c = await ctx;
        } catch (e) {
          return fail(`The Minecraft instance failed to load: ${(e as Error).message}`);
        }
        try {
          const scope = scoped ? ((args as { scope?: string }).scope ?? undefined) : undefined;
          return await session.inScope(scope, mutating, () => run(c, args));
        } catch (e) {
          return noteError(fail((e as Error).message), e);
        }
      }) as never,
    );
  };

  const resource = resourceRegistrar(server);

  for (const register of TOOL_GROUPS) register({ tool, resource, session });
  return server;
}

/** The `resource` function tool modules receive (see ResourceFn in tools/shared.ts). */
export function resourceRegistrar(server: McpServer): ResourceFn {
  return (name, config, read) => {
    const meta = { title: config.title, description: config.description, ...(config.mimeType ? { mimeType: config.mimeType } : {}) };
    const contents = async (uri: URL, vars: Record<string, string>) => {
      const r = await read(uri, vars);
      const mimeType = r.mimeType ?? config.mimeType;
      return { contents: [{ uri: uri.href, text: r.text, ...(mimeType ? { mimeType } : {}) }] };
    };
    if (!config.uri.includes("{")) return server.registerResource(name, config.uri, meta, (uri) => contents(uri, {}));
    const list = config.list;
    const template = new ResourceTemplate(config.uri, { list: list ? async () => ({ resources: await list() }) : undefined });
    return server.registerResource(name, template, meta, (uri, vars) =>
      contents(uri, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v)]))),
    );
  };
}
