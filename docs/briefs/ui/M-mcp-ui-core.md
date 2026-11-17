# Silo M: MCP UI core

**Wave 1**, as soon as C's schemas, vectors and TypeScript codec merge. Land the move of the two viewer files (deliverable 1) first, in its own merge: X starts from it.

**Specs:** `16` (*What goes, what stays, what moves*, *MCP side*, *Testing: MCP*), `12` (event bus, log, deltas, snapshots, replay data), `13` (*Allowed players*, B3 token totals), `15` (settings rows, compare-and-set, library actions), `11` (scope documents and job volumes).

## Goal

`src/ui/` computes everything the game draws and answers everything it asks, from the existing event bus, logs and core code, off the tool-call path.

## Deliverables, in merge order

1. **Move** `viewer/js/model.js` to `src/observe/session-model.ts` and `viewer/js/replay.js` to `src/observe/replay.ts`, typed, with their tests moved to `test/unit/observe/` and still passing. Leave the viewer importing nothing new (X deletes it); if the viewer breaks because of the move, that's fine once X's merge is queued, but say so.
2. **Feed** (`src/ui/feed.ts`): subscribes to the event bus, keeps the session model, and produces `ui.state` (full on connect and resync, changes after, coalesced at C's interval) and `ui.flash`. Job colours stable per job id. Built off the tool-call path; a slow or dropped connection never delays an op (measure: a tool call's latency with the feed on and a stalled socket equals the latency with it off).
3. **Ghost regions** (`src/ui/ghosts.ts`): for each open sandbox, its blocks in base-document world coordinates from the scope document, updated from `doc.op` deltas in C's update form; for an unlinked document, its blocks at the anchor a `ui.request` set. `ui.ghost.clear` on merge or abandon.
4. **Replay frames** (`src/ui/replay-frames.ts`): from any session log in the workspace, the planner plus a frame builder: keyframe of the replayed volume at step S, forward deltas, job volumes and HUD text at S, markers. Steps without deltas report the nearest time-lapse snapshot as HUD text (`16`, *Gaps*).
5. **Request handlers** (`src/ui/requests.ts`): every `ui.request` kind in C's table, calling the code the HTTP endpoints called (`core/settings.ts`, `library/manage.ts`, `library/roots.ts` unchanged). Refuse players not on `world.promptPlayers` with `not_allowed`. Rewrite `src/observe/settings-api.ts`, `library-api.ts` and `src/server/library-host.ts` as these handlers; delete what's left of them.
6. **Wiring** in `src/server/index.ts` / the bridge: start the feed when the mod's hello lists `ui`; route `ui.request` to the handlers.
7. **Reduce** `src/observe/http.ts` to the OTLP receiver `/v1/logs` and `src/observe/guard.ts` to refusing foreign `Origin` and `Host` on it. `observe.http` keeps its meaning.

## Files you own

- New `src/ui/**`, `test/unit/ui/**`; `src/observe/session-model.ts`, `src/observe/replay.ts` and their tests; `src/observe/http.ts`, `guard.ts`, `settings-api.ts`, `library-api.ts`, `src/server/library-host.ts` (rewritten or reduced); the wiring lines in `src/server/index.ts`.

## Notes

- Don't change a message schema. If one is wrong, raise it with C (or the user once C is done) and fix it in C's files with new vectors.
- Coordinates: everything sent is in world coordinates with the dimension. Convert from document-local exactly once, in one function.

## Done when

- Unit tests (`16`, *Testing: MCP*): feed coalescing, resync, stable job colours; ghost regions from scope documents and after deltas; replay frames where keyframe plus deltas equal the replayed grid at every step of a recorded log; every request kind, including `conflict` on a stale settings hash and `not_allowed`.
- Against the fake host with `ui`: a fork produces a `ui.state` with the job, its edits produce `ui.flash` and `ui.ghost` updates, a merge clears the ghost; `playerUiRequest` for each kind returns the expected `ui.result`.
- `http.ts` serves only `/v1/logs`, and `test/unit/observe/http.test.ts` is reduced to match.
