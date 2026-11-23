import { choiceText, type Choices } from "../core/choices.js";
import type { PlayerRef, RequestMode } from "../world/protocol/messages.js";
import { UiRequestError } from "./errors.js";

/**
 * `choices.pick {id, index}` (docs/design/18-select.md, piece 7; `13`, *Request kinds*, *Choices*):
 * a clicked choice line. The choice's text, as the agent wrote it, goes to the agent as the player's
 * answer on the question's request (reopened in its mode when it has closed), exactly as candidates
 * picks do (`17`, piece 5, `candidates.ts`); then `{request}`. A question takes one answer: later
 * picks, and a typed number (`world/prompt.ts`), answer `answered`.
 */

export interface ChoicesHost {
  /** The session's questions (`Session.choices`). */
  readonly questions: Pick<Choices, "get">;
  /** Delivers the answer's text to the agent (`InGameRequests.candidatesAnswer`). Without it the kind is `bad_request`. */
  answer?(a: { request: number | null; mode?: RequestMode; player: PlayerRef; question: string; text: string }): Promise<void>;
}

type Args = Record<string, unknown>;

export class ChoiceRequests {
  constructor(private readonly host: ChoicesHost) {}

  async pick(a: Args, player: PlayerRef): Promise<{ result: Record<string, unknown> }> {
    const id = a.id;
    if (typeof id !== "string" || !id) throw new UiRequestError("bad_request", "id must be a choices id from the choice line");
    const index = a.index;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0) throw new UiRequestError("bad_request", "index must be a choice's index, from 0");
    const q = this.host.questions.get(id);
    if (!q) throw new UiRequestError("not_found", `No question "${id}" in this session.`);
    if (index >= q.choices.length) throw new UiRequestError("not_found", `Question ${id} has ${q.choices.length} choices.`);
    if (q.answered) throw new UiRequestError("answered", "A choice was already taken for this question.");
    if (!this.host.answer) throw new UiRequestError("bad_request", "This Autosketch can't send answers to the agent.");
    // Answered before the await, so a second click meanwhile is refused; undone if delivery fails.
    q.answered = true;
    try {
      await this.host.answer({ request: q.request, ...(q.mode ? { mode: q.mode } : {}), player, question: q.question, text: choiceText(player.name, q, index) });
    } catch (e) {
      q.answered = false;
      throw new UiRequestError("internal", `The choice wasn't sent: ${(e as Error).message}.`);
    }
    return { result: { request: q.request } };
  }
}
