import type { Judge } from "../rubric.js";
import { JUDGE_SYSTEM, judgePrompt } from "../rubric.js";
import type { DriverTask, ModelDriver } from "../runner.js";
import { SERVER_NAME } from "../runner.js";
import { MCP_PREFIX, normalizeTranscript, type SdkMessage } from "../transcript.js";

/**
 * The real model driver: a Claude model working through the Claude Agent SDK
 * (`@anthropic-ai/claude-agent-sdk`) against the Autosketch MCP server over stdio
 * (docs/design/10-testing.md, tier 3, *Runner*).
 *
 * The SDK is imported dynamically inside `run`, so the rest of the harness (and `npm test`) never
 * loads it. Everything that depends on the SDK's option and message shapes is in this file; the
 * harness reads messages through the loose `SdkMessage` type. Not yet run against the real SDK
 * (no API spend so far): expect small fixes here on the first real run.
 *
 * Only Autosketch tools are allowed (plus Task for the `builder` subagent in delegated runs);
 * built-in file, shell and web tools are denied, and no user or project settings are loaded.
 */

const SDK = "@anthropic-ai/claude-agent-sdk";

type QueryFn = (args: { prompt: string | AsyncIterable<unknown>; options?: Record<string, unknown> }) => AsyncIterable<SdkMessage>;

async function loadQuery(): Promise<QueryFn> {
  let mod: { query?: QueryFn };
  try {
    mod = (await import(SDK as string)) as { query?: QueryFn };
  } catch (e) {
    throw new Error(`${SDK} is not installed (npm install): ${(e as Error).message}`);
  }
  if (typeof mod.query !== "function") throw new Error(`${SDK} has no query() export`);
  return mod.query;
}

/** Tool permission callback: Autosketch tools and (when delegating) Task; nothing else. */
export function permissionFor(delegation: boolean) {
  const prefix = MCP_PREFIX(SERVER_NAME);
  return async (toolName: string, input: Record<string, unknown>) =>
    toolName.startsWith(prefix) || (delegation && (toolName === "Task" || toolName === "Agent"))
      ? { behavior: "allow" as const, updatedInput: input }
      : { behavior: "deny" as const, message: `${toolName} is not available in this evaluation; use the Autosketch tools.` };
}

export class SdkDriver implements ModelDriver {
  readonly name = "agent-sdk";

  async *run(task: DriverTask): AsyncIterable<SdkMessage> {
    const query = await loadQuery();
    const prefix = MCP_PREFIX(SERVER_NAME);
    const options: Record<string, unknown> = {
      model: task.model,
      maxTurns: task.maxTurns,
      systemPrompt: task.systemPrompt,
      cwd: task.workspace,
      settingSources: [],
      mcpServers: { [SERVER_NAME]: { type: "stdio", command: task.server.command, args: task.server.args, ...(task.server.env ? { env: task.server.env } : {}) } },
      allowedTools: [`${prefix}*`, ...(task.delegation ? ["Task"] : [])],
      disallowedTools: ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "WebSearch", "NotebookEdit", "TodoWrite"],
      canUseTool: permissionFor(task.delegation),
      ...(task.delegation
        ? {
            agents: {
              builder: {
                description: "Builds one delegated part of a large build inside a scoped sandbox. Give it the scope_fork handoff text.",
                prompt: "You build one part of a larger Minecraft build inside a sandbox, using the Autosketch tools. Pass the scope id from your handoff on every call. When done, reply with a short report for scope_merge.",
                tools: [`${prefix}*`],
                model: task.model,
              },
            },
          }
        : {}),
    };
    yield* query({ prompt: task.prompt, options });
  }
}

/** The rubric judge through the same SDK: one turn, no tools, the renders as image blocks. */
export class SdkJudge implements Judge {
  constructor(readonly model: string) {}

  async grade(input: { task: string; style: string; images: Buffer[] }) {
    const query = await loadQuery();
    const content = [
      ...input.images.map((png) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } })),
      { type: "text", text: judgePrompt(input.task, input.style) },
    ];
    async function* prompt() {
      yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" };
    }
    const messages: SdkMessage[] = [];
    for await (const m of query({
      prompt: prompt(),
      options: { model: this.model, maxTurns: 1, systemPrompt: JUDGE_SYSTEM, settingSources: [], allowedTools: [], canUseTool: async () => ({ behavior: "deny", message: "no tools" }) },
    }))
      messages.push(m);
    const t = normalizeTranscript(messages);
    return { text: t.finalText ?? "", usage: t.usage };
  }
}
