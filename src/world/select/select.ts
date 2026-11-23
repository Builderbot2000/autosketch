import type { Vec3 } from "../../core/region.js";
import { refusal } from "../../scope/scopes.js";
import type { BridgeConnection } from "../bridge.js";
import { FILL_CONNECTIVITY, MASK_MARGIN, type ExpandBy, type FillResult, type GameContext, type MaskSection, type SearchRequest, type SearchResult } from "../protocol/messages.js";
import type { WorldView } from "../view.js";
import { CANDIDATE, candidateMask, describeFill, frozenRuns, sectionKey, type FillDescription } from "./fill.js";
import { familyMembers, resolveMaterials, type MaterialGroup, type MaterialLookup } from "./materials.js";
import type { Mask } from "../../core/mask.js";
import { describeSearch, heatMap, type HeatMap } from "./search.js";

/**
 * The agent's select requests in the world (docs/design/18-select.md, pieces 2 to 4 and 9): the
 * search state and the fill (the candidate) for the current in-game request. Logic only; the tools
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
  /** The world view the candidate is named in and its margin read into (`18`, pieces 3 and 5). */
  view?: () => WorldView | undefined;
}

/** `world_fill`'s match: `"block"` (the seed's block, any state), `"family"` (the seed's family), or materials. */
export type FillMatch = "block" | "family" | string[];

export interface FillArgs {
  seed: Vec3;
  match: FillMatch;
  connectivity?: 6 | 18 | 26;
  budget?: number;
  /** Chunks of the initial read area around the seed's chunk (wire default 1). */
  area?: number;
  /** Blocks read around the candidate's sections into the world view (default 8; 0 to 16). */
  margin?: number;
}

export interface ExpandArgs {
  by: ExpandBy;
  budget?: number;
  margin?: number;
}

/** What `world_fill` and `world_expand` return. */
export interface FillAnswer {
  result: FillResult;
  /** The whole candidate now. */
  mask: Mask;
  text: string;
}

interface FillState {
  request: number | undefined;
  dimension: string;
  match: string;
  connectivity: number;
  /** The whole shape, per section (an expand's delta replaces its sections). */
  sections: Map<string, MaskSection>;
  result: FillResult;
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
  private fillState?: FillState;

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

  /** The current request's candidate shape, per section, if a fill made one. */
  get candidateSections(): readonly MaskSection[] | undefined {
    const f = this.fill_();
    return f && [...f.sections.values()];
  }

  /**
   * `world_fill` (`18`, piece 3): grows a new shape from `seed` in the mod (replacing the last fill,
   * there and here), names it `candidate` in the world view and reads its sections plus `margin`
   * into the view.
   */
  async fill(a: FillArgs, lookup: MaterialLookup): Promise<FillAnswer> {
    const dimension = this.dimensionOrRefuse();
    const margin = checkMargin(a.margin);
    const { wire, label } = await this.fillMatch(a, dimension, lookup);
    const request = this.opts.request();
    const connectivity = a.connectivity ?? FILL_CONNECTIVITY;
    const result = await this.opts.bridge.request({
      type: "fill",
      dimension,
      seed: a.seed,
      match: wire,
      ...(a.connectivity !== undefined ? { connectivity: a.connectivity } : {}),
      ...(a.budget !== undefined ? { budget: a.budget } : {}),
      ...(a.area !== undefined ? { area: a.area } : {}),
    });
    const st: FillState = { request, dimension, match: label, connectivity, sections: new Map(result.sections.map((s) => [sectionKey(s.section), s])), result };
    // A seed that matched nothing leaves nothing to expand (the mod's fill is empty too).
    this.fillState = result.box ? st : undefined;
    return this.answer(st, { tool: "world_fill", result, match: label, connectivity, ...(a.budget !== undefined ? { budget: a.budget } : {}) }, result.sections, margin);
  }

  /**
   * `world_expand` (`18`, piece 4): grows the mod's read area for the current fill and resumes it with
   * a fresh budget; the answer's changed sections replace those held, and are re-read with their
   * margin into the world view.
   */
  async expand(a: ExpandArgs): Promise<FillAnswer> {
    const dimension = this.dimensionOrRefuse();
    const margin = checkMargin(a.margin);
    const st = this.fill_();
    if (!st) throw new Error("there is no fill to expand in this request: start one with world_fill");
    if (st.dimension !== dimension) throw new Error(`the fill was made in ${st.dimension}; start a new one with world_fill`);
    const before = st.result.count;
    const result = await this.opts.bridge.request({ type: "expand", dimension, by: a.by, ...(a.budget !== undefined ? { budget: a.budget } : {}) });
    if (this.fill_() !== st) throw refusal("world_view_stale", "The in-game request changed while the fill was expanding; start a new fill for the new request.");
    for (const s of result.sections) st.sections.set(sectionKey(s.section), s);
    st.result = result;
    return this.answer(st, { tool: "world_expand", by: a.by, result, before, match: st.match, connectivity: st.connectivity, ...(a.budget !== undefined ? { budget: a.budget } : {}) }, result.sections, margin);
  }

  /** Names the candidate in the view, reads `toRead` plus the margin, and words the answer. */
  private async answer(st: FillState, d: Omit<FillDescription, "sections" | "read">, toRead: readonly MaskSection[], margin: number): Promise<FillAnswer> {
    const all = [...st.sections.values()];
    const view = this.opts.view?.();
    let read: FillDescription["read"];
    if (view && !st.result.box) view.doc.selections.delete(CANDIDATE);
    if (view && st.result.box) {
      view.doc.selections.set(CANDIDATE, { frozen: frozenRuns(all) });
      if (toRead.length) {
        try {
          read = { what: await view.readMask(toRead.map((s) => s.section), margin), margin, sections: toRead.length };
        } catch (e) {
          read = { error: (e as Error).message };
        }
        // A read that went stale emptied the view: name the candidate in the view that is current.
        view.doc.selections.set(CANDIDATE, { frozen: frozenRuns(all) });
      }
    }
    const text = describeFill({ ...d, sections: all.length, ...(read ? { read } : {}) });
    return { result: st.result, mask: candidateMask(all), text };
  }

  /** The wire match and its words: the seed's block or family (read from the world), or the materials resolved as given. */
  private async fillMatch(a: FillArgs, dimension: string, lookup: MaterialLookup): Promise<{ wire: string[]; label: string }> {
    if (Array.isArray(a.match)) {
      if (!a.match.length) throw new Error('match is empty: give "block", "family", or materials (block ids, family:<id>, #tags, "solid")');
      const m = resolveMaterials(a.match, lookup, { solid: true });
      return { wire: m.wire, label: m.groups.map((g) => (g.members > 1 ? `${g.given} (${g.members} ids)` : g.given)).join(", ") };
    }
    const snap = await this.opts.bridge.request({ type: "snapshot", dimension, boxes: [{ min: a.seed, max: a.seed }] });
    const state = snap.palette[snap.regions[0]?.states[0] ?? 0] ?? "minecraft:air";
    const id = state.includes("[") ? state.slice(0, state.indexOf("[")) : state;
    if (id === "minecraft:air" || id === "minecraft:cave_air" || id === "minecraft:void_air")
      throw new Error(`the seed (${a.seed.join(",")}) is air (or not generated), so it has no ${a.match} to match: pick a block of the build`);
    if (a.match === "block") return { wire: [id], label: `the seed's block ${id}` };
    const f = lookup.index?.familyOfBlock(id);
    if (!f) return { wire: [id], label: `the seed's block ${id} (it has no family)` };
    const members = familyMembers(f).filter((m) => lookup.registry.has(m));
    if (!members.includes(id)) members.push(id);
    return { wire: members, label: `the seed's family ${f.id} (${members.length} ids)` };
  }

  private dimensionOrRefuse(): string {
    const dimension = this.opts.context()?.dimension ?? this.opts.dimension?.();
    if (!this.opts.bridge.connected) throw refusal("world_disconnected", "No game is connected, so nothing can be filled.");
    if (!dimension) throw refusal("world_no_request", "No select request is open: the player starts one with /autosketch select.");
    return dimension;
  }

  /** The fill state, dropped when the request changed. */
  private fill_(): FillState | undefined {
    const f = this.fillState;
    if (f && f.request !== this.opts.request()) this.fillState = undefined;
    return this.fillState;
  }

  /** The search state, dropped when the request changed. */
  private state(): SearchState | undefined {
    const s = this.searchState;
    if (s && s.request !== this.opts.request()) this.searchState = undefined;
    return this.searchState;
  }
}

function checkMargin(m: number | undefined): number {
  const v = m ?? MASK_MARGIN;
  if (!Number.isInteger(v) || v < 0 || v > 16) throw new Error("margin is 0 to 16 blocks");
  return v;
}
