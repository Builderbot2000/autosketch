import { AsyncLocalStorage } from "node:async_hooks";
import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NO_EVENTS, type EventSink } from "../core/events.js";
import { toPublic, type Vec3 } from "../core/region.js";
import { dataVersionFor } from "../core/version.js";
import { Document, type Facing } from "../document/document.js";
import { loadNative, saveNative } from "../document/native.js";
import type { PaletteBook } from "../palette/pick.js";
import { BASE, refusal, ScopeManager } from "../scope/scopes.js";
import type { ScopeLimits } from "../scope/settings.js";

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

export class Session {
  doc?: Document;
  /** Observability sink (12), handed to each document this session opens. Never read back. */
  events: EventSink = NO_EVENTS;
  /** Sinks for sandbox documents, tagged with their scope id (12). Defaults to `events`. */
  eventsFor?: (doc: string) => EventSink;
  /** Open sandboxes (11). */
  readonly scopes: ScopeManager;
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
      events: (d) => (d === BASE ? this.events : this.eventsFor ? this.eventsFor(d) : this.events),
    });
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
  async adopt(doc: Document, opts: { overwrite?: boolean } = {}): Promise<Document> {
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
