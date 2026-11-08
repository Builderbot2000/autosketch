# 12 — Observability

Shows the user what the agents are doing while they work: which jobs are open, where their locks are, what each one is building, and what got refused. It is built for large delegated builds (`11`), but it works the same for a single agent.

## Principles

1. **For the human, never the model.** Scoped sessions keep block detail out of model attention, and nothing here undoes that. No tool reads the event log or the viewer, and nothing shown in the viewer is returned to an agent. Agents keep using `scope_list`, reports and renders.
2. **Read-only.** Observability subscribes to the document and server layers. It never mutates a document, takes a lock or changes a tool result.
3. **Never slows the build.** Ops emit an event and return. Writing, serving and rendering for the viewer happen off the tool-call path. When a consumer falls behind, it gets dropped and resyncs from a snapshot. Ops never wait for it.
4. **One frame.** Every box and position in an event is given in the base document's coordinates, so one view can place every job. Local sandbox coordinates are included as well, for drill-in.
5. **One source of truth.** The live viewer, replay, time-lapse and eval metrics all read the same event stream.

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
| `session.open` / `session.close` | doc name, bounds, server version | session |
| `state.add` | `{ id, state }`: adds an entry to the log-wide block-state table that `deltas.bin` uses | delta writer |
| `doc.op` | journal `seq`, `op`, `summary`, changed box (base frame), counts by family, `delta: { offset, length }` | document commit |
| `doc.undo` / `doc.redo` | journal `seq` and changed box, plus a `delta` reference | document |
| `doc.checkpoint` | name | document |
| `scope.fork` | scope, parent, depth, work box and context box (base and local frames), translation, brief, whole-block extensions, stale-context overlaps | `scope_fork` |
| `scope.merge` | scope, report, diff stats, changed box (base frame), the parent's journal `seq` for the merge | `scope_merge` |
| `scope.abandon` | scope, reason (`call`, `restart`) | `scope_abandon`, shutdown |
| `call.start` / `call.end` | tool, scope, duration, ok, response size (text characters, image count and pixels) | server adapter |
| `call.refused` | tool, scope, refusal code (`lock_overlap`, `nest_too_large`, `nest_too_small`, `nest_depth`, `outside_work_volume`, `scope_required`, …), message | server adapter |
| `render.produced` | view, size, scope, optional thumbnail path | perception |

Locks are not separate events. A fork takes its lock and a merge or abandon releases it, so the lock set at any `seq` can be derived from the log.

### Block deltas

`deltas.bin` holds the after-state of each changed position as `(x, y, z, stateId)` records in the base frame. A `stateId` indexes the `state.add` table, which is shared by every document in the session, because document palette ids are local and change when a palette is compacted. Block-entity NBT is not logged. The viewer only needs the block state.

- **Sandbox ops** are logged in the sandbox's own frame and tagged with the sandbox's `doc`, so a drill-in view can replay them. Doc 11 discards a sandbox's journal at merge, and that still holds for everything the model can reach. The log keeps a separate copy for the human only.
- **Merges** log a single delta for the whole patch in the base frame, so a viewer that follows only the base document stays correct.
- **Size:** deltas are off by default for sessions with no viewer attached and no replay requested. A per-session cap (`observe.maxDeltaBytes`, default 512 MB) applies. Past the cap the log records `doc.op` events without deltas, and replay falls back to the time-lapse snapshots.

## Live viewer

When `observe.http` is set, the MCP process also serves a dashboard on `127.0.0.1:<port>` (stdio stays reserved for MCP). It binds to loopback only and is off by default. On start, the server prints the URL to stderr and writes it to `observe/<session-id>/url`.

### Endpoints

```
GET /events?since=<seq>        SSE stream of events (replays from seq, then goes live)
GET /doc/<doc>/snapshot        current voxels of a document (base or scope), chunked binary
GET /doc/<doc>/region?box=…    voxels of one box, for drill-in and resync
GET /assets/atlas.png          texture atlas from the user's instance (02)
GET /assets/models.json        baked block models keyed by stateId
GET /log/deltas?offset&length  raw delta records, for replay
```

When a client misses events (buffer overflow, or the tab was in the background), the server sends `resync`. The client then fetches the snapshot and continues from the latest `seq`.

### Panels

Listed in build order:

1. **3D view of the base document.** WebGL (three.js) using the same baked models and atlas the rasterizer uses. Overlays:
   - each open job's work volume as a box, coloured per job and labelled with its brief
   - context volumes as wireframes
   - recently changed blocks, briefly highlighted when an op or merge lands
2. **Scope tree.** The base document, then forks, then nested forks, with status (open, merged, abandoned, lost at restart), age, brief, op count and last tool call. This is a live, human-readable `scope_list()`.
3. **Event feed.** Filterable by document, kind and tool. Refusals are highlighted: they are the clearest signal of agent behaviour (lock contention, over-nesting, writes outside the volume).
4. **Top-down activity map.** A heatmap of edit density with lock rectangles. Unlike the 3D view, it stays readable on very large builds.
5. **Job timeline.** One bar per job from fork to merge, nested under its parent. It marks lock waits (a refused fork followed by a successful one) and refusals. This is where over-eager forking shows: many short jobs, or the same brief forked several times.
6. **Sandbox drill-in.** Opens one job in its local frame, with the context volume ghosted (the same convention as `render({ context: "ghost" })`, `06`) and the job's own ops streaming in.
7. **Replay.** A scrubber over `seq` that rebuilds the views from `deltas.bin`. It works on a live session or on a finished log opened with `autosketch observe <path>`.

### Packaging

The viewer is a static bundle in `viewer/` (plain ESM, three.js vendored, no build step), served by the same process. The core server keeps its no-browser, no-GPU stack. Only a human opening the page uses WebGL.

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
| `observe.deltas` | `"auto"` | `"auto"` (on when the viewer is enabled), `"on"` or `"off"` |
| `observe.maxDeltaBytes` | 512 MB | Per-session cap on `deltas.bin` |
| `observe.http` | off | Port number, or `true` for a free port |
| `observe.snapshots` | `"off"` | `"merge"`, `"checkpoint"` or `"off"` |
| `observe.retainSessions` | 20 | Older session folders are pruned at startup |

Settings are one server-wide system (`src/core/settings.ts`), not specific to observability. Every setting is read, highest priority first, from `--set <key>=<value>`, then a flag alias if the setting declares one, then `AUTOSKETCH_<KEY>` (key upper-cased, `.` and camel-case humps become `_`), then its default. Each area declares its keys next to the code that uses them. A flag alias exists only to keep a flag that predates the module working; new settings don't add one. The settings outside this doc:

| Setting | Aliases | Declared in | Doc |
|---|---|---|---|
| `modOrder` | `--mod-order a,b`, `AUTOSKETCH_MOD_ORDER` | `assets/settings.ts` | `02`, Layered pack VFS |
| `tintBiome` | `--tint-biome <biome>`, `AUTOSKETCH_TINT_BIOME` | `assets/settings.ts` | `02`, Model resolution |

The instance location flags (`--instance`, `--version`, `--base-jar`, `--workspace`) are startup arguments read by `server/context.ts`, not settings.

## Phases

1. The event bus, `events.ndjson`, and `EventSink` hooks in document commits, scope tools and the server adapter.
2. Time-lapse snapshots.
3. The HTTP server with SSE and snapshots, plus the first three panels: 3D view with lock overlays, scope tree, event feed.
4. `deltas.bin`, then the timeline, the activity map and drill-in.
5. Replay and `autosketch observe <path>`, then the eval-runner join.

## Implementation status

Phases 1 and 2 are built. Phases 3–5 wait on scoped sessions (`11`).

| Piece | Status |
|-------|--------|
| `EventSink` | `src/core/events.ts`: the interface, `NO_EVENTS` (the default on every `Document` and `Session`), the typed `ObserveEvent` union for every kind in the table (scope kinds defined, not yet emitted) and `refusalCode()`. `document/` and `server/` import only this. |
| Bus | `src/observe/bus.ts`. Stamps the envelope and calls subscribers synchronously; a throwing subscriber is isolated. Adds the server version to `session.open`. |
| Hooks | `Document`: `doc.op` after each commit, `doc.undo`/`doc.redo` per step (so `restore` logs each step), `doc.checkpoint`. Payloads are built in `src/document/events.ts`, only when the sink is enabled. `Session`: `session.open` on create/open/adopt, `session.close` on close. Tool wrapper (`src/server/observe-call.ts`): `call.start`, `call.end` (ms, ok, text characters, image count, pixels read from the PNG header) and `call.refused`. `call.start`/`call.end` share a `call` number. `render.produced` is emitted for snapshots (`source: "snapshot"`) and by the perception tools (`render`, `diff` renders, op previews; `source: "tool"`). |
| `events.ndjson` | `src/observe/log.ts`. Buffered, flushed every 200 ms off the call path. Past an 8 MB unwritten backlog, events are dropped and the next line is an `observe.dropped` marker with the count. |
| Settings | `src/core/settings.ts` (general: `--set key=value`, then an optional flag alias, then `AUTOSKETCH_<KEY>`, then the default). `modOrder` and `tintBiome` (`src/assets/settings.ts`) moved onto it, keeping their old flags and variables as aliases. Observe keys in `src/observe/settings.ts`: `observe.log`, `observe.snapshots`, `observe.retainSessions`. The others in the table come with phases 3–4. |
| Time-lapse | `src/observe/snapshots.ts`. `flat`, `iso_ne`, 512² into `snapshots/<seq>.png`, plus a `render.produced` event with `source: "snapshot"`. |
| Wiring | `src/server/index.ts` (the process entry point) calls `startObserve()` and gives the session `observer.sink("base")`. Shutdown closes the session, waits up to 3 s for a pending snapshot, then flushes the log. |
| Tests | `test/unit/observe/`: kinds-table payloads and `seq` order for ops, checkpoint, undo and redo; tool results identical with the log on and off; refusals; a stalled disk never blocking `emit`; op latency with and without the log; snapshots. `test/unit/core/settings.test.ts`. |
| Not built | HTTP viewer, `deltas.bin` and `state.add`, replay, `autosketch observe`, scope events (phases 3–5). |

Decisions made while building phases 1–2:

- **`jseq`, not `seq`.** The payload's journal sequence number is called `jseq`, because `seq` is the envelope's session-wide counter.
- **Counts by block, not family.** `doc.op` carries `counts: { placed: { "<block id>": n }, removed: n }`. `document/` can't see families (`palette/`). A viewer that wants families can map block ids itself.
- **Boxes** are public inclusive boxes in the document's local frame after the op (the same frame as the op's result). `doc.op` adds `shift` when the op moved the origin.
- **Refusals** are errors that carry a `refusal: "<code>"` property. The tool wrapper notes the error behind each error result, logs `call.refused` with that code and returns the result unchanged. Scoped sessions (`11`) should throw refusals this way.
- **Which folder.** A server session can open several documents. Each document's events go to `<workspace>/<doc>/observe/<session-id>/`. Events from before any document is open (the `call.start` of the `doc_new` that opens one) are held (at most 256) and written to the next document's log. `seq` stays unique and increasing across all of them, so one document's log can have gaps.
- **Pruning** runs when the session first writes to a document's `observe/` folder, not at process start: the server doesn't know which documents it will touch until then.
- **Snapshot modes.** `"checkpoint"` renders after checkpoints on the base document; `"merge"` renders after `scope.merge`, so it renders nothing until scoped sessions exist. Renders are debounced (500 ms), wait until no tool call is in flight, and are serialised. A burst of triggers produces one snapshot of the latest state, named by the bus `seq` when its render starts.
- **Main-thread rendering.** Snapshot renders run on the main thread, after tool calls finish. A tool call that arrives mid-render waits for the rasterizer's synchronous part. A worker thread would remove that, but it needs its own copy of the document and the pack stack. Not worth it until a large build shows the delay.
- **Reading `perception/`.** Snapshots call `perception/render`, as this doc specifies. `ARCHITECTURE.md` lists only `document/` and `assets/` for `observe/`, so that rule should add `perception/` (read-only).

## Open questions

- **Large documents in the browser.** At what size does the 3D view need chunked meshing with level of detail, or should it switch to the top-down map automatically? It should be measured on a large Craftoria build before deciding.
- **Many concurrent jobs.** If a session ever has dozens of open scopes, the scope tree and overlays need grouping (by parent, by brief). Doc 11 expects few concurrent jobs, so this waits until a log shows otherwise.
- **Claude Code panel.** A side pane next to the chat (scope tree plus the latest snapshot) could reuse `/events`. Is that worth maintaining alongside the web viewer?
- **In-game preview.** Mirroring merges into a live server as a ghost preview is appealing, but it writes into a real world. It is out of scope unless it can be made strictly non-destructive.
