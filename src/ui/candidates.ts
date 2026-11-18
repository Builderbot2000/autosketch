import type { CandidateList, Candidates } from "../library/candidates.js";
import type { CandidatesOpenResult } from "../world/protocol/messages.js";
import { UiRequestError } from "./errors.js";

/**
 * The `candidates.*` requests (docs/design/17-reusable-components.md, piece 3; `13`, *Request
 * kinds*): the in-game candidates screen reads the lists `world_reply` stored on the session
 * (`library/candidates.ts`). Display data only: nothing here changes the component set or a build.
 */

export interface CandidatesHost {
  /** The session's store (`Session.candidates`). */
  readonly lists: Pick<Candidates, "get">;
  /** Whether in-game request `id` is still open: its activity stream, or its read-only mode held (B6). */
  openRequest(id: number): boolean;
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

  private list(a: Args): CandidateList {
    const id = a.id;
    if (typeof id !== "string" || !id) throw new UiRequestError("bad_request", "id must be a candidates id from the reply line");
    const list = this.host.lists.get(id);
    if (!list) throw new UiRequestError("not_found", `No candidates "${id}" in this session.`);
    return list;
  }
}
