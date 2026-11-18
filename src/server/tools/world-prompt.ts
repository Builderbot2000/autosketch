import { z } from "zod";
import { MAX_CANDIDATES, type CandidateItem } from "../../library/candidates.js";
import { libraryFor } from "./library-context.js";
import { fail, text, type ToolDeps } from "./shared.js";

/**
 * Answering in-game requests (docs/design/13-live-world.md, *Prompting from the game*, W11). The
 * player sees the agent's activity in the chat but never its own text, so `world_reply` is how the
 * agent talks back. It reaches the game through `session.inGame`, never by importing `world/`.
 *
 * `candidates` (`17`, piece 3) offers prefabs: the list is stored on the session under an id and
 * one line is appended to the reply, clickable (it opens the candidates screen) when the mod has the
 * in-game UI, else listing the cells as plain text.
 */
export function registerWorldPromptTools({ tool, session }: ToolDeps): void {
  tool(
    "world_reply",
    {
      title: "Reply in the game chat",
      description:
        "Answers an in-game request in the Minecraft chat (the player sees nothing else you write). One chat line per entry. " +
        "done:true marks it answered and closes its stream of activity lines; an ask, plan or scan request's mode stays in force until the player ends it in game. request defaults to the open request. " +
        `candidates (≤${MAX_CANDIDATES} library prefabs) adds a clickable [Show candidates] line opening an in-game picker; cells default to the last prefab_sheet's, and the player's picks come back as text. Text, <50 tokens.`,
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
      },
      doc: false,
    },
    async (c, a) => {
      const g = session.inGame;
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
      const opts = { ...(a.done ? { done: true } : {}), ...(a.request !== undefined ? { request: a.request } : {}) };
      const { request, open, held } = g.reply(lines, clickable ? { ...opts, action: { line: a.lines.length, kind: "candidates.open", args: { id: list!.id } } } : opts);
      if (list) {
        list.request = request?.id ?? null;
        list.question = request?.text ?? "";
        if (request?.mode) list.mode = request.mode;
      }
      const n = `${a.lines.length} line${a.lines.length === 1 ? "" : "s"}`;
      const to = request
        ? `to ${request.player.name} (request ${request.id}${open ? "" : ", already closed"})`
        : a.request !== undefined
          ? `for request ${a.request} (unknown: shown to players with log "all")`
          : 'to players with log "all" (no open request)';
      const offered = list ? ` · candidates ${list.id}: ${list.entries.map((e) => `${e.cell} ${e.prefab}`).join(", ")}${clickable ? " (clickable line added)" : " (listed as plain text: the mod has no in-game UI)"}` : "";
      const closed = !a.done || !open ? "" : held ? ` · request answered; its ${held} mode stays in force until the player ends it in game (/autosketch done) or sends a new request` : " · request closed";
      return text(`ok · world_reply · ${n} ${to}${offered}${closed}`);
    },
  );
}

/** The line appended for a candidates list: a link to the screen, or the cells as text. */
function candidatesLine(entries: readonly CandidateItem[], clickable: boolean): string {
  return clickable ? `[Show candidates (${entries.length})]` : `Candidates: ${entries.map((e) => `${e.cell} ${e.prefab}`).join(", ")}`;
}
