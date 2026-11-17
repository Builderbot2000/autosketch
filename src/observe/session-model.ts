import type { EventEnvelope, ObserveEvent } from "../core/events.js";
import type { PublicBox, Vec3 } from "../core/region.js";

/**
 * The session model (docs/design/12-observability.md, *Panels*; moved from the viewer's
 * `viewer/js/model.js` by `16`, *What goes, what stays, what moves*): the scope tree, refusals,
 * lock waits, op counts and token spend, built only from the event stream, the same one replay
 * reads. Pure: no I/O, so the in-game UI feed (`src/ui/feed.ts`) and replay frames reuse it.
 *
 * Frames (12, *One frame*): every box in an event is in the base document's local frame. A scope's
 * sandbox has its own local frame whose (0,0,0) is the work volume's minimum corner (11); the fork
 * event's `translation` maps sandbox to base: base = local + translation.
 */

export const MAX_EVENTS = 20000;

/** An event as the model takes it: the bus envelope is optional (synthetic events in tests). */
export type ModelEvent = ObserveEvent & Partial<EventEnvelope>;

export type ScopeStatus = "open" | "merged" | "abandoned" | "lost";

export interface Refusal {
  seq: number | undefined;
  t: number | undefined;
  tool: string;
  scope: string;
  code: string;
  message: string;
}

export interface LockWait {
  parent: string;
  scope: string;
  fromT: number | undefined;
  toT: number | undefined;
  fromSeq: number | undefined;
  toSeq: number | undefined;
}

export interface Scope {
  id: string;
  parent: string | null;
  depth: number;
  children: string[];
  ops: number;
  refusals: Refusal[];
  lastTool: string | null;
  lastT: number | null;
  status: ScopeStatus;
  brief: string;
  work?: PublicBox;
  context?: PublicBox;
  translation?: Vec3;
  forkSeq?: number;
  forkT?: number;
  endSeq?: number;
  endT?: number;
  report?: string;
  changed?: PublicBox;
}

export interface TreeNode {
  scope: Scope;
  children: TreeNode[];
}

export interface TimelineRow {
  scope: Scope;
  start: number;
  end: number;
  waits: LockWait[];
}

export class SessionModel {
  lastSeq = 0;
  events: ModelEvent[] = [];
  doc: string | null = null;
  bounds: PublicBox | undefined;
  /** Scope id → scope; "base" is the root. */
  scopes = new Map<string, Scope>();
  refusals: Refusal[] = [];
  lockWaits: LockWait[] = [];
  /** Log-wide state ids (state.add). */
  states = new Map<number, string>();
  pendingWaits = new Map<string, Refusal>();
  now = 0;
  /** Token spend from Claude Code's OpenTelemetry (`otel` events, 13 B3). */
  spend = new Spend();

  constructor() {
    this.reset();
  }

  reset(): void {
    this.lastSeq = 0;
    this.events = [];
    this.doc = null;
    this.bounds = undefined;
    this.scopes = new Map();
    this.scopes.set("base", newScope("base", { brief: "base document", depth: 0, status: "open" }));
    this.refusals = [];
    this.lockWaits = [];
    this.states = new Map();
    this.pendingWaits = new Map();
    this.now = 0;
    this.spend = new Spend();
  }

  /** Applies one event. Returns false for an event already seen (seq at or below lastSeq). */
  apply(e: ModelEvent): boolean {
    if (typeof e.seq === "number") {
      if (e.seq <= this.lastSeq) return false;
      this.lastSeq = e.seq;
    }
    if (typeof e.t === "number") this.now = Math.max(this.now, e.t);
    this.events.push(e);
    if (this.events.length > MAX_EVENTS * 1.25) this.events = this.events.slice(-MAX_EVENTS);
    const base = this.scopes.get("base")!;
    switch (e.kind) {
      case "session.open":
        if (this.doc !== e.name) {
          this.doc = e.name;
          if (e.t !== undefined) base.forkT = e.t;
        }
        this.bounds = e.bounds;
        break;
      case "state.add":
        this.states.set(e.id, e.state);
        break;
      case "doc.op":
      case "doc.undo":
      case "doc.redo": {
        const s = e.doc === undefined ? undefined : this.scopes.get(e.doc);
        if (s) {
          s.ops++;
          s.lastT = e.t ?? s.lastT;
        }
        if (e.doc === "base" && e.box) this.bounds = this.bounds ? union(this.bounds, e.box) : e.box;
        break;
      }
      case "call.start": {
        const s = this.scopes.get(e.scope ?? "base");
        if (s) {
          s.lastTool = e.tool;
          s.lastT = e.t ?? s.lastT;
        }
        this.spend.addCall(e);
        break;
      }
      case "call.end":
        this.spend.addCall(e);
        break;
      case "otel":
        this.spend.addOtel(e);
        break;
      case "call.refused": {
        const r: Refusal = { seq: e.seq, t: e.t, tool: e.tool, scope: e.scope ?? "base", code: e.code, message: e.message };
        this.refusals.push(r);
        this.scopes.get(r.scope)?.refusals.push(r);
        if (e.tool === "scope_fork" && e.code === "lock_overlap" && !this.pendingWaits.has(r.scope)) this.pendingWaits.set(r.scope, r);
        break;
      }
      case "scope.fork": {
        const parent = e.parent || "base";
        const s = newScope(e.scope, {
          parent,
          depth: e.depth,
          work: e.work,
          context: e.context,
          translation: e.translation || e.work?.min || [0, 0, 0],
          brief: e.brief || "",
          status: "open",
          ...(e.seq !== undefined ? { forkSeq: e.seq } : {}),
          ...(e.t !== undefined ? { forkT: e.t } : {}),
        });
        this.scopes.set(e.scope, s);
        const p = this.scopes.get(parent);
        if (p && !p.children.includes(e.scope)) p.children.push(e.scope);
        const wait = this.pendingWaits.get(parent);
        if (wait) {
          this.lockWaits.push({ parent, scope: e.scope, fromT: wait.t, toT: e.t, fromSeq: wait.seq, toSeq: e.seq });
          this.pendingWaits.delete(parent);
        }
        break;
      }
      case "scope.merge":
      case "scope.abandon": {
        const s = this.scopes.get(e.scope);
        if (!s) break;
        s.status = e.kind === "scope.merge" ? "merged" : e.reason === "restart" ? "lost" : "abandoned";
        if (e.seq !== undefined) s.endSeq = e.seq;
        if (e.t !== undefined) s.endT = e.t;
        if (e.kind === "scope.merge") {
          if (e.report) s.report = e.report;
          if (e.box) s.changed = e.box;
        }
        break;
      }
    }
    return true;
  }

  /** Scopes whose lock is held at the latest seq (open forks, not the base). */
  openScopes(): Scope[] {
    return [...this.scopes.values()].filter((s) => s.id !== "base" && s.status === "open");
  }

  /** The scope tree as nested nodes, children in fork order. */
  tree(id = "base"): TreeNode {
    const s = this.scopes.get(id)!;
    return { scope: s, children: s.children.map((c) => this.tree(c)) };
  }

  /** Timeline rows: depth-first under their parents, one per scope, base first. */
  timelineRows(): TimelineRow[] {
    const rows: TimelineRow[] = [];
    const walk = (id: string) => {
      const s = this.scopes.get(id)!;
      rows.push({ scope: s, start: s.forkT ?? this.events[0]?.t ?? 0, end: s.endT ?? this.now, waits: this.lockWaits.filter((w) => w.parent === id) });
      for (const c of s.children) walk(c);
    };
    walk("base");
    return rows;
  }
}

function newScope(id: string, fields: Partial<Scope>): Scope {
  return { id, parent: null, depth: 0, children: [], ops: 0, refusals: [], lastTool: null, lastT: null, status: "open", brief: "", ...fields };
}

export function union(a: PublicBox, b: PublicBox): PublicBox {
  return { min: a.min.map((v, i) => Math.min(v, b.min[i]!)) as Vec3, max: a.max.map((v, i) => Math.max(v, b.max[i]!)) as Vec3 };
}

/** A scope's work or context box in its own sandbox frame. */
export function toLocal(box: PublicBox, translation: Vec3): PublicBox {
  return { min: box.min.map((v, i) => v - translation[i]!) as Vec3, max: box.max.map((v, i) => v - translation[i]!) as Vec3 };
}

export interface EventFilter {
  doc?: string;
  kind?: string;
  tool?: string;
  refusals?: boolean;
  states?: boolean;
}

/** Feed filter: by document tag, kind prefix and tool substring; refusals only when asked. */
export function filterEvents<E extends ModelEvent>(events: E[], f: EventFilter = {}): E[] {
  return events.filter(
    (e) =>
      (!f.doc || e.doc === f.doc) &&
      (!f.kind || e.kind === f.kind || e.kind.startsWith(f.kind + ".")) &&
      (!f.tool || ("tool" in e ? String(e.tool ?? "") : "").includes(f.tool)) &&
      (!f.refusals || e.kind === "call.refused") &&
      (f.states || e.kind !== "state.add") &&
      // Telemetry records are many and summed in the spend totals; listed only when asked for.
      (f.kind === "otel" || e.kind !== "otel"),
  );
}

const fmtBox = (b: PublicBox | undefined) => (b ? `${b.min.join(",")}..${b.max.join(",")}` : "");

/** One line for the feed. */
export function describe(e: ModelEvent): string {
  switch (e.kind) {
    case "session.open": return `opened ${e.name}${e.bounds ? " " + fmtBox(e.bounds) : ""}`;
    case "session.close": return `closed ${e.name}`;
    case "state.add": return `#${e.id} ${e.state}`;
    case "doc.op": return `${e.op}: ${e.summary} (${e.changed} changed${e.box ? " in " + fmtBox(e.box) : ""})`;
    case "doc.undo":
    case "doc.redo": return `${e.kind.slice(4)} ${e.op} (${e.changed})`;
    case "doc.checkpoint": return `checkpoint "${e.name}"`;
    case "call.start": return `${e.tool}`;
    case "call.end": return `${e.tool} ${e.ok ? "ok" : "error"} ${e.ms} ms, ${e.chars} chars${e.images ? `, ${e.images} image(s)` : ""}`;
    case "call.refused": return `${e.tool} refused [${e.code}] ${e.message}`;
    case "render.produced": return `render ${e.view} ${e.size?.join("×") ?? ""}${e.source === "snapshot" ? " (snapshot)" : ""}`;
    case "scope.fork": return `fork ${e.scope} from ${e.parent || "base"}: ${e.brief} work ${fmtBox(e.work)}`;
    case "scope.merge": return `merge ${e.scope}: ${e.report ?? ""}`;
    case "scope.abandon": return `abandon ${e.scope} (${e.reason})`;
    case "otel": {
      const o = otelEvent(e.record);
      const a = o.attrs;
      return o.name === "api_request" ? `api_request ${a.model ?? ""} in ${a.input_tokens ?? 0} out ${a.output_tokens ?? 0}${a.cost_usd !== undefined ? ` $${Number(a.cost_usd).toFixed(4)}` : ""}`
        : o.name === "tool_result" ? `tool_result ${a.tool_name ?? ""}${a.success === false || a.success === "false" ? " failed" : ""}`
        : o.name;
    }
    default: return e.kind;
  }
}

/** Stable per-scope hue. */
export function scopeHue(id: string): number {
  if (id === "base") return 210;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return (h * 137) % 360;
}

/**
 * Edit density per (x, z) column of the base document. Fed from delta records when there are
 * some, from op boxes (spread evenly) when deltas are off or capped.
 */
export class Activity {
  cells = new Map<string, number>();
  max = 0;
  min: [number, number] | null = null;
  maxXZ: [number, number] | null = null;

  add(x: number, z: number, n = 1): void {
    const k = x + "," + z;
    const v = (this.cells.get(k) ?? 0) + n;
    this.cells.set(k, v);
    if (v > this.max) this.max = v;
    if (!this.min || !this.maxXZ) {
      this.min = [x, z];
      this.maxXZ = [x, z];
    } else {
      this.min = [Math.min(this.min[0], x), Math.min(this.min[1], z)];
      this.maxXZ = [Math.max(this.maxXZ[0], x), Math.max(this.maxXZ[1], z)];
    }
  }

  /** Delta records (x, y, z, id) × n, as an Int32Array. */
  addRecords(rec: ArrayLike<number>): void {
    for (let i = 0; i + 3 < rec.length; i += 4) this.add(rec[i]!, rec[i + 2]!);
  }

  /** An op without deltas: its changed count spread over the box's columns. */
  addBox(box: PublicBox, changed: number): void {
    const w = box.max[0] - box.min[0] + 1, d = box.max[2] - box.min[2] + 1;
    const per = changed / (w * d);
    if (w * d > 65536) return; // too coarse to be useful; skip rather than flood the map
    for (let x = box.min[0]; x <= box.max[0]; x++) for (let z = box.min[2]; z <= box.max[2]; z++) this.add(x, z, per);
  }
}

// -- token spend (13, *Backlog* B3) ----------------------------------------------------------------
//
// Built from Claude Code's OpenTelemetry log records as they come (`otel` events, kept unchanged by
// src/observe/otel.ts), with its own event names and attributes: `user_prompt`, `api_request`
// (input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, request_id),
// `tool_result` (tool_name, tool_parameters, tool_input, request_id, tool_result_size_bytes) and
// `prompt.id`, `agent_id`, `event.timestamp`, `event.sequence` on every record.

export type OtelAttrs = Record<string, unknown>;

/** An OTLP JSON AnyValue as a plain value (int64s arrive as strings). */
export function otelValue(v: unknown): unknown {
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if ("stringValue" in o) return o.stringValue;
  if ("intValue" in o) return Number(o.intValue);
  if ("doubleValue" in o) return Number(o.doubleValue);
  if ("boolValue" in o) return o.boolValue;
  if ("arrayValue" in o) return ((o.arrayValue as { values?: unknown[] } | undefined)?.values ?? []).map(otelValue);
  if ("kvlistValue" in o)
    return Object.fromEntries(((o.kvlistValue as { values?: { key: string; value: unknown }[] } | undefined)?.values ?? []).map((kv) => [kv.key, otelValue(kv.value)]));
  return undefined;
}

export interface OtelEvent {
  name: string;
  attrs: OtelAttrs;
  ts: number;
  seq: number;
}

/** A log record's event name (without `claude_code.`), attributes, time (ms) and sequence. */
export function otelEvent(record: unknown): OtelEvent {
  const r = (record ?? {}) as { attributes?: unknown[]; body?: unknown; timeUnixNano?: unknown };
  const attrs: OtelAttrs = {};
  for (const a of r.attributes ?? []) {
    const kv = a as { key?: unknown; value?: unknown } | null;
    if (kv && typeof kv.key === "string") attrs[kv.key] = otelValue(kv.value);
  }
  const name = String(attrs["event.name"] ?? otelValue(r.body) ?? "").replace(/^claude_code\./, "");
  const ts = Date.parse(String(attrs["event.timestamp"])) || Number(r.timeUnixNano ?? 0) / 1e6 || 0;
  return { name, attrs, ts, seq: Number(attrs["event.sequence"] ?? 0) || 0 };
}

export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  requests: number;
}

const num = (v: unknown) => Number(v) || 0;
const TOKEN_KEYS = [["input", "input_tokens"], ["output", "output_tokens"], ["cacheRead", "cache_read_tokens"], ["cacheWrite", "cache_creation_tokens"]] as const;
export const zeroTokens = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 });
function addTokens(into: Tokens, t: Tokens): void {
  for (const k of ["input", "output", "cacheRead", "cacheWrite", "cost", "requests"] as const) into[k] += t[k];
}

/** The autosketch tool a `tool_result` is for, or null when it is another tool (or details are off). */
export function autosketchTool(attrs: OtelAttrs): string | null {
  let p: unknown = attrs.tool_parameters;
  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch {
      p = null;
    }
  }
  if (p && typeof p === "object" && (p as { mcp_server_name?: unknown }).mcp_server_name) {
    const q = p as { mcp_server_name: unknown; mcp_tool_name?: unknown };
    return /autosketch/i.test(String(q.mcp_server_name)) ? ((q.mcp_tool_name as string | undefined) ?? null) : null;
  }
  const m = /^mcp__(.+?)__(.+)$/.exec(String(attrs.tool_name ?? ""));
  return m && /autosketch/i.test(m[1]!) ? m[2]! : null;
}

/**
 * Whether a call's logged scalar arguments (`call.start` `input`) agree with Claude Code's
 * `tool_input`. Keys only one side has are skipped (defaults, stripped keys), and a `tool_input`
 * cut off before it parses doesn't decide anything: order alone does then.
 */
export function inputAgrees(callInput: Record<string, unknown> | undefined, toolInput: unknown): boolean {
  if (!callInput || toolInput === undefined || toolInput === null) return true;
  let parsed: unknown = toolInput;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return true;
    }
  }
  if (!parsed || typeof parsed !== "object") return true;
  const obj = parsed as Record<string, unknown>;
  for (const [k, v] of Object.entries(callInput)) {
    if (!(k in obj)) continue;
    const p = typeof obj[k] === "string" ? (obj[k] as string).slice(0, 80) : obj[k];
    if (typeof p === typeof v && p !== v) return false;
  }
  return true;
}

/** A tool_result may be logged up to this long after its call ended. */
const MATCH_WINDOW_MS = 120_000;
/** Clock slack: the tool_result's timestamp may read slightly before our call.end. */
const MATCH_SLACK_MS = 2_000;

export interface Prompt {
  id: string;
  t: number;
  length?: number;
  command?: string;
  text?: string;
  tokens: Tokens;
}

export interface ApiRequest {
  id: string;
  prompt: string | null;
  agent: string;
  tokens: Tokens | null;
  results: number;
  model?: unknown;
}

interface PendingResult {
  tool: string;
  ts: number;
  seq: number;
  attrs: OtelAttrs;
}

export interface CallRecord {
  call: number;
  tool: string;
  scope: string | undefined;
  input?: Record<string, string | number | boolean> | undefined;
  startT?: number | undefined;
  endT?: number | undefined;
  result?: PendingResult;
}

export interface CallLabel {
  request: string | undefined;
  bytes?: number;
  outputTokens?: number;
  shared?: number;
}

type CallEvent = Extract<ModelEvent, { kind: "call.start" | "call.end" }>;

export class Spend {
  /** Records seen (after dropping exporter retries). */
  records = 0;
  seen = new Set<string>();
  /** prompt.id → prompt. */
  prompts = new Map<string, Prompt>();
  /** request_id → request (`results`: tool_results it issued). */
  requests = new Map<string, ApiRequest>();
  /** agent_id ("" for the main agent) → tokens. */
  agents = new Map<string, Tokens>();
  /** agent_id → scope id, learned from matched calls that named a scope. */
  agentScope = new Map<string, string>();
  /** call number → call. */
  calls = new Map<number, CallRecord>();
  unmatchedCalls: CallRecord[] = [];
  pendingResults: PendingResult[] = [];
  total = zeroTokens();

  addCall(e: CallEvent): void {
    if (e.kind === "call.start") {
      this.calls.set(e.call, { call: e.call, tool: e.tool, scope: e.scope, input: e.input, startT: e.t });
      return;
    }
    const c = this.calls.get(e.call) ?? { call: e.call, tool: e.tool, scope: e.scope };
    c.endT = e.t;
    this.calls.set(e.call, c);
    this.unmatchedCalls.push(c);
    this.match();
  }

  addOtel(e: Extract<ModelEvent, { kind: "otel" }>): void {
    const o = otelEvent(e.record);
    const a = o.attrs;
    // An exporter retry sends the same records again.
    if (a["session.id"] !== undefined && a["event.sequence"] !== undefined) {
      const key = `${String(a["session.id"])}:${String(a["event.sequence"])}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
    }
    this.records++;
    const promptId = a["prompt.id"] === undefined ? null : String(a["prompt.id"]);
    const prompt = (): Prompt | null => {
      if (promptId === null) return null;
      let p = this.prompts.get(promptId);
      if (!p) this.prompts.set(promptId, (p = { id: promptId, t: o.ts || (e.t ?? 0), tokens: zeroTokens() }));
      return p;
    };
    switch (o.name) {
      case "user_prompt": {
        const p = prompt();
        if (!p) break;
        p.t = o.ts || p.t;
        if (a.prompt_length !== undefined) p.length = num(a.prompt_length);
        if (a.command_name) p.command = String(a.command_name);
        if (typeof a.prompt === "string") p.text = a.prompt;
        break;
      }
      case "api_request": {
        const t = zeroTokens();
        for (const [k, attr] of TOKEN_KEYS) t[k] = num(a[attr]);
        t.cost = num(a.cost_usd);
        t.requests = 1;
        addTokens(this.total, t);
        const p = prompt();
        if (p) addTokens(p.tokens, t);
        const agent = a.agent_id === undefined ? "" : String(a.agent_id);
        if (!this.agents.has(agent)) this.agents.set(agent, zeroTokens());
        addTokens(this.agents.get(agent)!, t);
        if (a.request_id !== undefined) Object.assign(this.request(String(a.request_id)), { prompt: promptId, agent, tokens: t, model: a.model });
        break;
      }
      case "tool_result": {
        if (a.request_id !== undefined) this.request(String(a.request_id)).results++;
        const tool = autosketchTool(a);
        if (!tool) break;
        this.pendingResults.push({ tool, ts: o.ts || (e.t ?? 0), seq: o.seq, attrs: a });
        this.match();
        break;
      }
    }
  }

  request(id: string): ApiRequest {
    let r = this.requests.get(id);
    if (!r) this.requests.set(id, (r = { id, prompt: null, agent: "", tokens: null, results: 0 }));
    return r;
  }

  /**
   * Pairs autosketch `tool_result` records with our `call.end` events (13 B3, "Per action"): by
   * tool name in order (`event.timestamp`, then `event.sequence`), within a time window, skipping
   * calls whose logged arguments disagree with `tool_input`. The MCP never sees the client's
   * `tool_use_id`, so this is the only join there is.
   */
  match(): void {
    if (!this.pendingResults.length || !this.unmatchedCalls.length) return;
    this.pendingResults.sort((x, y) => x.ts - y.ts || x.seq - y.seq);
    const left: PendingResult[] = [];
    for (const r of this.pendingResults) {
      const i = this.unmatchedCalls.findIndex(
        (c) => c.tool === r.tool && (c.endT ?? 0) <= r.ts + MATCH_SLACK_MS && (c.endT ?? 0) >= r.ts - MATCH_WINDOW_MS && inputAgrees(c.input, r.attrs.tool_input),
      );
      if (i < 0) {
        left.push(r);
        continue;
      }
      const c = this.unmatchedCalls.splice(i, 1)[0]!;
      c.result = r;
      if (r.attrs.agent_id !== undefined && c.scope) this.agentScope.set(String(r.attrs.agent_id), c.scope);
    }
    this.pendingResults = left.slice(-500);
    // Calls too old for any later tool_result to claim (no telemetry came for them).
    const newest = Math.max(0, ...this.unmatchedCalls.map((c) => c.endT ?? 0));
    this.unmatchedCalls = this.unmatchedCalls.filter((c) => (c.endT ?? 0) >= newest - 4 * MATCH_WINDOW_MS);
  }

  /**
   * The label for one of our calls: the `output_tokens` of the API request that issued it, split
   * across the tool calls that request issued, and the result's size. `input_tokens` grows with the
   * whole context, so it isn't charged to one action. Undefined until the telemetry arrives.
   */
  label(call: number): CallLabel | undefined {
    const r = this.calls.get(call)?.result;
    if (!r) return undefined;
    const reqId = r.attrs.request_id === undefined ? undefined : String(r.attrs.request_id);
    const req = reqId === undefined ? undefined : this.requests.get(reqId);
    const out: CallLabel = { request: reqId };
    if (r.attrs.tool_result_size_bytes !== undefined) out.bytes = num(r.attrs.tool_result_size_bytes);
    if (req?.tokens) {
      out.outputTokens = Math.round(req.tokens.output / Math.max(1, req.results));
      out.shared = Math.max(1, req.results);
    }
    return out;
  }

  /** Tokens per scope: a subagent's on the scope its calls named, the main agent's on "base". */
  scopeTotals(scope: string): Tokens | undefined {
    const t = zeroTokens();
    let any = false;
    for (const [agent, tokens] of this.agents) {
      if ((agent === "" ? "base" : this.agentScope.get(agent)) !== scope) continue;
      addTokens(t, tokens);
      any = true;
    }
    return any ? t : undefined;
  }

  /** Prompts, newest first. */
  promptList(): Prompt[] {
    return [...this.prompts.values()].sort((a, b) => b.t - a.t);
  }
}
