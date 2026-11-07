import { access, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Vec3 } from "../core/region.js";
import { dataVersionFor } from "../core/version.js";
import { Document, type Facing } from "../document/document.js";
import { loadNative, saveNative } from "../document/native.js";
import type { PaletteBook } from "../palette/pick.js";

/**
 * One document per session (docs/design/04-document.md). Documents live in the workspace as
 * `<workspace>/<name>/doc.autosketch` and are saved automatically shortly after each change.
 */

export function defaultWorkspace(env = process.env): string {
  return env.AUTOSKETCH_WORKSPACE || join(homedir(), "autosketch");
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
export const AUTOSAVE_MS = 400;

export class Session {
  doc?: Document;
  private savedRevision = -1;
  private timer?: NodeJS.Timeout;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    readonly workspace: string,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  pathFor(name: string): string {
    return join(this.workspace, name, "doc.autosketch");
  }

  get path(): string | undefined {
    return this.doc && this.pathFor(this.doc.meta.name);
  }

  require(): Document {
    if (!this.doc) throw new Error("No document is open. Call doc_new({name}) to start one, or doc_open({name}) (doc_list shows saved ones).");
    return this.doc;
  }

  async create(opts: { name: string; size?: Vec3; front?: Facing; seed?: number; overwrite?: boolean; mcVersion: string; palettes: PaletteBook }): Promise<Document> {
    checkName(opts.name);
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
    await this.flush();
    return this.doc;
  }

  async open(name: string, palettes: PaletteBook): Promise<Document> {
    checkName(name);
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
    return doc;
  }

  /** Makes an imported document current and saves it under its name in the workspace. */
  async adopt(doc: Document, opts: { overwrite?: boolean } = {}): Promise<Document> {
    checkName(doc.meta.name);
    if (!opts.overwrite && (await exists(this.pathFor(doc.meta.name)))) throw new Error(`a document named "${doc.meta.name}" already exists; pass another name or overwrite:true`);
    await this.close();
    this.doc = doc;
    this.savedRevision = -1;
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

  async close(): Promise<void> {
    await this.flush();
    this.doc = undefined;
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
