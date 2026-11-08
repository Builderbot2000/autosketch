import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { DriverTask, ModelDriver } from "../runner.js";
import { MCP_PREFIX, type ContentBlock, type SdkMessage } from "../transcript.js";

/**
 * A model driver that replays scripted tool calls against a real MCP server and emits the same
 * message shapes the Agent SDK does (docs/design/10-testing.md, tier 3). It lets `npm test` cover
 * the runner, scoring, the log join, ablations and result files without a model or network.
 *
 * Usage numbers are synthetic but consistent: each turn's context is the previous turn's context
 * plus its output plus its tool results (characters / 4, 800 per image), so the join's per-call
 * token attribution can be checked exactly. Like the SDK, every content block of an assistant
 * turn is emitted as its own message sharing the turn's id and usage.
 */

export type Step =
  | { tool: string; args?: Record<string, unknown> }
  /** Calls made in one assistant turn. */
  | { parallel: { tool: string; args?: Record<string, unknown> }[] }
  /** A Task call that runs a subagent with its own steps (threaded by parent_tool_use_id). */
  | { subagent: Step[]; description?: string }
  | { text: string };

export interface Connection {
  client: Client;
  /** Saves the document and flushes the event log (what the stdio server does on exit). */
  close(): Promise<void>;
}

export const BASE_CONTEXT = 2000;
export const TURN_OUTPUT = 50;

export class ScriptedDriver implements ModelDriver {
  readonly name = "scripted";
  constructor(
    private readonly script: (task: DriverTask) => Step[],
    private readonly connect: (task: DriverTask) => Promise<Connection>,
  ) {}

  async *run(task: DriverTask): AsyncIterable<SdkMessage> {
    const conn = await this.connect(task);
    const offered = (await conn.client.listTools()).tools.map((t) => MCP_PREFIX("autosketch") + t.name);
    yield { type: "system", subtype: "init", tools: offered, model: task.model };
    const state = { msg: 0, call: 0, turns: 0 };
    try {
      yield* this.thread(this.script(task), null, conn.client, state);
    } finally {
      await conn.close();
    }
    yield { type: "result", subtype: "success", num_turns: state.turns, duration_ms: 0, result: "done" };
  }

  private async *thread(steps: Step[], parent: string | null, client: Client, state: { msg: number; call: number; turns: number }): AsyncGenerator<SdkMessage> {
    let context = BASE_CONTEXT;
    const turn = (blocks: ContentBlock[]): SdkMessage[] => {
      state.turns++;
      const id = `msg_${++state.msg}`;
      const usage = { input_tokens: 10, cache_read_input_tokens: context - 10, cache_creation_input_tokens: 0, output_tokens: TURN_OUTPUT };
      return blocks.map((b) => ({ type: "assistant", parent_tool_use_id: parent, message: { id, role: "assistant", content: [b], usage } }));
    };
    for (const step of steps) {
      if ("text" in step) {
        yield* turn([{ type: "text", text: step.text }]);
        continue;
      }
      if ("subagent" in step) {
        const id = `toolu_${++state.call}`;
        yield* turn([{ type: "tool_use", id, name: "Task", input: { description: step.description ?? "builder", prompt: "…" } }]);
        yield* this.thread(step.subagent, id, client, state);
        const text = "subagent finished";
        yield { type: "user", parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } };
        context += TURN_OUTPUT + Math.round(text.length / 4);
        continue;
      }
      const calls = "parallel" in step ? step.parallel : [step];
      const ids = calls.map(() => `toolu_${++state.call}`);
      yield* turn(calls.map((c, i) => ({ type: "tool_use", id: ids[i], name: MCP_PREFIX("autosketch") + c.tool, input: c.args ?? {} })));
      const results: ContentBlock[] = [];
      let added = 0;
      for (const [i, c] of calls.entries()) {
        let content: ContentBlock[];
        let isError = false;
        try {
          const r = await client.callTool({ name: c.tool, arguments: c.args ?? {} });
          content = (r.content as ContentBlock[]).map((b) => (b.type === "image" ? { type: "image" } : { type: "text", text: b.text ?? "" }));
          isError = !!r.isError;
        } catch (e) {
          content = [{ type: "text", text: (e as Error).message }];
          isError = true;
        }
        for (const b of content) added += b.type === "image" ? 800 : Math.round((b.text?.length ?? 0) / 4);
        results.push({ type: "tool_result", tool_use_id: ids[i], content, is_error: isError });
      }
      yield { type: "user", parent_tool_use_id: parent, message: { role: "user", content: results } };
      context += TURN_OUTPUT + added;
    }
  }
}
