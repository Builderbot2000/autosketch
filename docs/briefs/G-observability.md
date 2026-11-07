# Silo G: Observability

**Wave 1** for phases 1 and 2 of `12`. **Wave 3** for phases 3–5, after silo F merges, so scope events, locks and drill-in have something real to show.

**Specs:** `12` (all), `11` (what the scope events describe), `10` (eval metrics).

## Goal

Show the human what agents are doing during a build, without ever feeding any of it back to an agent and without slowing a tool call.

## Deliverables (the phases in `12`)

1. **Event bus and log.** An `EventSink` interface in `src/core/` with a no-op default. Hooks in document commit, undo, redo and checkpoint, and in the `tool()` wrapper for `call.start`, `call.end` and `call.refused`. A buffered writer for `<workspace>/<doc>/observe/<session-id>/events.ndjson` with the envelope in `12`. Settings `observe.log` and `observe.retainSessions`. Settings don't exist yet: add a small settings module read from env and server args, and keep it general so other silos can add keys.
2. **Time-lapse snapshots** on merge or checkpoint, rendered with the existing rasterizer on a background queue, never inside the tool call.
3. *(wave 3)* **HTTP viewer** on loopback only, off by default: the SSE `/events` endpoint, document snapshot and region endpoints, atlas and model endpoints, `resync`. A static bundle in `viewer/` (plain ESM, vendored three.js, no build step) with the first three panels: 3D view with lock overlays, scope tree, event feed.
4. *(wave 3)* **`deltas.bin`** with the shared `state.add` table, the size cap, then the timeline, activity map and drill-in panels.
5. *(wave 3)* **Replay** and `autosketch observe <path>`, then the eval-runner join with silo I.

## Hard constraints

- No MCP tool reads the log or the viewer, and no tool result changes because observability is on.
- `document/` and `server/` import only the `EventSink` interface from `core/`, never `observe/`.
- A slow or absent consumer never blocks an op. Measure op latency with and without the log in a test.

## Files you own

- New: `src/core/events.ts`, `src/observe/**`, `viewer/**`, a settings module, matching tests.
- Additive hooks: `src/document/document.ts`, the `tool()` wrapper in `src/server/server.ts`.

## Done when

- Phase 1: a test session produces an `events.ndjson` whose `seq` order and payloads match the kinds table in `12` for ops, undo and checkpoint.
- Phases 3–5: the viewer replays a finished log, including a fork and merge from silo F.
- `12` gains an *Implementation status* table.
