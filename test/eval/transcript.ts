/**
 * Transcripts for the agent evaluation tier (docs/design/10-testing.md, tier 3, *Runner*).
 *
 * `SdkMessage` is the subset of the Claude Agent SDK's message stream the harness reads: system
 * init, assistant turns (with usage), user turns carrying tool results, and the final result.
 * It is declared here, loosely, so the harness and its tests never import the SDK; the SDK
 * driver (`drivers/sdk.ts`) passes the SDK's messages straight through.
 *
 * The SDK may emit one assistant message per content block, all sharing the API message id and
 * repeating its usage, so turns are grouped by message id and usage is counted once per turn.
 * Subagent messages carry `parent_tool_use_id`; each agent thread is tracked separately.
 */

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface SdkMessage {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { id?: string; role?: string; content?: string | ContentBlock[]; usage?: Usage };
  /** system/init */
  tools?: string[];
  model?: string;
  /** result */
  usage?: Usage;
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  result?: string;
  is_error?: boolean;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Turn {
  /** "main", or the tool_use id of the Task call that started a subagent. */
  thread: string;
  id: string;
  usage: TokenTotals;
  /** Tool calls made in this turn, as indexes into `Transcript.calls`. */
  calls: number[];
}

export interface TranscriptCall {
  /** Position among all tool calls, in transcript order. */
  order: number;
  id: string;
  /** Full tool name as the model saw it (`mcp__autosketch__fill`, `Task`). */
  name: string;
  /** The Autosketch tool name, when the call went to the Autosketch server. */
  tool?: string;
  input: unknown;
  thread: string;
  turn: number;
  ok?: boolean;
  /** Text characters and images in the tool result, as the transcript shows it. */
  resultChars: number;
  resultImages: number;
}

export interface Transcript {
  turns: Turn[];
  calls: TranscriptCall[];
  usage: TokenTotals;
  /** Cost the SDK reported, when it did. */
  reportedCostUsd?: number;
  /** Tool names the SDK offered the model (system/init). */
  offeredTools?: string[];
  finalText?: string;
  isError: boolean;
  stopReason?: string;
}

export const MCP_PREFIX = (server: string) => `mcp__${server}__`;

const zero = (): TokenTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const totals = (u: Usage | undefined): TokenTotals => ({
  input: u?.input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
  cacheRead: u?.cache_read_input_tokens ?? 0,
  cacheWrite: u?.cache_creation_input_tokens ?? 0,
});
export const addTokens = (a: TokenTotals, b: TokenTotals): TokenTotals => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
});
/** Everything the model read in a turn (fresh, cached and cache-written input). */
export const contextTokens = (t: TokenTotals): number => t.input + t.cacheRead + t.cacheWrite;
export const totalTokens = (t: TokenTotals): number => contextTokens(t) + t.output;

function resultSize(content: unknown): { chars: number; images: number } {
  if (typeof content === "string") return { chars: content.length, images: 0 };
  let chars = 0, images = 0;
  if (Array.isArray(content))
    for (const c of content as ContentBlock[]) {
      if (c.type === "text") chars += c.text?.length ?? 0;
      else if (c.type === "image") images++;
    }
  return { chars, images };
}

export function normalizeTranscript(messages: readonly SdkMessage[], server = "autosketch"): Transcript {
  const prefix = MCP_PREFIX(server);
  const turns: Turn[] = [];
  const calls: TranscriptCall[] = [];
  const byCallId = new Map<string, TranscriptCall>();
  const lastTurn = new Map<string, Turn>();
  const out: Transcript = { turns, calls, usage: zero(), isError: false };
  let anon = 0;

  for (const m of messages) {
    const thread = m.parent_tool_use_id ?? "main";
    if (m.type === "system" && m.subtype === "init" && m.tools) out.offeredTools = [...m.tools];
    else if (m.type === "assistant" && m.message) {
      const id = m.message.id ?? `anon-${anon++}`;
      let turn = lastTurn.get(thread);
      if (!turn || turn.id !== id) {
        turn = { thread, id, usage: zero(), calls: [] };
        turns.push(turn);
        lastTurn.set(thread, turn);
      }
      if (m.message.usage) turn.usage = totals(m.message.usage); // repeated per block: keep the latest
      const content = Array.isArray(m.message.content) ? m.message.content : [];
      for (const b of content) {
        if (b.type === "text" && b.text && thread === "main") out.finalText = b.text;
        if (b.type !== "tool_use" || !b.id || !b.name) continue;
        const call: TranscriptCall = {
          order: calls.length,
          id: b.id,
          name: b.name,
          ...(b.name.startsWith(prefix) ? { tool: b.name.slice(prefix.length) } : {}),
          input: b.input,
          thread,
          turn: turns.indexOf(turn),
          resultChars: 0,
          resultImages: 0,
        };
        calls.push(call);
        byCallId.set(b.id, call);
        turn.calls.push(call.order);
      }
    } else if (m.type === "user" && m.message && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type !== "tool_result" || !b.tool_use_id) continue;
        const call = byCallId.get(b.tool_use_id);
        if (!call) continue;
        const size = resultSize(b.content);
        call.ok = !b.is_error;
        call.resultChars = size.chars;
        call.resultImages = size.images;
      }
    } else if (m.type === "result") {
      if (m.total_cost_usd !== undefined) out.reportedCostUsd = m.total_cost_usd;
      if (m.result) out.finalText = m.result;
      out.isError = !!m.is_error || (m.subtype !== undefined && m.subtype !== "success");
      if (m.subtype) out.stopReason = m.subtype;
    }
  }
  out.usage = turns.reduce((t, x) => addTokens(t, x.usage), zero());
  return out;
}

/**
 * Tokens each tool result added to the model's context: the growth in context between the turn
 * that made the calls and the thread's next turn, minus the calling turn's own output, split
 * across that turn's calls by their share of result size (characters / 4 + image tokens).
 * Undefined for calls whose turn has no successor (the run ended).
 */
export function resultTokens(t: Transcript, imageTokens: (call: TranscriptCall) => number = (c) => c.resultImages * 800): (number | undefined)[] {
  const out: (number | undefined)[] = t.calls.map(() => undefined);
  const byThread = new Map<string, Turn[]>();
  for (const turn of t.turns) byThread.set(turn.thread, [...(byThread.get(turn.thread) ?? []), turn]);
  for (const list of byThread.values())
    for (let i = 0; i + 1 < list.length; i++) {
      const turn = list[i]!;
      if (!turn.calls.length) continue;
      const delta = Math.max(0, contextTokens(list[i + 1]!.usage) - contextTokens(turn.usage) - turn.usage.output);
      const weights = turn.calls.map((k) => {
        const c = t.calls[k]!;
        return c.resultChars / 4 + imageTokens(c) + 1;
      });
      const sum = weights.reduce((a, b) => a + b, 0);
      turn.calls.forEach((k, j) => (out[k] = Math.round((delta * weights[j]!) / sum)));
    }
  return out;
}
