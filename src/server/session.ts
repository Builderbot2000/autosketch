import { AsyncLocalStorage } from "node:async_hooks";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Choices } from "../core/choices.js";
import { NO_EVENTS, type EventSink } from "../core/events.js";
import { EventFanout, type EventListener } from "../core/fanout.js";
import { toPublic, type PublicBox, type Vec3 } from "../core/region.js";
import { dataVersionFor } from "../core/version.js";
import { Document, type Facing } from "../document/document.js";
import { loadNative, saveNative } from "../document/native.js";
import { Candidates } from "../library/candidates.js";
import { ComponentSet } from "../library/component-set.js";
import type { PaletteBook } from "../palette/pick.js";
import { BASE, refusal, ScopeManager } from "../scope/scopes.js";
import type { ScopeLimits } from "../scope/settings.js";
import type { LinkOpenOptions, WorldLink } from "../world/link.js";
import type { InGameReplies } from "../world/prompt.js";
import type { WorldView } from "../world/view.js";
import type { WorldSelect } from "../world/select/select.js";
import type { Registry } from "../assets/registry.js";
import type { ImportUpgrade } from "../formats/index.js";
import type { SchematicUpgrader } from "../formats/upgrade.js";
import type { InstanceContext } from "./context.js";

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
  // An unexpanded placeholder (an MCPB host's empty optional field) counts as unset, as in context.ts's launchEnv.
  const w = env.AUTOSKETCH_WORKSPACE?.trim();
  return w && !/^\$\{[^}]*\}$/.test(w) ? w : join(homedir(), "autosketch");
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

/** Locator hints for `loadInstance` (as `setup --version` / `--base-jar` save them). */
export interface InstanceLoadOptions {
  version?: string;
  baseJar?: string;
}

/**
 * How the entry point loads an instance after startup, and what tools say while there is none
 * (docs/design/14-distribution.md, *Setup*: an unconfigured server still starts). Installed as
 * `session.setup`; a session without it can only be given an instance with `setInstance`.
 */
export interface InstanceSetup {
  /** Loads the instance folder into a context (the registry, palette, plugins…). */
  load(path: string, opts?: InstanceLoadOptions): Promise<InstanceContext>;
  /**
   * The instance config.toml names now, if any: one saved since startup (`autosketch setup`, or by
   * hand) is loaded in place on the next tool call, with no restart.
   */
  saved?(): ({ path: string } & InstanceLoadOptions) | undefined;
  /** The text of the `not_configured` answer: discovered instances, a `setup` command for each, the UI's URL. */
  notConfigured(): Promise<string>;
}

export class Session {
  doc?: Document;
  /** Loads instances after startup and explains their absence (`InstanceSetup`); set by the entry point. */
  setup?: InstanceSetup;
  /** The instance the tools use: loaded, loading or failed; undefined while not configured. */
  private instanceCtx?: Promise<InstanceContext>;
  private instanceFailed = false;
  private instanceWaiters: ((c: InstanceContext) => void)[] = [];
  private instanceReady?: InstanceContext;
  private savedFailure?: { key: string; error: unknown };
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
  /**
   * How imports and prefab loads upgrade files from other versions, and the DataVersion exports
   * stamp (14, *Schematics from other versions*): the linked game's data fixer and version when the
   * mod serves `upgrade`, else the registry report's version, else the instance's (`fallback`).
   */
  schematicVersion(registry: Registry | undefined, fallback: number | undefined): ImportUpgrade {
    const upgrader = this.upgrader?.();
    const dataVersion = upgrader?.dataVersion ?? (this.world?.bridge.connected ? this.world.bridge.hello?.game.dataVersion : undefined) ?? registry?.report?.dataVersion ?? fallback;
    return { ...(dataVersion ? { dataVersion } : {}), ...(upgrader ? { upgrader } : {}) };
  }
  /**
   * The linked game's data fixer, when there is one (undefined while unlinked or the mod lacks
   * `upgrade`). Injected by the entry point, which wires `world/` in (`world/upgrade.ts`); tools reach
   * it only through `schematicVersion`.
   */
  upgrader?: () => SchematicUpgrader | undefined;
  /**
   * The flash on save (17, piece 8): `prefab_save` hands it the saved box, local to `doc` ("base" or
   * a scope id). Set by the entry point to the in-game UI's feed, which sends it only while the base
   * document is linked; undefined without the UI. Tools never see the link.
   */
  saveFlash?: (box: PublicBox, doc: string) => void;
  /**
   * Proposed hits (18, piece 8): `world_reply` hands it the world boxes of the choices it offers, to
   * pulse in the world. Set by the entry point to the in-game UI's feed; false when nothing could be
   * shown (no mod with the UI, or no request's dimension). Tools never see the link.
   */
  pulseHits?: (boxes: PublicBox[]) => boolean;
  /** Answers to in-game requests (13, *Prompting from the game*), for `world_reply`; set beside `world`. */
  inGame?: InGameReplies;
  /**
   * The world view (18, piece 5): the blocks read from the world for the current request, held
   * beside the open document (never replacing it, and alongside open sandboxes). Tools address it
   * with `view: "world"`; set by the entry point beside `world`.
   */
  worldView?: WorldView;
  /**
   * The agent's select requests in the world (18, pieces 2 to 4 and 9): the current request's search
   * state and its fill, the candidate. Set by the entry point beside `worldView`.
   */
  worldSelect?: WorldSelect;
  /**
   * The session's component set (17, piece 1): the prefabs the player picked, kept by
   * `component_set`. Not tied to a document: it survives opening and closing documents and ends
   * with the session (the process), never saved except as a kit the player asks for.
   */
  readonly componentSet = new ComponentSet();
  /**
   * The last prefab sheet's cells and the candidates lists offered with `world_reply` (17, piece 3),
   * which the in-game UI's `candidates.*` requests read. Session-long, in memory only.
   */
  readonly candidates = new Candidates();
  /**
   * The questions asked with `world_reply({choices})` (18, piece 7), which the in-game UI's
   * `choices.pick` and a typed number answer. Session-long, in memory only.
   */
  readonly choices = new Choices();
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

  /** The instance tools use (loaded, still loading, or failed), or undefined while not configured (`14`, *Setup*). */
  get instance(): Promise<InstanceContext> | undefined {
    return this.instanceCtx;
  }

  /** True while an instance is loaded or loading, so `loadInstance` would be refused. */
  get hasInstance(): boolean {
    return this.instanceCtx !== undefined && !this.instanceFailed;
  }

  /** Gives the session the instance it starts with (the entry point's launch or config.toml instance). */
  setInstance(ctx: Promise<InstanceContext>): void {
    this.instanceCtx = ctx;
    this.instanceFailed = false;
    ctx.then(
      (c) => {
        if (this.instanceCtx !== ctx) return;
        this.instanceReady = c;
        for (const w of this.instanceWaiters.splice(0)) w(c);
      },
      () => {
        if (this.instanceCtx === ctx) this.instanceFailed = true;
      },
    );
  }

  /** Resolves once an instance has loaded (at startup or by `loadInstance`); never rejects. */
  whenInstance(): Promise<InstanceContext> {
    if (this.instanceReady) return Promise.resolve(this.instanceReady);
    return new Promise((ok) => this.instanceWaiters.push(ok));
  }

  /**
   * Loads an instance in place, without a restart (`15`, *Instance tab and first-run setup*: the
   * first choice). Only while nothing is loaded or loading: switching away from a loaded instance
   * is refused (`instance_loaded`), since the registry, atlas and open documents are built on it;
   * that needs config.toml and a restart. Allowed after a failed load. A failed load leaves the
   * session unconfigured again and rejects with the reason. Does not write config.toml.
   */
  async loadInstance(path: string, opts: InstanceLoadOptions = {}): Promise<InstanceContext> {
    return this.startLoad(path, opts);
  }

  /** `loadInstance`'s synchronous start, so a second call made at once is already refused. */
  private startLoad(path: string, opts: InstanceLoadOptions): Promise<InstanceContext> {
    if (this.hasInstance) return Promise.reject(refusal("instance_loaded", "An instance is already loaded; choosing another one is saved in config.toml and takes effect when the server restarts."));
    if (!this.setup) return Promise.reject(new Error("This server can't load an instance in place."));
    const p = this.setup.load(path, opts);
    this.setInstance(p);
    return p.catch((e: unknown) => {
      if (this.instanceCtx === p) {
        this.instanceCtx = undefined;
        this.instanceFailed = false;
      }
      throw e;
    });
  }

  /**
   * The instance for a tool call: the current one, else one config.toml names now (saved since
   * startup), loaded in place; undefined while not configured.
   */
  instanceForCall(): Promise<InstanceContext> | undefined {
    if (this.instanceCtx && !this.instanceFailed) return this.instanceCtx;
    const saved = this.setup?.saved?.();
    if (!saved) return this.instanceCtx;
    // A saved choice that already failed isn't retried on every call; changing config.toml retries it.
    const key = JSON.stringify(saved);
    if (this.savedFailure?.key === key) return Promise.reject(this.savedFailure.error);
    const { path, ...opts } = saved;
    const p = this.startLoad(path, opts);
    p.catch((error: unknown) => (this.savedFailure = { key, error }));
    return p;
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
    for (let i = 0; i < this.callHooks.length; i++) {
      try {
        await this.callHooks[i]!.before?.(call);
      } catch (e) {
        // A hook refused the call (13, B6: the request mode rule): the hooks that already ran their
        // `before` must unwind too, or the world link counts this call as running forever.
        for (const h of this.callHooks.slice(0, i)) if (h.after) await Promise.resolve(h.after(call, { content: [], isError: true })).catch(() => {});
        throw e;
      }
    }
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
