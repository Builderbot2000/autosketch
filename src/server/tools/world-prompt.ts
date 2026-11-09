import { z } from "zod";
import { fail, text, type ToolDeps } from "./shared.js";

/**
 * Answering in-game requests (docs/design/13-live-world.md, *Prompting from the game*, W11). The
 * player sees the agent's activity in the chat but never its own text, so `world_reply` is how the
 * agent talks back. It reaches the game through `session.inGame`, never by importing `world/`.
 */
export function registerWorldPromptTools({ tool, session }: ToolDeps): void {
  tool(
    "world_reply",
    {
      title: "Reply in the game chat",
      description:
        "Answers an in-game request in the Minecraft chat (the player sees nothing else you write). One chat line per entry. " +
        "done:true closes the request's stream of activity lines. request defaults to the open request. Text, <50 tokens.",
      inputSchema: {
        lines: z.array(z.string().min(1).max(1000)).min(1).max(20).describe("Chat lines, one per entry"),
        done: z.boolean().optional().describe("The request is finished: close its stream"),
        request: z.number().int().optional().describe("The request id from the channel event (default: the open request)"),
      },
      doc: false,
    },
    (_c, a) => {
      const g = session.inGame;
      if (!g?.connected) return fail("No game is connected, so there is no chat to reply in. In-game requests arrive only through the live world link.");
      const { request, open } = g.reply(a.lines, { ...(a.done ? { done: true } : {}), ...(a.request !== undefined ? { request: a.request } : {}) });
      const n = `${a.lines.length} line${a.lines.length === 1 ? "" : "s"}`;
      const to = request
        ? `to ${request.player.name} (request ${request.id}${open ? "" : ", already closed"})`
        : a.request !== undefined
          ? `for request ${a.request} (unknown: shown to players with log "all")`
          : 'to players with log "all" (no open request)';
      return text(`ok · world_reply · ${n} ${to}${a.done && open ? " · request closed" : ""}`);
    },
  );
}
