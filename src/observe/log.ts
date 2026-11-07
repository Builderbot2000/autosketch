import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { LoggedEvent } from "../core/events.js";

/**
 * The buffered `events.ndjson` writer (docs/design/12-observability.md, *Event stream*).
 *
 * A bus subscriber: `onEvent` only appends a line to an in-memory queue and returns. A timer
 * flushes the queue with async appends off the tool-call path. When the disk falls behind and the
 * backlog passes `maxPendingBytes`, new events are dropped and counted; the next line written is
 * an `observe.dropped` marker (no `seq`, it is not a bus event), so a reader knows there is a gap.
 *
 * Routing: the log lives in the open document's folder, `<workspace>/<doc>/observe/<session>/`.
 * `session.open` names the document; events with no document open (the `call.start` of the
 * `doc_new` that opens one, say) wait in a small buffer and go into the next document's log.
 */

export interface EventLogOptions {
  workspace: string;
  sessionId: string;
  /** Session folders kept per document, this one included; older ones are pruned. */
  retain: number;
  flushMs?: number;
  maxPendingBytes?: number;
  /** Events kept while no document is open. */
  maxOrphans?: number;
  log?: (msg: string) => void;
  /** File operations, replaceable in tests. */
  fs?: { appendFile: typeof appendFile; mkdir: typeof mkdir; readdir: typeof readdir; rm: typeof rm };
}

export const sessionDir = (workspace: string, doc: string, sessionId: string): string => join(workspace, doc, "observe", sessionId);

/** A sortable session id: UTC time to the millisecond plus a short random tail. */
export function newSessionId(now = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(".", "")}-${Math.random().toString(36).slice(2, 6)}`;
}

export class EventLog {
  /** Events dropped because the writer fell behind or no document opened in time. */
  dropped = 0;
  private unreported = 0;
  private current?: string;
  private orphans: string[] = [];
  /** Queued lines per session folder. */
  private readonly queues = new Map<string, string[]>();
  private pendingBytes = 0;
  private timer?: NodeJS.Timeout;
  private writing: Promise<void> = Promise.resolve();
  private readonly ready = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();
  private readonly fs: NonNullable<EventLogOptions["fs"]>;

  constructor(private readonly opts: EventLogOptions) {
    this.fs = opts.fs ?? { appendFile, mkdir, readdir, rm };
  }

  dirFor(doc: string): string {
    return sessionDir(this.opts.workspace, doc, this.opts.sessionId);
  }

  readonly onEvent = (e: LoggedEvent): void => {
    if (e.kind === "session.open") {
      this.current = e.name;
      const held = this.orphans;
      this.orphans = [];
      for (const line of held) this.enqueue(this.current, line, true);
    }
    const line = JSON.stringify(e) + "\n";
    if (this.current === undefined) {
      if (this.orphans.length >= (this.opts.maxOrphans ?? 256)) this.drop();
      else this.orphans.push(line);
    } else this.enqueue(this.current, line, false);
    if (e.kind === "session.close") this.current = undefined;
  };

  private drop(): void {
    this.dropped++;
    this.unreported++;
  }

  private enqueue(doc: string, line: string, held: boolean): void {
    if (!held && this.pendingBytes + line.length > (this.opts.maxPendingBytes ?? 8 * 1024 * 1024)) return this.drop();
    const dir = this.dirFor(doc);
    let q = this.queues.get(dir);
    if (!q) this.queues.set(dir, (q = []));
    if (this.unreported) {
      q.push(JSON.stringify({ v: 1, kind: "observe.dropped", t: Date.now(), count: this.unreported }) + "\n");
      this.unreported = 0;
    }
    q.push(line);
    this.pendingBytes += line.length;
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), this.opts.flushMs ?? 200);
      this.timer.unref?.();
    }
  }

  /** Writes everything queued so far. Resolves when it is on disk (or the write failed). */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const [dir, lines] of this.queues) {
      if (!lines.length) continue;
      const data = lines.join("");
      this.queues.set(dir, []);
      const path = join(dir, "events.ndjson");
      this.writing = this.writing
        .then(() => this.prepare(dir))
        .then(() => this.fs.appendFile(path, data))
        .catch((e: Error) => {
          if (!this.failed.has(path)) this.opts.log?.(`observe: writing ${path} failed: ${e.message}`);
          this.failed.add(path);
        })
        .finally(() => {
          this.pendingBytes -= data.length;
        });
    }
    return this.writing;
  }

  async close(): Promise<void> {
    await this.flush();
  }

  /** Creates the session folder once and prunes older sessions of that document. */
  private prepare(dir: string): Promise<void> {
    let p = this.ready.get(dir);
    if (!p) {
      p = this.fs.mkdir(dir, { recursive: true }).then(() => this.prune(join(dir, "..")));
      this.ready.set(dir, p);
    }
    return p;
  }

  private async prune(observeDir: string): Promise<void> {
    try {
      const names = (await this.fs.readdir(observeDir)).filter((n) => n !== this.opts.sessionId).sort();
      const old = names.slice(0, Math.max(0, names.length - (this.opts.retain - 1)));
      await Promise.all(old.map((n) => this.fs.rm(join(observeDir, n), { recursive: true, force: true })));
    } catch (e) {
      this.opts.log?.(`observe: pruning ${observeDir} failed: ${(e as Error).message}`);
    }
  }
}
