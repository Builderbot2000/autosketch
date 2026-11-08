import type { EventSink, LoggedEvent, ObserveEvent } from "../core/events.js";

/**
 * The in-process event bus (docs/design/12-observability.md, *Event stream*). Stamps the envelope
 * (`v`, a session-wide `seq`, `t`, `doc`) and hands each event to every subscriber synchronously.
 * Subscribers must only buffer: a subscriber that throws is isolated, and nothing waits on one.
 */

export type Subscriber = (e: LoggedEvent) => void;
export type Annotator = (doc: string, e: ObserveEvent) => Record<string, unknown> | undefined;

export class EventBus {
  private seq = 0;
  private readonly subs = new Set<Subscriber>();
  private readonly annotators = new Set<Annotator>();

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

  /**
   * Adds an annotator: it runs before the event gets its `seq` and may return fields to add (the
   * delta writer's `delta` reference). It may publish events of its own first (`state.add`), which
   * then come before this one in `seq` order. Like subscribers, it must only do cheap work.
   */
  annotate(fn: Annotator): () => void {
    this.annotators.add(fn);
    return () => this.annotators.delete(fn);
  }

  publish(doc: string, e: ObserveEvent): LoggedEvent {
    let body = e.kind === "session.open" && this.opts.version && !e.version ? { ...e, version: this.opts.version } : e;
    for (const fn of this.annotators) {
      try {
        const extra = fn(doc, body);
        if (extra) body = { ...body, ...extra } as ObserveEvent;
      } catch (err) {
        this.opts.onError?.(err as Error);
      }
    }
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
