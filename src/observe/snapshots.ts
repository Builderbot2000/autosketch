import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoggedEvent, ObserveEvent } from "../core/events.js";
import type { Document } from "../document/document.js";
import type { BlockBaker } from "../perception/render/bake.js";
import { renderDocument } from "../perception/render/render.js";
import type { SnapshotMode } from "./settings.js";

/**
 * Time-lapse snapshots (docs/design/12-observability.md, *Time-lapse snapshots*): after a
 * checkpoint (or, once scoped sessions exist, a merge) on the base document, renders it with the
 * existing rasterizer (`flat`, `iso_ne`, 512²) into `snapshots/<seq>.png`.
 *
 * Never inside a tool call: triggers are debounced, and the render waits until no tool call is in
 * flight, then runs on its own. Renders are serialised; triggers that arrive meanwhile collapse
 * into one more render. `<seq>` is the bus seq when the render started: the picture shows the
 * document as of that event. The render itself runs on the main thread, so a tool call that
 * arrives mid-render waits for the rasterizer's synchronous part.
 */

export interface SnapshotOptions {
  mode: Exclude<SnapshotMode, "off">;
  /** Session folder for a document name. */
  dirFor: (doc: string) => string;
  getDoc: () => Document | undefined;
  getBaker: () => Promise<BlockBaker>;
  lastSeq: () => number;
  /** Publishes `render.produced` for each snapshot written. */
  publish?: (e: ObserveEvent) => void;
  debounceMs?: number;
  log?: (msg: string) => void;
}

export class SnapshotScheduler {
  private inflight = 0;
  private wanted = false;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private waiters: (() => void)[] = [];
  private readonly trigger: ObserveEvent["kind"];

  constructor(private readonly opts: SnapshotOptions) {
    this.trigger = opts.mode === "merge" ? "scope.merge" : "doc.checkpoint";
  }

  readonly onEvent = (e: LoggedEvent): void => {
    if (e.kind === "call.start") this.inflight++;
    else if (e.kind === "call.end") {
      this.inflight = Math.max(0, this.inflight - 1);
      if (this.inflight === 0 && this.wanted && !this.timer) this.kick();
    } else if (e.kind === this.trigger && e.doc === "base") {
      this.wanted = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.kick();
      }, this.opts.debounceMs ?? 500);
      this.timer.unref?.();
    }
  };

  /** Resolves once no snapshot is wanted or rendering (for tests and shutdown). */
  idle(): Promise<void> {
    if (!this.wanted && !this.running && !this.timer) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  private kick(): void {
    if (!this.wanted || this.inflight > 0 || this.running || this.timer) return;
    this.wanted = false;
    this.running = this.render()
      .catch((e: Error) => this.opts.log?.(`observe: snapshot failed: ${e.message}`))
      .finally(() => {
        this.running = undefined;
        if (this.wanted) this.kick();
        if (!this.wanted && !this.running && !this.timer) for (const w of this.waiters.splice(0)) w();
      });
  }

  private async render(): Promise<void> {
    const doc = this.opts.getDoc();
    if (!doc) return;
    const baker = await this.opts.getBaker();
    const seq = this.opts.lastSeq();
    const r = await renderDocument(doc, baker, { views: ["iso_ne"], size: 512, style: "flat" });
    const dir = join(this.opts.dirFor(doc.meta.name), "snapshots");
    await mkdir(dir, { recursive: true });
    const file = `${seq}.png`;
    await writeFile(join(dir, file), r.png);
    this.opts.publish?.({ kind: "render.produced", view: "iso_ne", size: [r.width, r.height], source: "snapshot", path: `snapshots/${file}` });
  }
}
