import { z } from "zod";
import { choiceLine, MAX_CHOICES, SWITCH_MODES, type SwitchMode } from "../../core/choices.js";
import { MAX_CANDIDATES, type CandidateItem } from "../../library/candidates.js";
import { libraryFor } from "./library-context.js";
import { boxSchema, fail, text, type ToolDeps } from "./shared.js";
import { fromPublic, toPublic, type PublicBox } from "../../core/region.js";

/**
 * Answering in-game requests (docs/design/13-live-world.md, *Prompting from the game*, W11). The
 * player sees the agent's activity in the chat but never its own text, so `world_reply` is how the
 * agent talks back. It reaches the game through `session.inGame`, never by importing `world/`.
 *
 * `candidates` (`17`, piece 3) offers prefabs: the list is stored on the session under an id and
 * one line is appended to the reply, clickable (it opens the candidates screen) when the mod has the
 * in-game UI, else listing the cells as plain text.
 *
 * `choices` (`18`, piece 7) asks a multiple-choice question: stored on the session under an id
 * (`core/choices.ts`), each choice sent as its own `chat` reply carrying the `choices.pick` action
 * (one action per message, `17`), then a plain *"or type your own answer"* line. Without the in-game
 * UI, the choices go as numbered plain lines in the reply, answered by typing the number. Either way
 * the answer reaches the agent as text, like picks. A choice given as `{text, at}` is a proposed hit:
 * its world box is pulsed in the world through the in-game UI (`18`, piece 8; `Session.pulseHits`).
 */
export function registerWorldPromptTools({ tool, session }: ToolDeps): void {
  tool(
    "world_reply",
    {
      title: "Reply in the game chat",
      description:
        "Answers an in-game request in the Minecraft chat (the player sees nothing else you write). One chat line per entry. " +
        "done:true marks it answered and closes its stream of activity lines; an ask, plan or select request's mode stays in force until the player ends it in game. request defaults to the open request. " +
        `candidates (≤${MAX_CANDIDATES} library prefabs) adds a clickable [Show candidates] line opening an in-game picker; cells default to the last prefab_sheet's, and the player's picks come back as text. ` +
        `choices (≤${MAX_CHOICES}) asks a multiple-choice question after the lines: one clickable line per choice (numbered lines the player answers by typing the number on a client without the UI), plus "or type your own answer"; the chosen choice's text comes back as the player's answer. A choice given as {text, at:box} (world coordinates, e.g. a search cluster) is also pulsed in the world so the player can turn and see it. {text, mode} switches the request to that mode when the player picks it (e.g. a plan's "Go ahead" with mode "build" grants edits); only the player's pick switches it. Text, <50 tokens.`,
      inputSchema: {
        lines: z.array(z.string().min(1).max(1000)).min(1).max(20).describe("Chat lines, one per entry"),
        done: z.boolean().optional().describe("The request is answered: close its stream (a read-only mode stays until the player ends it)"),
        request: z.number().int().optional().describe("The request id from the channel event (default: the open request)"),
        candidates: z
          .array(z.object({ prefab: z.string().min(1).describe("A prefab id or name"), cell: z.string().optional().describe('Its cell id, like "B2" (default: its cell on the last prefab_sheet)') }))
          .min(1)
          .max(MAX_CANDIDATES)
          .optional()
          .describe("Prefabs to offer the player in the candidates screen"),
        choices: z
          .array(
            z.union([
              z.string().min(1).max(200),
              z.object({
                text: z.string().min(1).max(200),
                at: boxSchema.optional().describe("World box to pulse in the world for this choice"),
                mode: z.enum(SWITCH_MODES).optional().describe("The mode the request switches to when the player picks this choice"),
              }),
            ]),
          )
          .min(1)
          .max(MAX_CHOICES)
          .optional()
          .describe("Answers the player can click, in order (shown as [1] …, [2] …); {text, at} also pulses a world box; {text, mode} switches the request's mode when picked"),
      },
      doc: false,
    },
    async (c, raw) => {
      const g = session.inGame;
      // Choices as text, and the world boxes of those given with `at` (proposed hits).
      const hits: PublicBox[] = [];
      const modes: (SwitchMode | undefined)[] = [];
      const a = {
        ...raw,
        choices: raw.choices?.map((ch) => {
          if (typeof ch === "string") return modes.push(undefined), ch;
          if (ch.at) hits.push(toPublic(fromPublic(ch.at)));
          modes.push(ch.mode);
          return ch.text;
        }),
      };
      if (!g?.connected) return fail("No game is connected, so there is no chat to reply in. In-game requests arrive only through the live world link.");
      let entries: CandidateItem[] | undefined;
      if (a.candidates) {
        try {
          entries = await session.candidates.resolve(libraryFor(c, session), a.candidates);
        } catch (e) {
          return fail(`Nothing was sent: ${(e as Error).message}.`);
        }
      }
      const list = entries ? session.candidates.add({ request: null, question: "", entries }) : undefined;
      // Without the in-game UI the line can't open anything, so it lists the cells instead.
      const clickable = !!list && g.clickable;
      const lines = list ? [...a.lines, candidatesLine(list.entries, clickable)] : a.lines;
      const question = a.choices ? session.choices.add({ request: null, question: a.lines.join(" "), choices: a.choices, ...(modes.some((m) => m) ? { modes } : {}) }) : undefined;
      // Choices: one message per clickable line (one action per chat message); else numbered lines in this one.
      const split = !!question && g.clickable;
      const first = question && !split ? [...lines, ...a.choices!.map((c, i) => choiceLine(i, c, modes[i])), plainChoicesLine(g.current?.mode ?? "select")] : lines;
      const opts = { ...(a.done && !split ? { done: true } : {}), ...(a.request !== undefined ? { request: a.request } : {}) };
      const { request, open, held } = g.reply(first, clickable ? { ...opts, action: { line: a.lines.length, kind: "candidates.open", args: { id: list!.id } } } : opts);
      let answered = { open, held };
      if (split) {
        // The rest go to the request the first message reached (or, like it, to none).
        const to = request ? { request: request.id } : a.request !== undefined ? { request: a.request } : {};
        // Each tagged with the question, so a client half that folds can fold them once it is answered (`18`, piece 7, *Folding*).
        const tag = { question: question!.id };
        a.choices!.forEach((c, index) => g.reply([choiceLine(index, c, modes[index])], { ...to, ...tag, action: { line: 0, kind: "choices.pick", args: { id: question!.id, index } } }));
        const last = g.reply([CLICK_CHOICES_LINE], { ...to, ...tag, ...(a.done ? { done: true } : {}) });
        answered = { open: last.open, held: last.held };
      }
      for (const stored of [list, question]) {
        if (!stored) continue;
        stored.request = request?.id ?? null;
        if (stored === list) stored.question = request?.text ?? "";
        if (request?.mode) stored.mode = request.mode;
      }
      const n = `${a.lines.length} line${a.lines.length === 1 ? "" : "s"}`;
      const to = request
        ? `to ${request.player.name} (request ${request.id}${open ? "" : ", already closed"})`
        : a.request !== undefined
          ? `for request ${a.request} (unknown: shown to players with log "all")`
          : 'to players with log "all" (no open request)';
      const pulsed = hits.length ? (session.pulseHits?.(hits) ? ` · ${hits.length} hit${hits.length === 1 ? "" : "s"} pulsed in the world` : " · hits not pulsed (the mod has no in-game UI)") : "";
      const switches = modes.flatMap((m, i) => (m ? [`[${i + 1}] → ${m}`] : []));
      const asked = question ? ` · choices ${question.id}: ${a.choices!.length}${split ? " clickable lines" : " numbered plain lines (the mod has no in-game UI; the player types the number)"}${switches.length ? `; picking ${switches.join(", ")} switches the request's mode` : ""}; the answer comes back as an event` : "";
      const offered = list ? ` · candidates ${list.id}: ${list.entries.map((e) => `${e.cell} ${e.prefab}`).join(", ")}${clickable ? " (clickable line added)" : " (listed as plain text: the mod has no in-game UI)"}` : "";
      const closed = !a.done || !answered.open ? "" : answered.held ? ` · request answered; its ${answered.held} mode stays in force until the player ends it in game (/autosketch done) or sends a new request` : " · request closed";
      return text(`ok · world_reply · ${n} ${to}${offered}${asked}${pulsed}${closed}`);
    },
  );
}

/** The line after clickable choices (`18`, piece 7): free text stays open. */
const CLICK_CHOICES_LINE = "or type your own answer";
/**
 * The line after numbered plain choices, for a client without the UI: the number is typed as a
 * request (`world/prompt.ts` takes a one-digit request as the choice), in the open request's mode.
 */
function plainChoicesLine(mode: string): string {
  return `Answer with the number (/autosketch ${mode} 2), or type your own answer.`;
}

/** The line appended for a candidates list: a link to the screen, or the cells as text. */
function candidatesLine(entries: readonly CandidateItem[], clickable: boolean): string {
  return clickable ? `[Show candidates (${entries.length})]` : `Candidates: ${entries.map((e) => `${e.cell} ${e.prefab}`).join(", ")}`;
}
