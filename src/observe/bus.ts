import type { EventSink, LoggedEvent, ObserveEvent } from "../core/events.js";

/**
 * The in-process event bus (docs/design/12-observability.md, *Event stream*). Stamps the envelope
 * (`v`, a session-wide `seq`, `t`, `doc`) and hands each event to every subscriber synchronously.
 * Subscribers must only buffer: a subscriber that throws is isolated, and nothing waits on one.
 */

export type Subscriber = (e: LoggedEvent) => void;

export class EventBus {
  private seq = 0;
  private readonly subs = new Set<Subscriber>();

  constructor(private readonly opts: { version?: string; now?: () => number; onError?: (e: Error) => void } = {}) {}

  /** seq of the most recent event (0 before any). */
  get lastSeq(): number {
    return this.seq;
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** A sink whose events are tagged with `doc` ("base" or a scope id). */
  sink(doc = "base"): EventSink {
    return { enabled: true, emit: (e) => void this.publish(doc, e) };
  }

  publish(doc: string, e: ObserveEvent): LoggedEvent {
    const body = e.kind === "session.open" && this.opts.version && !e.version ? { ...e, version: this.opts.version } : e;
    const ev = { v: 1, seq: ++this.seq, t: (this.opts.now ?? Date.now)(), doc, ...body } as LoggedEvent;
    for (const fn of this.subs) {
      try {
        fn(ev);
      } catch (err) {
        this.opts.onError?.(err as Error);
      }
    }
    return ev;
  }
}
