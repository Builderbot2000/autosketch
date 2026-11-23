# Silo P: Select mode, choices and candidate outline

**Wave 1** (P1, after W1), **wave 2** (P2 after W2, P3 after W2 and T2).

**Specs:** `18` *The workflow*, pieces 1, 7, 8, 10, *Principles*; `13` B6 (modes), *Prompting from the game*; `17` pieces 3, 5 (reply-line action, picks as text); `16` (UI feed, `ui.state`).

## Goal

How a select request reaches the agent, how the agent asks the player, and how the candidate appears in the world.

## Deliverables

**P1**

1. Mode `select` in `src/world/modes.ts`: read-only, volume-changing, drafts refused. The select event text in `src/world/prompt.ts`: the player's words (or "the block under the crosshair" when empty), context, the tools to use in order, and the reminder line rules from `17`. No probe, no grant.
2. The agent guide `library/knowledge/skills/select.md`: the workflow (find, propose, grow, look and trim, confirm), terrain from a starter volume, multiple-choice clarification, never asking for ids. Advisory, like the other skills; measurements, not rules.

**P2**

3. `world_reply({choices: [...]})`: one `chat` message per choice with W2's action, plus "or type your own answer". Without `autosketch:ui`, numbered plain lines.
4. A clicked choice (W2's kind) becomes a channel event on the open request with the choice's text, as picks do; a typed number on a vanilla client maps to the choice. Marked answered once delivered.

**P3**

5. From the candidate (T2): near-range outline boxes and the far-range tinted shell (outer faces of occupied sections, shared faces skipped, merged into rectangles), sent through the UI feed as W2's steady fill record; updated after each fill and expand; cleared on confirm or when the request ends.
6. Hits offered as choices pulsed in the world.

## Files you own

`src/world/modes.ts` and `src/world/prompt.ts` (select), `library/knowledge/skills/select.md`, `src/server/tools/world-prompt.ts` (`choices`), new `src/ui/choices.ts` and `src/ui/candidate-outline.ts`, one dispatch line in `src/ui/requests.ts`, the feed call in `src/ui/feed.ts`.

## Done when

Unit tests for the select event, refusals in select mode, choices as lines and as text, the choice answer, and shell faces (no doubled faces, merged rectangles) pass; `18`'s pieces 1 (MCP), 7, 8 (MCP) and 10 rows marked built.
