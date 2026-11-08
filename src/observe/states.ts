import type { ObserveEvent } from "../core/events.js";

/**
 * The log-wide block-state table (docs/design/12-observability.md, *Block deltas*). Document
 * palette ids are local to one document and can change, so `deltas.bin`, the viewer's voxel
 * endpoints and `/assets/models.json` all use these ids instead. The first time a state is seen it
 * gets the next id and a `state.add` event, so a reader of the log can rebuild the table. Id 0 is
 * always air.
 *
 * One table per log folder (`<workspace>/<doc>/observe/<session>/`): each folder's log is
 * self-contained. The base document and every sandbox writing into a folder share its table.
 */

export class StateIds {
  private readonly byState = new Map<string, number>();
  readonly states: string[] = [];

  constructor(private readonly publish: (e: ObserveEvent) => void) {}

  /** The id of a state, publishing `state.add` the first time (air first, as id 0). */
  id(state: string): number {
    let id = this.byState.get(state);
    if (id !== undefined) return id;
    if (!this.states.length && state !== "minecraft:air") this.id("minecraft:air");
    id = this.states.length;
    this.states.push(state);
    this.byState.set(state, id);
    this.publish({ kind: "state.add", id, state });
    return id;
  }
}

/** Tables per log folder, following `session.open` / `session.close` the way the log routes. */
export class LogTables {
  /** The document whose folder events currently go to. */
  current?: string;
  private readonly tables = new Map<string, StateIds>();

  constructor(private readonly publish: (e: ObserveEvent) => void) {}

  /** Bus annotator: tracks the current folder. Adds nothing to the event. */
  readonly annotate = (_doc: string, e: ObserveEvent): undefined => {
    if (e.kind === "session.open") this.current = e.name;
    else if (e.kind === "session.close" && this.current === e.name) this.current = undefined;
    return undefined;
  };

  table(name: string | undefined = this.current): StateIds | undefined {
    if (name === undefined) return undefined;
    let t = this.tables.get(name);
    if (!t) this.tables.set(name, (t = new StateIds(this.publish)));
    return t;
  }
}
