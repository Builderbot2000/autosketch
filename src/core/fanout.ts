import type { EventSink, ObserveEvent } from "./events.js";

/**
 * Event fan-out (docs/design/13-live-world.md, *Agent → world: patches*; briefs/world, *Event
 * fan-out*). The session's sinks pass every event to the observability sink (12) and to in-process
 * listeners: the world link reads `doc.op`, `doc.undo` and `doc.redo` to build patches, and the
 * in-game activity stream reads the `tool()` wrapper's `call.*` events.
 *
 * A sink is enabled while the observability sink is, or while anything listens, so the events are
 * built even with observability off once a link is open. With no listener it behaves exactly like
 * the observability sink (`NO_EVENTS` when that is off), so an unlinked session pays nothing new.
 *
 * Listeners follow the `EventSink` rules: they must return at once and never throw into the
 * emitter (a throwing listener is isolated). Events are never read back by tools.
 */

/** `doc` is "base" or a scope id, as in the observability envelope (12). */
export type EventListener = (e: ObserveEvent, doc: string) => void;

export class EventFanout {
  private readonly listeners = new Set<EventListener>();
  private readonly sinks = new Map<string, EventSink>();

  /** `downstream` gives the observability sink for a document tag; it is read on every event. */
  constructor(
    private readonly downstream: (doc: string) => EventSink,
    private readonly onError: (e: Error) => void = () => {},
  ) {}

  /** Adds a listener for every document's events. Returns the unsubscribe function. */
  subscribe(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  get listening(): boolean {
    return this.listeners.size > 0;
  }

  /** The sink for a document tag; the same object for the same tag, so documents can keep it. */
  sink(doc: string): EventSink {
    let s = this.sinks.get(doc);
    if (s) return s;
    const listeners = this.listeners;
    const downstream = this.downstream;
    const onError = this.onError;
    s = {
      get enabled() {
        return listeners.size > 0 || downstream(doc).enabled;
      },
      emit(e) {
        const d = downstream(doc);
        if (d.enabled) d.emit(e);
        for (const fn of listeners) {
          try {
            fn(e, doc);
          } catch (err) {
            onError(err as Error);
          }
        }
      },
    };
    this.sinks.set(doc, s);
    return s;
  }
}
