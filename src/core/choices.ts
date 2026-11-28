/**
 * Choices in chat (docs/design/18-select.md, piece 7; `13`, *Request kinds*, *Choices*): the
 * session's record of every question the agent asked with `world_reply({choices})`. The MCP
 * session holds one (`Session.choices`); `world_reply` adds questions, the in-game UI's
 * `choices.pick` (`ui/choices.ts`) and a typed number on a client without the UI half
 * (`world/prompt.ts`) take a choice. In memory only, ending with the session.
 *
 * Here in `core/` because three layers that may not import each other read it (a tool, `ui/` and
 * `world/`), as `library/candidates.ts` is shared by a tool and `ui/`.
 */

/** Most choices one question offers; the protocol's `CHOICES_MAX`, which tools may not import. */
export const MAX_CHOICES = 9;

/**
 * The modes a choice may switch its request to when the player takes it (`18`, piece 7, *Mode
 * switch*): a plan's "Go ahead" can grant build. Not `select`, whose read grant the mod fixes as the
 * request goes out.
 */
export const SWITCH_MODES = ["ask", "plan", "build"] as const;
export type SwitchMode = (typeof SWITCH_MODES)[number];

export interface ChoiceQuestion {
  /** `q1`, `q2`, …: the id a choice line's `choices.pick` action carries. */
  id: string;
  /** The in-game request the question went to, or null when it went to none. */
  request: number | null;
  /** That request's mode, when it had one (a closed request reopens in it, as with candidates). */
  mode?: "ask" | "plan" | "build" | "select";
  /** The question as the player read it: the reply's lines, joined. */
  question: string;
  choices: string[];
  /** Per choice, the mode taking it switches the request to (aligned with `choices`; absent: no switch). */
  modes?: (SwitchMode | undefined)[];
  /** Set once a choice was taken: later picks answer `answered`. */
  answered: boolean;
}

export class Choices {
  private readonly questions = new Map<string, ChoiceQuestion>();
  private next = 1;

  /** Stores a question under a new id, valid for the rest of the session. */
  add(q: Omit<ChoiceQuestion, "id" | "answered">): ChoiceQuestion {
    const stored: ChoiceQuestion = { id: `q${this.next++}`, ...q, answered: false };
    this.questions.set(stored.id, stored);
    return stored;
  }

  get(id: string): ChoiceQuestion | undefined {
    return this.questions.get(id);
  }

  /** The latest question still unanswered on in-game request `request` (a typed number answers it). */
  openOn(request: number): ChoiceQuestion | undefined {
    let hit: ChoiceQuestion | undefined;
    for (const q of this.questions.values()) if (q.request === request && !q.answered) hit = q;
    return hit;
  }
}

/** A typed answer's choice number, 1-based: the whole text is one digit from 1 to 9, else undefined. */
export function typedChoice(text: string): number | undefined {
  const m = /^\s*([1-9])\s*$/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** A choice line as the player reads it: `[2] ruin 180 blocks west`, marked when taking it switches the mode. */
export function choiceLine(index: number, choice: string, mode?: SwitchMode): string {
  return `[${index + 1}] ${choice}${mode ? ` (switches to ${mode})` : ""}`;
}

/** Longest question quoted back to the agent. */
const QUESTION_MAX = 200;

/**
 * The taken choice as the agent reads it (`18`, piece 7; like `17`'s picks as text): `Choice answer
 * from Kev (request 12) to "Which house?": [2] "ruin 180 blocks west".` The choice's own text, as
 * the agent wrote it; the question left out when empty.
 */
export function choiceText(player: string, q: Pick<ChoiceQuestion, "request" | "question" | "choices" | "modes">, index: number): string {
  const question = q.question.replace(/\s+/g, " ").trim();
  const quoted = question.length > QUESTION_MAX ? question.slice(0, QUESTION_MAX - 1) + "…" : question;
  const mode = q.modes?.[index];
  const switched = mode ? ` The player's answer switched ${q.request !== null ? `request ${q.request}` : "the request"} to ${mode} mode.` : "";
  return `Choice answer from ${player}${q.request !== null ? ` (request ${q.request})` : ""}${quoted ? ` to ${JSON.stringify(quoted)}` : ""}: [${index + 1}] ${JSON.stringify(q.choices[index] ?? "")}.${switched}`;
}
