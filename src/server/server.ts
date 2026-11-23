import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { InstanceContext } from "./context.js";
import { INSTRUCTIONS } from "./instructions.js";
import { noteError, observeCall } from "./observe-call.js";
import { BASE, refusal } from "../scope/scopes.js";
import { defaultWorkspace, Session } from "./session.js";
import { TOOL_GROUPS } from "./tools/index.js";
import { fail, scopeSchema, text, type ResourceFn, type Result, type ToolFn } from "./tools/shared.js";

/** The not_configured text for a session the entry point gave no `setup` (in-process uses, tests). */
const NOT_CONFIGURED_FALLBACK = 'Autosketch has no Minecraft instance to read blocks from. Ask the user to run `npx -y autosketch setup --instance "<instance folder>"` (`npx -y autosketch instances` lists the ones found), then call the tool again.';

export const SERVER_NAME = "autosketch";
export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
  /** Document session; defaults to one over the default workspace (~/autosketch). */
  session?: Session;
  /**
   * Tools to leave out of the tool list (setting `server.hideTools`), for eval ablations (10).
   * The instructions gain one line naming them. Names that match no tool are passed to `log`.
   */
  hideTools?: Iterable<string>;
  log?: (msg: string) => void;
  /**
   * Declares the server a Claude Code channel (13, *Prompting from the game*): the experimental
   * `claude/channel` capability, and these lines appended to the instructions.
   */
  channel?: { instructions: string };
}

/**
 * Builds the MCP server. The instance context is a promise so the server can answer the handshake
 * immediately while the instance loads (seconds on a warm cache, longer the first time).
 * Tool definitions live in tools/, one module per feature area.
 */
export function createServer(ctx: Promise<InstanceContext> | undefined, opts: ServerOptions = {}): McpServer {
  const hidden = new Set(opts.hideTools ?? []);
  let instructions = hidden.size ? `${INSTRUCTIONS}\n\nNot available in this session: ${[...hidden].sort().join(", ")}.` : INSTRUCTIONS;
  if (opts.channel) instructions += `\n\n${opts.channel.instructions}`;
  const capabilities = opts.channel ? { capabilities: { experimental: { "claude/channel": {} } } } : {};
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions, ...capabilities });
  const session = opts.session ?? new Session(defaultWorkspace());
  // Without an instance the server still starts: tools answer not_configured until one is loaded
  // (session.loadInstance, or one saved in config.toml since startup; 14, *Setup*).
  if (ctx && session.instance !== ctx) session.setInstance(ctx);
  const seen = new Set<string>();

  const tool: ToolFn = <S extends z.ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: S; readOnly?: boolean; doc?: boolean },
    run: (c: InstanceContext, args: z.infer<z.ZodObject<S>>) => Promise<Result> | Result,
  ) => {
    seen.add(name);
    if (hidden.has(name)) return undefined;
    // Document tools take `scope` (11, Addressing); mutating ones must name it while scopes are open.
    const scoped = config.doc !== false;
    const inputSchema = scoped ? { ...config.inputSchema, scope: scopeSchema } : config.inputSchema;
    const mutating = scoped && config.readOnly === false;
    return server.registerTool(
      name,
      { title: config.title, description: config.description, inputSchema, annotations: { readOnlyHint: config.readOnly ?? true, openWorldHint: false } },
      observeCall(() => session.events, name, async (args: z.infer<z.ZodObject<S>>) => {
        let c: InstanceContext;
        const pending = session.instanceForCall();
        if (!pending) {
          // Not configured (14, *Setup*): instance_info reports it, every other tool refuses with the way out.
          const why = session.setup ? await session.setup.notConfigured() : NOT_CONFIGURED_FALLBACK;
          if (name === "instance_info") return text(`No Minecraft instance is loaded yet.\n${why}`);
          const msg = `not_configured: ${why}`;
          return noteError(fail(msg), refusal("not_configured", msg));
        }
        try {
          c = await pending;
        } catch (e) {
          return fail(`The Minecraft instance failed to load: ${(e as Error).message}`);
        }
        try {
          const scope = scoped ? ((args as { scope?: string }).scope ?? undefined) : undefined;
          // A call addressed to the world view (18, piece 5: `select` storing a selection there) changes no document.
          const changes = mutating && (args as { view?: unknown }).view !== "world";
          const call = { tool: name, scope: scope ?? BASE, doc: scoped, mutating: changes };
          return await session.inScope(scope, changes, () => session.runCall(call, () => run(c, args)));
        } catch (e) {
          return noteError(fail((e as Error).message), e);
        }
      }) as never,
    );
  };

  const resource = resourceRegistrar(server);

  for (const register of TOOL_GROUPS) register({ tool, resource, session });
  const unknown = [...hidden].filter((n) => !seen.has(n));
  if (unknown.length) opts.log?.(`server.hideTools: no tool named ${unknown.join(", ")}`);
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
