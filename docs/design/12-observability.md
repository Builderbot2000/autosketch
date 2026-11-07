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

## Phases

1. The event bus, `events.ndjson`, and `EventSink` hooks in document commits, scope tools and the server adapter.
2. Time-lapse snapshots.
3. The HTTP server with SSE and snapshots, plus the first three panels: 3D view with lock overlays, scope tree, event feed.
4. `deltas.bin`, then the timeline, the activity map and drill-in.
5. Replay and `autosketch observe <path>`, then the eval-runner join.

## Open questions

- **Large documents in the browser.** At what size does the 3D view need chunked meshing with level of detail, or should it switch to the top-down map automatically? It should be measured on a large Craftoria build before deciding.
- **Many concurrent jobs.** If a session ever has dozens of open scopes, the scope tree and overlays need grouping (by parent, by brief). Doc 11 expects few concurrent jobs, so this waits until a log shows otherwise.
- **Claude Code panel.** A side pane next to the chat (scope tree plus the latest snapshot) could reuse `/events`. Is that worth maintaining alongside the web viewer?
- **In-game preview.** Mirroring merges into a live server as a ghost preview is appealing, but it writes into a real world. It is out of scope unless it can be made strictly non-destructive.
