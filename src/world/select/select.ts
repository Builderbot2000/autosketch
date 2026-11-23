import type { Vec3 } from "../../core/region.js";
import { refusal } from "../../scope/scopes.js";
import type { BridgeConnection } from "../bridge.js";
import type { GameContext, SearchRequest, SearchResult } from "../protocol/messages.js";
import { resolveMaterials, type MaterialGroup, type MaterialLookup } from "./materials.js";
import { describeSearch, heatMap, type HeatMap } from "./search.js";

/**
 * The agent's select requests in the world (docs/design/18-select.md, pieces 2 to 4 and 9): the
 * search state for the current in-game request (and, from T2, the candidate). Logic only; the tools
 * (`server/tools/world-select.ts`) reach it through `Session.worldSelect`, never by importing
 * `world/` (ARCHITECTURE.md, *Dependency rules*).
 *
 * The mod keeps a search's place per select grant (`13`, *Select*), so `continue` asks the mod to walk
 * on; every answer covers the whole walk so far, so the state here is replaced, never merged.
 */

export interface WorldSelectOptions {
  bridge: Pick<BridgeConnection, "request" | "connected">;
  /** The in-game request the state belongs to now (held or open), or undefined. */
  request: () => number | undefined;
  /** The request's prompt context (dimension, player position), when known. */
  context: () => GameContext | undefined;
  /** The dimension to use when the request's own isn't known. */
  dimension?: () => string | undefined;
}

export interface SearchArgs {
  /** Block ids, canonical states, `family:<id>` or `#tags`, as the agent gives them. */
  materials?: string[];
  radius?: number;
  around?: Vec3;
  stop?: number;
  continue?: boolean;
}

/** What the tool returns: the heat map and the text. */
export interface SearchAnswer {
  result: SearchResult;
  map: HeatMap;
  text: string;
}

/** A search request without its id (the bridge numbers it). */
type SearchReq = SearchRequest extends infer T ? (T extends unknown ? Omit<T, "id"> : never) : never;

interface SearchState {
  request: number | undefined;
  groups: MaterialGroup[];
  groupOf: number[];
  result: SearchResult;
}

export class WorldSelect {
  private searchState?: SearchState;

  constructor(private readonly opts: WorldSelectOptions) {}

  /** The current request's latest search answer (the whole walk so far), if any. */
  get lastSearch(): SearchResult | undefined {
    return this.state()?.result;
  }

  /** `world_search` (`18`, piece 2): a new walk, or the last one continued. */
  async search(a: SearchArgs, lookup: MaterialLookup): Promise<SearchAnswer> {
    const ctx = this.opts.context();
    const dimension = ctx?.dimension ?? this.opts.dimension?.();
    if (!this.opts.bridge.connected) throw refusal("world_disconnected", "No game is connected, so nothing can be searched.");
    if (!dimension) throw refusal("world_no_request", "No select request is open: the player starts one with /autosketch select.");
    let groups: MaterialGroup[], groupOf: number[], req: SearchReq;
    if (a.continue) {
      if (a.materials !== undefined || a.radius !== undefined || a.around !== undefined)
        throw new Error("continue walks on with the first search's materials, radius and centre: give only continue (and stop)");
      const prev = this.state();
      if (!prev) throw new Error("there is no search to continue in this request: start one with materials");
      ({ groups, groupOf } = prev);
      req = { type: "search", dimension, continue: true, ...(a.stop !== undefined ? { stop: a.stop } : {}) };
    } else {
      if (!a.materials?.length) throw new Error("give materials (block ids, family:<id>, #tags), or continue:true");
      const m = resolveMaterials(a.materials, lookup);
      ({ groups, groupOf } = m);
      req = {
        type: "search",
        dimension,
        materials: m.wire,
        ...(a.radius !== undefined ? { radius: a.radius } : {}),
        ...(a.around ? { around: a.around } : {}),
        ...(a.stop !== undefined ? { stop: a.stop } : {}),
      };
    }
    const request = this.opts.request();
    const result = await this.opts.bridge.request(req);
    this.searchState = { request, groups, groupOf, result };
    const pos = ctx?.position;
    const playerChunk: [number, number] | undefined = pos ? [Math.floor(pos[0]) >> 4, Math.floor(pos[2]) >> 4] : undefined;
    const from: [number, number] = pos ? [Math.floor(pos[0]), Math.floor(pos[2])] : [result.centre[0] * 16 + 8, result.centre[1] * 16 + 8];
    const fromName = pos ? `the player (x ${from[0]} z ${from[1]})` : `the centre chunk (x ${from[0]} z ${from[1]})`;
    const map = heatMap(result, playerChunk);
    const text = describeSearch(result, { groups, groupOf, from, fromName, continued: !!a.continue }) + "\n" + map.caption;
    return { result, map, text };
  }

  /** The search state, dropped when the request changed. */
  private state(): SearchState | undefined {
    const s = this.searchState;
    if (s && s.request !== this.opts.request()) this.searchState = undefined;
    return this.searchState;
  }
}
