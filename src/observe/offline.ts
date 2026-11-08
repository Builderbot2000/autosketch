import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { BlockBaker } from "../perception/render/bake.js";
import { ObserveHttp, type DeltaSource } from "./http.js";
import { readSessionLog, resolveSessionDir, type SessionLog } from "./reader.js";
import { LogTables } from "./states.js";

/**
 * `autosketch observe <path>` (docs/design/12-observability.md, *Panels*, 7. Replay): serves a
 * finished session log folder in the viewer, with no MCP session, no document and, unless an
 * instance is given, no Minecraft assets (blocks then draw as flat colour cubes). The viewer
 * rebuilds the build from `deltas.bin` and replays the events with its scrubber; where deltas were
 * off or capped it falls back to the time-lapse snapshots. Loopback only, like the live viewer.
 * Read-only: nothing is written into the log folder.
 */

export interface OfflineOptions {
  /** A session folder, a document's `observe/` folder or a document folder (`reader.ts`). */
  path: string;
  /** 0 (default) for a free port. */
  port?: number;
  getBaker?: () => Promise<BlockBaker>;
  viewerDir?: string;
  log?: (msg: string) => void;
}

export interface OfflineViewer {
  url: string;
  log: SessionLog;
  close(): Promise<void>;
}

export async function serveLog(opts: OfflineOptions): Promise<OfflineViewer> {
  const dir = await resolveSessionDir(opts.path);
  const log = await readSessionLog(dir);
  const opened = log.events.find((e) => e.kind === "session.open");
  const name = opened?.kind === "session.open" ? opened.name : basename(dirname(dirname(dir)));

  // Rebuild the log-wide state table from `state.add`, so models.json uses the log's ids.
  const tables = new LogTables(() => {});
  tables.current = name;
  const table = tables.table(name)!;
  const adds = log.events.flatMap((e) => (e.kind === "state.add" ? [e] : [])).sort((a, b) => a.id - b.id);
  for (const a of adds)
    if (table.id(a.state) !== a.id) {
      opts.log?.(`observe: state table in ${dir} is not contiguous at id ${a.id}; models may be mismatched`);
      break;
    }

  const deltas = log.deltaBytes > 0 ? new FileDeltas(join(dir, "deltas.bin"), log) : undefined;
  const lastSeq = log.events[log.events.length - 1]?.seq ?? 0;
  const http = new ObserveHttp({
    bus: { lastSeq },
    tables,
    sessionId: log.sessionId,
    dirFor: () => dir,
    docFor: () => undefined,
    port: opts.port ?? 0,
    live: false,
    bufferEvents: Math.max(50_000, log.events.length),
    ...(deltas ? { deltas } : {}),
    ...(opts.getBaker ? { getBaker: opts.getBaker } : {}),
    ...(opts.viewerDir ? { viewerDir: opts.viewerDir } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });
  for (const e of log.events) http.onEvent(e);
  const url = await http.start();
  return {
    url,
    log,
    async close() {
      await http.close();
      await deltas?.close();
    },
  };
}

/** A finished `deltas.bin`, read on request. */
class FileDeltas implements DeltaSource {
  readonly bytes: number;
  /** Ops that changed blocks but carry no delta: the writer hit `observe.maxDeltaBytes`. */
  readonly capped: boolean;
  private handle?: Promise<FileHandle>;

  constructor(private readonly path: string, log: SessionLog) {
    this.bytes = log.deltaBytes;
    this.capped = log.events.some((e) => (e.kind === "doc.op" || e.kind === "doc.undo" || e.kind === "doc.redo") && e.changed > 0 && !e.delta);
  }

  size(): number {
    return this.bytes;
  }

  async read(_name: string, offset: number, length: number): Promise<Buffer> {
    const end = Math.min(offset + length, this.bytes);
    if (end <= offset) return Buffer.alloc(0);
    const h = await (this.handle ??= open(this.path, "r"));
    const buf = Buffer.alloc(end - offset);
    const { bytesRead } = await h.read(buf, 0, buf.length, offset);
    return buf.subarray(0, bytesRead);
  }

  async close(): Promise<void> {
    await (await this.handle)?.close();
  }
}
