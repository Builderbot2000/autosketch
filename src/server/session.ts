import { AsyncLocalStorage } from "node:async_hooks";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NO_EVENTS, type EventSink } from "../core/events.js";
import { EventFanout, type EventListener } from "../core/fanout.js";
import { toPublic, type Vec3 } from "../core/region.js";
import { dataVersionFor } from "../core/version.js";
import { Document, type Facing } from "../document/document.js";
import { loadNative, saveNative } from "../document/native.js";
import type { PaletteBook } from "../palette/pick.js";
import { BASE, refusal, ScopeManager } from "../scope/scopes.js";
import type { ScopeLimits } from "../scope/settings.js";
import type { LinkOpenOptions, WorldLink } from "../world/link.js";
import type { InGameReplies } from "../world/prompt.js";

/**
 * One document per session (docs/design/04-document.md). Documents live in the workspace as
 * `<workspace>/<name>/doc.autosketch` and are saved automatically shortly after each change.
 *
 * Scoped sessions (11): the session also holds the open sandboxes (`scopes`). A tool call runs
 * inside `inScope(scope, …)`, and `require()` returns the document that call addresses: the base
 * document, or the sandbox named by `scope`. Sandboxes live in memory only and are abandoned when
 * the document closes.
 */

export function defaultWorkspace(env = process.env): string {
  return env.AUTOSKETCH_WORKSPACE || join(homedir(), "autosketch");
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const AUTOSAVE_MS = 400;

/** A tool call as call hooks see it. */
export interface CallInfo {
  tool: string;
  /** The scope the call addresses ("base" or a scope id); "base" for tools that take no scope. */
  scope: string;
  /** Whether the tool works on a document (takes `scope`). */
  doc: boolean;
  mutating: boolean;
}

/**
 * Runs around every tool call, inside the call's scope (13: the world link syncs a dirty cache
 * before a call and adds the `world:` line to a result). Installed by layers the entry point wires
 * in; a session without hooks runs tools exactly as before.
 */
export interface CallHook {
  /** Before the tool runs; may throw (a refusal) to stop the call. */
  before?(call: CallInfo): Promise<void> | void;
  /** After the tool returned a result (not when it threw); may return a changed result. */
  after?(call: CallInfo, result: CallToolResult): Promise<CallToolResult> | CallToolResult;
}

export class Session {
  doc?: Document;
  /** The observability sinks set by the entry point (12); `events` hands out the fan-out over them. */
  private observeSink: EventSink = NO_EVENTS;
  private observeSinkFor?: (doc: string) => EventSink;
  /**
   * Every event the session's documents and tool calls publish, to the observability sink and to
   * in-process listeners (`subscribe`; 13, *Event fan-out*). Without listeners it is the
   * observability sink's behaviour exactly.
   */
  private readonly fanout = new EventFanout((d) => (d === BASE || !this.observeSinkFor ? this.observeSink : this.observeSinkFor(d)), (e) => this.log(`event listener failed: ${e.message}`));
  /** Open sandboxes (11). */
  readonly scopes: ScopeManager;
  /** The live world link (13), when the entry point wired one in. Tools never use it. */
  world?: WorldLink;
  /** Answers to in-game requests (13, *Prompting from the game*), for `world_reply`; set beside `world`. */
  inGame?: InGameReplies;
  /** Hooks around each tool call, in order (see `CallHook`). */
  readonly callHooks: CallHook[] = [];
  /** The scope the current tool call addresses ("base" outside any call). */
  private readonly addressed = new AsyncLocalStorage<string>();
  private savedRevision = -1;
  private timer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    readonly workspace: string,
    private readonly log: (msg: string) => void = () => {},
    opts: { scopeLimits?: ScopeLimits } = {},
  ) {
    this.scopes = new ScopeManager(() => this.doc, {
      ...(opts.scopeLimits ? { limits: opts.scopeLimits } : {}),
      events: (d) => this.fanout.sink(d),
    });
  }

  /** The base document's sink (12): handed to each document this session opens. Never read back by tools. */
  get events(): EventSink {
    return this.fanout.sink(BASE);
  }

  /** Sets the observability sink for the base document (and for sandboxes unless `eventsFor` is set). */
  set events(sink: EventSink) {
    this.observeSink = sink;
  }

  /** Sinks for sandbox documents, tagged with their scope id (12). */
  get eventsFor(): (doc: string) => EventSink {
    return (d) => this.fanout.sink(d);
  }

  /** Sets the observability sinks for sandbox documents. */
  set eventsFor(fn: ((doc: string) => EventSink) | undefined) {
    this.observeSinkFor = fn;
  }

  /**
   * Listens to every event of the session (13, *Event fan-out*): the base document's and
   * sandboxes' `doc.*` and `scope.*` events and the tool wrapper's `call.*` events, tagged with
   * "base" or the scope id, live even with observability off. Listeners must return at once.
   * Returns the unsubscribe function.
   */
  subscribe(fn: EventListener): () => void {
    return this.fanout.subscribe(fn);
  }

  pathFor(name: string): string {
    return join(this.workspace, name, "doc.autosketch");
  }

  get path(): string | undefined {
    return this.doc && this.pathFor(this.doc.meta.name);
  }

  /** The document the current call addresses (the base document, or a sandbox by `scope`). */
  require(): Document {
    const scope = this.scope;
    if (scope !== BASE) return this.scopes.docOf(scope);
    if (!this.doc) throw new Error("No document is open. Call doc_new({name}) to start one, or doc_open({name}) (doc_list shows saved ones).");
    return this.doc;
  }

  /** Like `require`, but undefined when no document is open. */
  get current(): Document | undefined {
    return this.scope === BASE ? this.doc : this.scopes.scopes.get(this.scope)?.doc;
  }

  /** The scope id the current call addresses, or "base". */
  get scope(): string {
    return this.addressed.getStore() ?? BASE;
  }

  /**
   * Runs a tool call against a scope (11, *Addressing*). Without `scope` the call goes to the base
   * document, except that while any scope is open a mutating call must name its target ("base" or
   * a scope id), so a subagent that forgets its id gets an error instead of editing the wrong document.
   */
  inScope<T>(scope: string | undefined, mutating: boolean, run: () => T): T {
    if (scope === undefined && mutating && this.scopes.openCount > 0) {
      const open = [...this.scopes.scopes.keys()];
      throw refusal("scope_required", `Scoped jobs are open (${open.join(", ")}), so this call must name its target: scope:"<id>" for a job's sandbox, or scope:"base" for the base document.`);
    }
    if (scope !== undefined && scope !== BASE) this.scopes.get(scope);
    return this.addressed.run(scope ?? BASE, run);
  }

  /** Runs a tool body through the call hooks (the `tool()` wrapper calls it inside `inScope`). */
  async runCall(call: CallInfo, run: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
    if (!this.callHooks.length) return run();
    for (const h of this.callHooks) await h.before?.(call);
    let result: CallToolResult;
    try {
      result = await run();
    } catch (e) {
      // A refused or failed call still ends: hooks that count running calls (the world link) must
      // unwind, or every later result loses its `world:` line. Their output is dropped with the error.
      for (const h of this.callHooks) if (h.after) await Promise.resolve(h.after(call, { content: [], isError: true })).catch(() => {});
      throw e;
    }
    for (const h of this.callHooks) if (h.after) result = await h.after(call, result);
    return result;
  }

  /** Refuses to replace the base document while jobs forked from it are open. */
  private checkNoScopes(action: string): void {
    const n = this.scopes.openCount;
    if (n) throw refusal("scopes_open", `Can't ${action} while ${n} scoped job${n === 1 ? " is" : "s are"} open (${[...this.scopes.scopes.keys()].join(", ")}): merge or abandon ${n === 1 ? "it" : "them"} first (scope_list).`);
  }

  async create(opts: { name: string; size?: Vec3; front?: Facing; seed?: number; overwrite?: boolean; mcVersion: string; palettes: PaletteBook }): Promise<Document> {
    checkName(opts.name);
    this.checkNoScopes("start a new document");
    if (!opts.overwrite && (await exists(this.pathFor(opts.name)))) throw new Error(`a document named "${opts.name}" already exists; doc_open it, pick another name, or pass overwrite:true`);
    await this.close();
    const dataVersion = dataVersionFor(opts.mcVersion) ?? 0;
    this.doc = Document.create({
      name: opts.name,
      dataVersion,
      palettes: opts.palettes,
      ...(opts.size ? { size: opts.size } : {}),
      ...(opts.front ? { front: opts.front } : {}),
      ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    });
    this.savedRevision = -1;
    this.observe(this.doc);
    await this.flush();
    return this.doc;
  }

  async open(name: string, palettes: PaletteBook): Promise<Document> {
    checkName(name);
    this.checkNoScopes("open another document");
    const path = this.pathFor(name);
    if (!(await exists(path))) {
      const have = (await this.list()).map((d) => d.name);
      throw new Error(`no document "${name}" in ${this.workspace}${have.length ? ` (have: ${have.join(", ")})` : ""}`);
    }
    await this.close();
    const doc = await loadNative(path, { palettes });
    doc.meta.name = name;
    this.doc = doc;
    this.savedRevision = doc.revision;
    this.observe(doc);
    return doc;
  }

  /** Makes an imported document current and saves it under its name in the workspace. */
  /**
   * Opens the base document linked to the world (13, W2: `doc_open({ world: true })`), through the
   * link the entry point wired in. Refused while scoped jobs are open, like any document switch.
   */
  async linkWorld(opts: LinkOpenOptions): Promise<{ doc: Document; report: string }> {
    if (!this.world?.open) throw refusal("world_disconnected", "The live world link isn't available in this server.");
    this.checkNoScopes("link the world");
    return this.world.open(opts);
  }

  async adopt(doc: Document,opts: { overwrite?: boolean } = {}): Promise<Document> {
    checkName(doc.meta.name);
    this.checkNoScopes("import a document");
    if (!opts.overwrite && (await exists(this.pathFor(doc.meta.name)))) throw new Error(`a document named "${doc.meta.name}" already exists; pass another name or overwrite:true`);
    await this.close();
    this.doc = doc;
    this.savedRevision = -1;
    this.observe(doc);
    await this.flush();
    return doc;
  }

  /** The open document's exports/ folder. */
  get exportsDir(): string | undefined {
    return this.doc && join(this.workspace, this.doc.meta.name, "exports");
  }

  async list(): Promise<{ name: string; modified: Date; bytes: number }[]> {
    let names: string[];
    try {
      names = await readdir(this.workspace);
    } catch {
      return [];
    }
    const out: { name: string; modified: Date; bytes: number }[] = [];
    for (const n of names) {
      try {
        const s = await stat(this.pathFor(n));
        out.push({ name: n, modified: s.mtime, bytes: s.size });
      } catch {
        /* not a document folder */
      }
    }
    return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  }

  /** Schedules an autosave after a change. */
  touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), AUTOSAVE_MS);
    this.timer.unref?.();
  }

  /** Saves now if there are unsaved changes. Returns the file size when it wrote. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const doc = this.doc;
    if (!doc || doc.revision === this.savedRevision) return this.saving;
    const rev = doc.revision;
    const path = this.pathFor(doc.meta.name);
    this.saving = this.saving
      .then(() => saveNative(doc, path))
      .then(() => {
        if (this.doc === doc) this.savedRevision = rev;
      })
      .catch((e: Error) => this.log(`autosave of ${path} failed: ${e.message}`));
    return this.saving;
  }

  /** Saves and closes the document. Open scopes are abandoned (11: they live in memory only). */
  async close(): Promise<void> {
    this.scopes.abandonAll("restart");
    await this.flush();
    if (this.doc && this.events.enabled) this.events.emit({ kind: "session.close", name: this.doc.meta.name });
    this.doc = undefined;
  }

  /** Hands the sink to a newly current document and announces it (12, `session.open`). */
  private observe(doc: Document): void {
    doc.events = this.events;
    this.scopes.attach(doc);
    if (!this.events.enabled) return;
    const b = doc.localBounds();
    this.events.emit({ kind: "session.open", name: doc.meta.name, ...(b ? { bounds: toPublic(b) } : {}) });
  }
}

function checkName(name: string): void {
  if (!NAME.test(name)) throw new Error(`document name must start with a letter or digit and use letters, digits, _ or - (max 64; got "${name}")`);
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
