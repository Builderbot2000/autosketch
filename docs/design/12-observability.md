# 12 — Observability

Shows the user what the agents are doing while they work: which jobs are open, where their locks are, what each one is building, and what got refused. It is built for large delegated builds (`11`), but it works the same for a single agent.

## Principles

1. **For the human, never the model.** Scoped sessions keep block detail out of model attention, and nothing here undoes that. No tool reads the event log or the in-game UI (`16`), and nothing shown there is returned to an agent. Agents keep using `scope_list`, reports and renders.
2. **Read-only.** Observability subscribes to the document and server layers. It never mutates a document, takes a lock or changes a tool result. (The management UI's Settings, Library and Instance tabs, served from the same page, do write, through their own guarded endpoints: `15`.)
3. **Never slows the build.** Ops emit an event and return. Writing the log and sending to the in-game UI (`16`) happen off the tool-call path. When a consumer falls behind, it gets dropped and resyncs from a snapshot. Ops never wait for it.
4. **One frame.** Every box and position in an event is given in the base document's coordinates, so one view can place every job. Local sandbox coordinates are included as well, for drill-in.
5. **One source of truth.** The in-game UI (`16`), replay, time-lapse and eval metrics all read the same event stream.

## Event stream

The server publishes typed events on an in-process bus. A buffered writer appends them to a per-session log:

```
<workspace>/<doc>/observe/<session-id>/
  events.ndjson    one JSON event per line
  deltas.bin       block changes referenced by events (append-only)
  snapshots/       time-lapse PNGs (optional, see below)
```

### Envelope

```json
{ "v": 1, "seq": 1042, "t": 1762531200123, "doc": "s3", "kind": "doc.op", ... }
```

- `seq` is unique within the session and increases across all documents, so the merged order of events from the base and every sandbox is fixed.
- `doc` is `"base"` or a scope id.

### Kinds

| Kind | Payload | Emitted by |
|---|---|---|
| `session.open` / `session.close` | doc name, bounds, server version; `session.open` adds a keyframe `delta` when deltas are on | session |
| `state.add` | `{ id, state }`: adds an entry to the log-wide block-state table that `deltas.bin` uses | delta writer |
| `doc.op` | journal `seq`, `op`, `summary`, changed box (base frame), counts by family, `delta: { offset, length }` | document commit |
| `doc.undo` / `doc.redo` | journal `seq` and changed box, plus a `delta` reference | document |
| `doc.checkpoint` | name | document |
| `scope.fork` | scope, parent, depth, work box and context box (base and local frames), translation, brief, whole-block extensions, stale-context overlaps | `scope_fork` |
| `scope.merge` | scope, report, diff stats, changed box (base frame), the parent's journal `seq` for the merge | `scope_merge` |
| `scope.abandon` | scope, reason (`call`, `restart`) | `scope_abandon`, shutdown |
| `call.start` / `call.end` | tool, scope, duration, ok, response size (text characters, image count and pixels); `call.start` also carries `input`, the call's top-level scalar arguments (strings cut to 80 characters, at most 16), for matching Claude Code's telemetry (`13`, *Backlog* B3) | server adapter |
| `call.refused` | tool, scope, refusal code (`lock_overlap`, `nest_too_large`, `nest_too_small`, `nest_depth`, `outside_work_volume`, `scope_required`, `sync_barrier`, `request_mode` (13, B6: an edit or volume change the open in-game request's mode doesn't allow), `probe_read_only` (13, B4: an edit on the scan probe), `world_disconnected`, `world_no_volume`, `world_no_document` (13, B4: `world_volumes` with neither the probe nor a linked document open), `world_mod_outdated` (13), `unknown_argument` (05, *Unknown arguments*), `world_view_read_only` (18, piece 5), `outside_brush` (19: undo or redo of an entry that wrote outside the current brush), …), message | server adapter |
| `render.produced` | view, size, scope, optional thumbnail path | perception |
| `world.link` | state (`linked`, `relinked`, `unlinked`, `connected`, `disconnected`), dimension, work box (local), blocks added by whole-block extension, context box count, reason | world link (13) |
| `world.patch` | patch id, journal `seq`s, blocks sent, forced, ack counts (applied, skipped, rejected, overwritten, normalized), or `dropped` with a reason when it wasn't sent or confirmed | world link (13) |
| `world.sync` | reason (`ack`, `context`, `dirty`, `reconnect`, `manual`), blocks changed, journal `seq` | world link (13) |
| `otel` | `record`: one Claude Code OpenTelemetry log record, exactly as received at `/v1/logs` | OTLP receiver (`13`, *Backlog* B3) |
| `turn.end` | `at` (epoch ms it arrived), `reason` (`stop` from `Stop`, `error` from `StopFailure`), `session` (Claude Code's session id, when the hook gave one) | turn-end route (`19`, *When a request has concluded*) |

Locks are not separate events. A fork takes its lock and a merge or abandon releases it, so the lock set at any `seq` can be derived from the log.

### Block deltas

`deltas.bin` holds the after-state of each changed position as `(x, y, z, stateId)` records in the base frame. A `stateId` indexes the `state.add` table, which is shared by every document in the session, because document palette ids are local and change when a palette is compacted. Block-entity NBT is not logged. The viewer only needs the block state.

- **Sandbox ops** are logged in the sandbox's own frame and tagged with the sandbox's `doc`, so a drill-in view can replay them. Doc 11 discards a sandbox's journal at merge, and that still holds for everything the model can reach. The log keeps a separate copy for the human only.
- **Keyframes.** `session.open` carries a delta with every block of the document as it opened (an empty range for an empty document), so a session that opened or imported existing content can be rebuilt from `deltas.bin` alone: clear at each `session.open`, then apply every range in `seq` order.
- **Merges** log a single delta for the whole patch in the base frame, so a viewer that follows only the base document stays correct.
- **Size:** deltas are off by default for sessions with no live view attached and no replay requested. A per-session cap (`observe.maxDeltaBytes`, default 512 MB) applies. Past the cap the log records `doc.op` events without deltas, and replay falls back to the time-lapse snapshots.

## Live viewer (removed; see `16`)

The browser viewer this section described (a dashboard on `127.0.0.1`, its 3D view, panels, `autosketch observe <path>` for finished logs, `observe.open`) was removed by `16` (2026-11-17), with `15`'s management UI that grew out of it. What it showed now appears in the game: job volumes, flashed changes and the HUD (`16`, *Overlays in the world*, *HUD*), sandboxes before merge as ghost blocks (*Ghost blocks*), and replay of a live or finished log in the world (*Replay in the world*). The scope tree, feed and token totals are computed by the session model (`src/observe/session-model.ts`) and replay planning by `src/observe/replay.ts`, both moved from the viewer's JavaScript with their tests.

What stays from this section: the event stream, `deltas.bin` and its keyframes, the time-lapse snapshots and the replay data, which the in-game UI reads the same way the viewer did, and one HTTP endpoint, the OTLP receiver at `POST /v1/logs` for Claude Code's telemetry (`13`, B3), on `127.0.0.1:<observe.http>` (default 47100; when it is taken, a free port, but only for the default). `16` (*What goes, what stays, what moves*) reduces `src/observe/http.ts` to that receiver.

## Time-lapse snapshots

`observe.snapshots: "merge" | "checkpoint" | "off"` (default `"off"`) renders the base document after each merge or checkpoint with the existing rasterizer (`flat`, `iso_ne`, 512²) into `snapshots/<seq>.png`. Renders are debounced and run on a background queue, never inside the tool call. This works headless, needs no viewer, and gives replay something to fall back on when deltas were capped.

## Metrics and evals

The log has all the data Tier 3 needs for scoped sessions (`10`):

- per job: ops, wall time, depth, response size, refusals, and whether the job was later abandoned
- per session: number of forks, maximum depth, parallelism over time, total time spent waiting on locks, repeated briefs

The server never sees model tokens. It records response sizes, and the eval runner joins the log with the Agent SDK transcript on tool-call order to get token counts. That joined table is the calibration data for the delegation threshold, an open question in `11`.

## Layering

- `src/observe/` holds the bus, the log writer, the delta encoder, the HTTP server and snapshot scheduling.
- `document/` and `server/` publish through a narrow `EventSink` interface from `core/`. With observability disabled they get a no-op sink, so they never import `observe/`.
- `observe/` may read `document/` (snapshots, region reads) and `assets/` (atlas, baked models). Like `perception/`, it never mutates.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `observe.log` | `true` | Write `events.ndjson`. Small: no block data. |
| `observe.deltas` | `"auto"` | `"auto"` (on with `observe.http`), `"on"` or `"off"` |
| `observe.maxDeltaBytes` | 512 MB | Per-session cap on `deltas.bin` |
| `observe.http` | `47100` (a free port when taken) | Port of the OTLP receiver (`/v1/logs`): a number, `true` for a free port, or `false` for none |
| `observe.snapshots` | `"off"` | `"merge"`, `"checkpoint"` or `"off"` |
| `observe.retainSessions` | 20 | Older session folders are pruned at startup |
| `scope.maxWorkRatio` | 0.5 | Largest child work volume as a share of the parent's (`11`) |
| `scope.minWorkBlocks` | 512 | Smallest work volume a fork may take (`11`) |
| `scope.maxDepth` | 3 | Deepest fork below the base build (`11`) |

Settings are one server-wide system (`src/core/settings.ts`), not specific to observability. Every setting is read, highest priority first, from the user's `~/.autosketch/config.toml` `[settings]` table (written by `autosketch config` and the in-game settings screen, `16`, *Settings screen*), then `--set <key>=<value>`, then a flag alias if the setting declares one, then `AUTOSKETCH_<KEY>` (key upper-cased, `.` and camel-case humps become `_`), then its default. Each area declares its keys next to the code that uses them. A flag alias exists only to keep a flag that predates the module working; new settings don't add one. The settings outside this doc:

| Setting | Aliases | Declared in | Doc |
|---|---|---|---|
| `modOrder` | `--mod-order a,b`, `AUTOSKETCH_MOD_ORDER` | `assets/settings.ts` | `02`, Layered pack VFS |
| `tintBiome` | `--tint-biome <biome>`, `AUTOSKETCH_TINT_BIOME` | `assets/settings.ts` | `02`, Model resolution |

The instance location flags (`--instance`, `--version`, `--base-jar`, `--workspace`) are startup arguments read by `server/context.ts`, not settings.

## Phases

1. The event bus, `events.ndjson`, and `EventSink` hooks in document commits, scope tools and the server adapter.
2. Time-lapse snapshots.
3. The HTTP server with SSE and snapshots, plus the first three panels: 3D view with lock overlays, scope tree, event feed (the browser parts removed by `16`).
4. `deltas.bin`, then the timeline, the activity map and drill-in.
5. Replay and `autosketch observe <path>` (removed by `16`: replay plays in the world), then the eval-runner join.

## Implementation status

Phases 1–5 are built; the browser viewer and `autosketch observe` were removed by `16` (2026-11-17), and their rows below say so. Scoped sessions (`11`) emit `scope.fork`, `scope.merge` and `scope.abandon`, and `server/index.ts` passes `getScopeDoc`, so the scope panels, sandbox deltas and drill-in show real jobs.

| Piece | Status |
|-------|--------|
| `EventSink` | `src/core/events.ts`: the interface, `NO_EVENTS` (the default on every `Document` and `Session`), the typed `ObserveEvent` union for every kind in the table (scope kinds emitted by `src/scope/`) and `refusalCode()`. `document/` and `server/` import only this. |
| Bus | `src/observe/bus.ts`. Stamps the envelope and calls subscribers synchronously; a throwing subscriber is isolated. Adds the server version to `session.open`. |
| Hooks | `Document`: `doc.op` after each commit, `doc.undo`/`doc.redo` per step (so `restore` logs each step), `doc.checkpoint`. Payloads are built in `src/document/events.ts`, only when the sink is enabled. `Session`: `session.open` on create/open/adopt, `session.close` on close. Tool wrapper (`src/server/observe-call.ts`): `call.start`, `call.end` (ms, ok, text characters, image count, pixels read from the PNG header) and `call.refused`. `call.start`/`call.end` share a `call` number. `render.produced` is emitted for snapshots (`source: "snapshot"`) and by the perception tools (`render`, `diff` renders, op previews; `source: "tool"`). |
| `events.ndjson` | `src/observe/log.ts`. Buffered, flushed every 200 ms off the call path. Past an 8 MB unwritten backlog, events are dropped and the next line is an `observe.dropped` marker with the count. |
| Settings | `src/core/settings.ts` (general: `--set key=value`, then an optional flag alias, then `AUTOSKETCH_<KEY>`, then the default). `modOrder` and `tintBiome` (`src/assets/settings.ts`) moved onto it, keeping their old flags and variables as aliases. Observe keys in `src/observe/settings.ts`: `observe.log`, `observe.snapshots`, `observe.retainSessions`. The others in the table come with phases 3–4. |
| Time-lapse | `src/observe/snapshots.ts`. `flat`, `iso_ne`, 512² into `snapshots/<seq>.png`, plus a `render.produced` event with `source: "snapshot"`. |
| Wiring | `src/server/index.ts` (the process entry point) calls `startObserve()` and gives the session `observer.sink("base")`. Shutdown closes the session, waits up to 3 s for a pending snapshot, then flushes the log. |
| `deltas.bin`, `state.add` | `src/observe/deltas.ts`, `src/observe/states.ts`. A bus *annotator* (`EventBus.annotate`, runs before the event gets its `seq`) finds the journal entry named by `doc.op`/`doc.undo`/`doc.redo`, maps its palette ids to the log-wide table (publishing `state.add` first, so it precedes the op in `seq` order; id 0 is air), reserves `16 × changed` bytes and adds `delta: { offset, length }`. Encoding and positional writes run on a 50 ms timer from the entry's own arrays. Records: int32 x, y, z in the emitting document's local frame after the step, uint32 state id, little-endian; an op logs the after-state, an undo the before-state. One table and one `deltas.bin` per log folder. Sandbox ops are tagged with the scope's `doc` and use its frame (`getScopeDoc` is wired in `server/index.ts`). `observe.deltas` (`auto` = on with `observe.http`) and `observe.maxDeltaBytes` (default 512 MB, accepts `512M`); past the cap, later ops carry no `delta`. `session.open` gets a keyframe (see *Block deltas*), copied on the call path in one pass over the blocks (the same order of work as loading the document) and encoded with the others. `doc.undo`/`doc.redo` carry `shift` like `doc.op` (origin now minus origin before the step), so a reader can keep the frame across them. |
| HTTP server | `src/observe/http.ts`, reduced by `16` to the OTLP receiver: `POST /v1/logs` (13, B3), plus `19`'s turn-end route `POST /v1/hooks/turn-end` (bearer token from the port file, `src/observe/turn-hook.ts`; a wrong token is 403 and no event). `observe.http` = port (default `DEFAULT_HTTP_PORT` 47100, with `fallbackToFreePort` only while it is the default), or `true`/`0` for a free port, `false` for none. Binds `127.0.0.1` only and refuses other `Host` headers (DNS rebinding) and a foreign `Origin` (`guard.ts`). The browser viewer's routes (`/events`, `/doc/…`, `/assets/…`, `/log/…`, `/info`, `/vendor/three/…`) and their helpers (`voxels.ts`, `atlas.ts`) are gone; the game shows the session instead (`16`). |
| Viewer | **Removed** by `16` (2026-11-17): `viewer/` (page, 3D view with three.js, panels, tabs, CSS, `voxels.js`) and the `three` dependency are gone. Its session model and replay planner moved to `src/observe/session-model.ts` and `src/observe/replay.ts` with their tests. |
| Wiring | `startObserve` takes `getScopeDoc` (wired to the session's open scopes in `server/index.ts`) and exposes `ready` (the HTTP server's URL) and `close()` stops it and flushes deltas. Nothing opens a browser any more (`observe.open` and `src/observe/open.ts`'s use at startup removed by `16`). |
| Replay | The planner is `src/observe/replay.ts` (moved from `viewer/js/replay.js` by `16`, tested in Node): the base grid at seq S is cleared at the last `session.open` at or before S, then the base `doc.op`/`doc.undo`/`doc.redo` ranges after it are applied in order, moving existing blocks by `-shift` first. A base step that changed blocks with no delta (deltas off or capped; for `session.open`, no keyframe) is a gap, filled from the newest snapshot whose file seq is at most S. The browser scrubber is removed; replay plays in the world (`16`, *Replay in the world*). |
| `autosketch observe <path>` | **Removed** by `16` (2026-11-17), with `src/observe/offline.ts`: finished logs are replayed in the game through the running MCP. |
| Log reader, eval join | `src/observe/reader.ts`: `parseEventLog`, `readSessionLog`, `resolveSessionDir`, and `readWorkspaceEvents` (moved from `test/eval/join.ts`). The eval harness (`10`, tier 3) imports it; the join itself (`joinCalls`, `jobTable`) stays in `test/eval/join.ts`, since only the harness has transcripts. |
| Tests | `test/unit/observe/`: replay of a finished session rebuilt exactly at the end and at an earlier seq (backwards and forwards, through an undo), `shift` handling, the snapshot fallback plan, the reader; kinds-table payloads and `seq` order for ops, checkpoint, undo and redo; tool results identical with the log on and off, and with the viewer and deltas on; refusals; a stalled disk never blocking `emit`; op latency with and without the log, and with deltas; snapshots; delta records for ops, undo, redo and sandbox ops, the cap; every HTTP endpoint on an ephemeral port, SSE `since` and `resync`, the host check; the session model on synthetic fork/merge/abandon/refusal events (`session-model.test.ts`). The offline, vendor-route, subcommand and meshing tests went with the code `16` removed. `test/unit/core/settings.test.ts`. |
| Not built | Showing the saved document when a log has neither deltas nor snapshots (the document may have changed since). Scope events are emitted by scoped sessions (`11`), not here. |

Decisions made while building phases 1–2:

- **`jseq`, not `seq`.** The payload's journal sequence number is called `jseq`, because `seq` is the envelope's session-wide counter.
- **Counts by block, not family.** `doc.op` carries `counts: { placed: { "<block id>": n }, removed: n }`. `document/` can't see families (`palette/`). A viewer that wants families can map block ids itself.
- **Boxes** are public inclusive boxes in the document's local frame after the op (the same frame as the op's result). `doc.op` adds `shift` when the op moved the origin.
- **Refusals** are errors that carry a `refusal: "<code>"` property. The tool wrapper notes the error behind each error result, logs `call.refused` with that code and returns the result unchanged. Scoped sessions (`11`) should throw refusals this way.
- **Which folder.** A server session can open several documents. Each document's events go to `<workspace>/<doc>/observe/<session-id>/`. Events from before any document is open (the `call.start` of the `doc_new` that opens one) are held (at most 256) and written to the next document's log. `seq` stays unique and increasing across all of them, so one document's log can have gaps.
- **Pruning** runs when the session first writes to a document's `observe/` folder, not at process start: the server doesn't know which documents it will touch until then.
- **Snapshot modes.** `"checkpoint"` renders after checkpoints on the base document; `"merge"` renders after `scope.merge`, after each scoped job merges. Renders are debounced (500 ms), wait until no tool call is in flight, and are serialised. A burst of triggers produces one snapshot of the latest state, named by the bus `seq` when its render starts.
- **Main-thread rendering.** Snapshot renders run on the main thread, after tool calls finish. A tool call that arrives mid-render waits for the rasterizer's synchronous part. A worker thread would remove that, but it needs its own copy of the document and the pack stack. Not worth it until a large build shows the delay.
- **Reading `perception/`.** Snapshots call `perception/render`, as this doc specifies. `ARCHITECTURE.md` lists only `document/` and `assets/` for `observe/`, so that rule should add `perception/` (read-only).

Decisions made while building phases 3–4:

- **Sandbox frame.** The viewer reads a fork's `translation` as *base = local + translation*, relative to the base document even for nested forks (principle 4), falling back to the work box's minimum corner. Scoped sessions emit it that way (`src/scope/scopes.ts`).
- **Merges** need no special delta: a merge is a base-document op, so its `doc.op` carries the whole patch in the base frame.
- **Voxel endpoints use the log's state ids,** the same as `deltas.bin` and `models.json`, so one table serves everything. Serving a snapshot can publish `state.add` for states not yet seen.
- **Snapshots are encoded synchronously** on request (16 bytes per non-air block). Fine for the build sizes seen so far.
- **`delta` is added by an annotator,** not by `document/`, so the document hook stays unchanged and pays nothing when deltas are off.

Decisions made while building phase 5:

- **Keyframe on `session.open`.** Without it, replay from `deltas.bin` is only right for sessions that start from an empty document. The copy runs on the call path of `doc_open`/`doc_import`, which already read every block. An empty range marks "logged, nothing to load", so a missing `delta` on `session.open` means deltas were off.
- **One reader, two users.** `readWorkspaceEvents` moved to `src/observe/reader.ts` and the harness imports it; joining with transcripts stays in the harness.
- **No snapshot list endpoint.** The viewer finds snapshots from `render.produced` events (`source: "snapshot"`), whose `path` names the file; the file's seq is when the render started.
- **Finished logs always replay.** There is no document to read, so the live path (snapshot plus re-read boxes) is skipped and the scrubber follows the end instead.

## Open questions

- **Many concurrent jobs.** If a session ever has dozens of open scopes, the in-game overlays need grouping (by parent, by brief). Doc 11 expects few concurrent jobs, so this waits until a log shows otherwise.
- **Claude Code panel.** Answered by `15`, then by `16`: there is no browser UI; the game is the one surface.
- **In-game preview.** Superseded by the live world link (`13`): agent edits are written into the loaded world as conditional patches that never overwrite a hand edit without an explicit request, which is the non-destructive condition this question set. A ghost preview (showing a merge before it lands) remains a possible addition to the companion mod.
