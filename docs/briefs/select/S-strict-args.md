# Silo S: Strict tool arguments

**Wave 3**, after T, P and V have merged (it touches every tool module they edit). Scheduled with the user 2026-11-23, from V1's report.

**Specs:** `05` (result contract, refusals); `18` piece 5 (edits refused in the world view); `docs/ARCHITECTURE.md` (`server/` stays a thin adapter).

## Why

The MCP SDK strips unknown arguments before a tool sees them. So `fill({view: "world", …})`, an edit the agent meant for the world view, silently edits the open document instead of being refused. In build mode that changes the player's build. The same applies to any misspelled optional argument on any tool: it is dropped without a word.

## Deliverables

1. Unknown arguments are refused with a clear refusal naming the argument and the tool's accepted ones, at least on every mutating tool. Prefer one change in the `tool()` wrapper (`src/server/server.ts`) or the shared schema helpers over per-tool edits. Decide whether read-only tools get the same rule and record why.
2. `view: "world"` on a mutating tool is refused with `world_view_read_only`, the same code the view's write guard uses.
3. No tool's existing name or argument shape changes (main README, *Decisions you should not make alone*). If a tool turns out to rely on stripped extras (an argument passed by a client or script but never declared), list it as a question for the lead rather than adding or removing arguments.
4. Unit tests: an unknown argument refused on a mutating tool; `fill({view:"world"})` refused and the document unchanged; every existing test still passes.

## Files you own

`src/server/server.ts` (the wrapper), `src/server/tools/shared.ts` (schema helpers), and the minimal per-tool changes the wrapper can't cover.

## Done when

All tiers pass, and `05` states that unknown arguments are refused.
