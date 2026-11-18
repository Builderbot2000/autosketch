import type { Vec3 } from "../core/region.js";
import { orientBox, stateTransformer, type StateOverride } from "../core/rotate.js";
import type { Registry } from "../assets/registry.js";
import type { CandidateItem, CandidateList, Candidates } from "../library/candidates.js";
import type { LoadedPrefab, Prefab } from "../library/prefabs.js";
import { CANDIDATE_GHOST, type CandidatesOpenResult, type PlayerRef, type RequestMode } from "../world/protocol/messages.js";
import { UiRequestError } from "./errors.js";
import type { CandidateBlocks, GhostRegions } from "./ghosts.js";

/**
 * The `candidates.*` requests (docs/design/17-reusable-components.md, piece 3; `13`, *Request
 * kinds*): the in-game candidates screen reads the lists `world_reply` stored on the session
 * (`library/candidates.ts`). Display data only: nothing here changes the component set or a build.
 *
 * The candidate ghost (`candidates.ghost`): one per session, id `candidate`, drawn through
 * `ghosts.ts`. The prefab is oriented and placed as `stamp` would place it (its `base` anchor, else
 * its minimum corner, at `at`, after `rotate`), so what the player previews is what a stamp there
 * would build.
 *
 * `candidates.submit` (piece 5) turns the picks into text for the agent and nothing else: the MCP
 * never adds them to the component set, the agent does that with `component_set` after reading them.
 */

export interface CandidatesHost {
  /** The session's store (`Session.candidates`). */
  readonly lists: Pick<Candidates, "get">;
  /** Whether in-game request `id` is still open: its activity stream, or its read-only mode held (B6). */
  openRequest(id: number): boolean;
  /** Where the candidate ghost is drawn. */
  readonly ghosts: Pick<GhostRegions, "showCandidate" | "clearCandidate">;
  /** A library prefab by id, with its blocks. */
  load(prefab: string): Promise<{ prefab: Prefab; loaded: LoadedPrefab }>;
  /**
   * Delivers a submit's text to the agent (`InGameRequests.candidatesAnswer`, piece 5): on the open
   * request, or reopening a closed one in its mode. Without it `candidates.submit` is `bad_request`.
   */
  answer?(a: { request: number | null; mode?: RequestMode; player: PlayerRef; question: string; text: string }): Promise<void>;
  /** The registry and plugin state overrides, to turn block states as `stamp` does. */
  registry?(): Registry | undefined;
  stateOverrides?(): readonly StateOverride[];
}

type Args = Record<string, unknown>;

export class CandidateRequests {
  constructor(private readonly host: CandidatesHost) {}

  /** `candidates.open {id}`: the list in the agent's order, the request it answers (`null` once closed) and its question. */
  open(a: Args): CandidatesOpenResult {
    const list = this.list(a);
    if (list.answered) throw new UiRequestError("answered", "These candidates were already answered.");
    const request = list.request !== null && this.host.openRequest(list.request) ? list.request : null;
    return {
      id: list.id,
      request,
      question: list.question,
      entries: list.entries.map((e) => ({ cell: e.cell, prefab: e.name, root: e.root, size: [...e.size], tags: [...e.tags], notes: e.notes })),
    };
  }

  /**
   * `candidates.ghost {id, prefab, dimension, at, rotate?}`: one of the list's prefabs as the
   * candidate ghost, sent whole after the result and replacing any earlier one. `prefab` is the name
   * `candidates.open` gave (the library id is accepted too).
   */
  async ghost(a: Args): Promise<{ result: Record<string, unknown>; after: () => void }> {
    const list = this.list(a);
    const ref = a.prefab;
    if (typeof ref !== "string" || !ref) throw new UiRequestError("bad_request", "prefab must be one of the list's prefabs");
    const dimension = a.dimension;
    if (typeof dimension !== "string" || !dimension) throw new UiRequestError("bad_request", "dimension must be non-empty text");
    const at = a.at;
    if (!Array.isArray(at) || at.length !== 3 || !at.every((v) => Number.isInteger(v))) throw new UiRequestError("bad_request", "at must be [x, y, z], integers");
    const rotate = a.rotate ?? 0;
    if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) throw new UiRequestError("bad_request", "rotate must be 0, 90, 180 or 270");
    const entry: CandidateItem | undefined = list.entries.find((e) => e.name === ref) ?? list.entries.find((e) => e.prefab === ref);
    if (!entry) throw new UiRequestError("not_found", `"${ref}" isn't one of candidates ${list.id}.`);
    let p: { prefab: Prefab; loaded: LoadedPrefab };
    try {
      p = await this.host.load(entry.prefab);
    } catch (e) {
      throw new UiRequestError("not_found", `${entry.prefab} is no longer in the library (${(e as Error).message}).`);
    }
    const reg = this.host.registry?.();
    const overrides = this.host.stateOverrides?.() ?? [];
    const blocks = orientCandidate(p.prefab, p.loaded, dimension, at as Vec3, rotate / 90, { ...(reg ? { registry: reg } : {}), overrides });
    return { result: { ghost: CANDIDATE_GHOST }, after: () => this.host.ghosts.showCandidate(blocks) };
  }

  /** `candidates.ghost.clear`: `{}`, and a `ui.ghost.clear` of the candidate ghost when one is shown. */
  ghostClear(): { result: Record<string, unknown>; after: () => void } {
    return { result: {}, after: () => void this.host.ghosts.clearCandidate() };
  }

  /**
   * `candidates.submit {id, picks, note?}` (piece 5): the picks as one line of text for the agent, on
   * the list's request (reopened in its mode when it has closed), then `{request}`. Marks the list
   * answered, so later opens and submits answer `answered`, and clears the candidate ghost.
   */
  async submit(a: Args, player: PlayerRef): Promise<{ result: Record<string, unknown>; after: () => void }> {
    const list = this.list(a);
    if (list.answered) throw new UiRequestError("answered", "These candidates were already answered.");
    if (!this.host.answer) throw new UiRequestError("bad_request", "This Autosketch can't send picks to the agent.");
    const picks = a.picks;
    if (!Array.isArray(picks) || picks.length === 0) throw new UiRequestError("bad_request", "picks must be a non-empty list of {prefab, cell, label?}");
    const chosen: { entry: CandidateItem; label?: string }[] = [];
    for (const [i, p] of picks.entries()) {
      const { prefab, cell, label } = (p ?? {}) as Args;
      if (typeof prefab !== "string" || !prefab || typeof cell !== "string" || !cell) throw new UiRequestError("bad_request", `picks[${i}] needs prefab and cell`);
      if (label !== undefined && typeof label !== "string") throw new UiRequestError("bad_request", `picks[${i}].label must be text`);
      const entry = list.entries.find((e) => e.cell === cell && (e.name === prefab || e.prefab === prefab));
      if (!entry) throw new UiRequestError("not_found", `${cell} ${prefab} isn't one of candidates ${list.id}.`);
      if (chosen.some((c) => c.entry === entry)) throw new UiRequestError("bad_request", `${cell} ${prefab} is picked twice`);
      chosen.push({ entry, ...(label?.trim() ? { label: label.trim() } : {}) });
    }
    const note = a.note;
    if (note !== undefined && typeof note !== "string") throw new UiRequestError("bad_request", "note must be text");
    const text = picksText(player.name, list.request, chosen, note);
    // Answered before the await, so a second submit meanwhile (another player) is refused; undone if delivery fails.
    list.answered = true;
    try {
      await this.host.answer({ request: list.request, ...(list.mode ? { mode: list.mode } : {}), player, question: list.question, text });
    } catch (e) {
      list.answered = false;
      throw new UiRequestError("internal", `The picks weren't sent: ${(e as Error).message}.`);
    }
    return { result: { request: list.request }, after: () => void this.host.ghosts.clearCandidate() };
  }

  private list(a: Args): CandidateList {
    const id = a.id;
    if (typeof id !== "string" || !id) throw new UiRequestError("bad_request", "id must be a candidates id from the reply line");
    const list = this.host.lists.get(id);
    if (!list) throw new UiRequestError("not_found", `No candidates "${id}" in this session.`);
    return list;
  }
}

/**
 * A prefab turned `turns` quarter turns clockwise and placed as `stamp` places it: positions through
 * `core/rotate.ts`' `orientBox`, which `stamp`'s `prefabFrame` uses too, and states through the same
 * `stateTransformer`. The oriented prefab fills [0, size), and its `base` anchor (else its minimum
 * corner) lands on world `at`.
 */
export function orientCandidate(prefab: Prefab, loaded: LoadedPrefab, dimension: string, at: Vec3, turns: number, opts: { registry?: Registry; overrides?: readonly StateOverride[] } = {}): CandidateBlocks {
  const snap = loaded.snapshot;
  const [w, h, l] = snap.size;
  const { place, size } = orientBox(snap.size, turns);
  const turn = turns ? stateTransformer({ turns }, opts) : (s: string) => s;
  const palette = snap.palette.map((s, i) => (i === 0 ? s : turn(s)));
  const blocks = new Uint32Array(size[0] * size[1] * size[2]);
  for (let y = 0; y < h; y++)
    for (let z = 0; z < l; z++)
      for (let x = 0; x < w; x++) {
        const v = snap.blocks[x + z * w + y * w * l]!;
        if (!v) continue;
        const q = place([x, y, z]);
        blocks[q[0] + q[2] * size[0] + q[1] * size[0] * size[2]] = v;
      }
  const base = prefab.meta.anchors.base;
  const a: Vec3 = base ? place(base) : [0, 0, 0];
  return { dimension, origin: [at[0] - a[0], at[1] - a[1], at[2] - a[2]], size, palette, blocks };
}

/**
 * The picks as the agent reads them (`17`, piece 5): `Candidates answer from Kev (request 12): picked
 * B2 gothic_tower_a as "corner tower", A3 gate_small. Note: smaller if possible.` Prefabs by the
 * library id the agent stamps with; a blank note is left out.
 */
export function picksText(player: string, request: number | null, picks: readonly { entry: Pick<CandidateItem, "cell" | "prefab">; label?: string }[], note?: string): string {
  const picked = picks.map((p) => `${p.entry.cell} ${p.entry.prefab}${p.label ? ` as ${JSON.stringify(p.label)}` : ""}`).join(", ");
  const n = note?.trim().replace(/\s+/g, " ");
  const tail = n ? ` Note: ${n}${/[.!?]$/.test(n) ? "" : "."}` : "";
  return `Candidates answer from ${player}${request !== null ? ` (request ${request})` : ""}: picked ${picked}.${tail}`;
}
