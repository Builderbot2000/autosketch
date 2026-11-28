# 19 — Canvas, brush and request control

Two problems found in a physical in-game test on Craftoria (2026-11-27):

1. **You can't tell whether the agent is still working.** A request opens a chat stream that stays open until `world_reply done` or an idle timeout. Nothing in chat tells the player it is still running, so a second prompt goes straight into the running turn and redirects work the player didn't know was in progress. You also can't stop it.
2. **The work volume is both the area the agent sees and the area it edits, so it is too small.** A large build selected with `/autosketch select` was refused at confirm: the box plus its context margin was over `contextCap` (4,194,304 blocks, about a 224×64×224 work volume). The cap exists for good reasons. The work volume and its context are mirrored densely (snapshot, hashes, change scan, chunk tickets), and a small editable area keeps the agent focused. But one number limits both the area the agent can see and the area it can edit.

Status: designed with the user 2026-11-27 (*Decisions*). Not built. Builds on `11` (scoped sessions), `13` (live world, volumes, in-game requests), `16` (in-game UI) and `18` (select, read grants).

## Decisions

Settled with the user 2026-11-27:

- **The canvas is the whole picture; the work volume is the brush.** The player sets out a large canvas. The agent can look anywhere inside it, and it paints with a small brush that it places and moves itself, anywhere in the canvas, without asking each time. Only the brush is dense, mirrored and writable.
- **The brush keeps the current cap.** Work and context together stay at most `contextCap` blocks. The cap now limits what the agent can change at once, not what it can see.
- **The request status updates in place, and clicking it stops the request.** `/autosketch stop` does the same.
- **Turn end is reported by a Claude Code `Stop` hook** that pings the MCP, so "concluded" means the turn ended, not just that the agent said `done` or went quiet.
- **A prompt sent while one is running is queued**, as Claude Code queues a message typed mid-turn: it shows as queued, can be cancelled, and is delivered when the running turn ends (*Queueing*).

## Part A — Request control

### Status line

Each delivered in-game request gets **one status line** in the player's chat, separate from the activity lines (`13`, *What streams back*):

```
⏳ Working · "build a gatehouse on the east wall" · 14 calls · 0:42   [Stop]
✔ Done · "build a gatehouse on the east wall" · 31 calls · 2:10
■ Stopped · "build a gatehouse on the east wall" · 9 calls · 0:25
⧗ Queued · "make the roof steeper"   [Send now] [Cancel]
```

- **Updated in place** by the client half: the line is kept by a request id and replaced when it changes, at most once a second, plus at once on every state change. Vanilla chat can't edit a line, but the client half owns the lines it adds, so it can. A client without the client half gets a new plain line on each state change (working, done, stopped, queued, delivered) instead of a rewrite, and a `/autosketch stop` hint in place of the button.
- **States:** `working` (delivered, turn running), `done` (the turn ended), `stopped` (the player stopped it, and the turn has since ended), `queued`. `stopping` is shown between the stop and the turn's end ("■ Stopping…"). Counts are measurements: calls, elapsed time. The line says nothing about what the work means.
- **The HUD** (`16`) shows the same state on its request line, and the queue length.
- Sent as a new `chat` kind `status` carrying `request`, `state`, `text`, `calls`, `elapsedMs`, and `actions` (clickable `ui.request`s, as `17`'s reply actions). Feature `requests` in both hellos. Without it, the mod gets plain `chat` lines.

### When a request has concluded

The turn's end is the authoritative signal. A request is **concluded** when the Claude Code turn it was delivered into ends:

- **The `Stop` hook.** The Claude Code plugin (`packaging/claude-plugin`) ships `hooks/hooks.json` with a `Stop` hook running a small command from the package. The command reads the MCP's local endpoint from a port file the MCP writes in its state directory and `POST`s `turn.end` to it. The endpoint is the existing local HTTP listener (`observe.http`, default port 47100), which already checks Host and Origin. A token in the port file guards this route too. The hook never blocks the turn: it fails silently within 1 s, and it always exits 0.
- **Fallbacks, in order,** when no hook has reported for this session (an older plugin, another client): `world_reply done`, then the current idle timeout (`idleMs`). The status line says `done (no turn signal)` in that case, so a player can see the hook is missing. The install check (`14`) reports a missing hook.
- The MCP learns which turn a request belongs to by order: a request delivered while no turn is running starts one, and the next `turn.end` ends it. A request delivered into a running turn (*Send now*) ends with that turn.

### Stop

`[Stop]` on the status line, or `/autosketch stop` (`/<alias> stop`), op level 2, the request's own player or any op:

1. The MCP marks the request **stopping** and answers at once (the line turns "■ Stopping…").
2. **Work in flight is cancelled where we own it:** a running `run_script` or procedure is aborted between steps, and a long world read or patch is cancelled. The mod drops the patches it hasn't started and finishes the one in progress, as on a disconnect (`13`, *Disconnect*), so the world is never left half-way through a patch.
3. **Every later tool call is refused** with `stopped`: "The player stopped this request. End your turn now; don't retry or continue." This is how the agent stops. An MCP server can't interrupt a Claude Code turn, so the agent ends it at its next tool call, not instantly. The status line says "■ Stopping…" until then.
4. **The turn's end** (the hook) turns the line to `stopped`, lifts the refusal, and delivers the next queued prompt, if any.
5. **Nothing is undone.** Blocks already placed stay. The stopped line offers `[Undo request]`, which undoes every journal entry the request made, in one step, through the usual undo (sync barrier included, `13`).

`stop` differs from `done`. `/autosketch done` lifts a held read-only mode and doesn't interrupt anything (`13`, B6). `stop` interrupts and leaves the mode as it is.

### Queueing

A prompt sent while a request is `working` or `stopping` is **queued**, not delivered:

- It shows its own `⧗ Queued` line with `[Send now]` and `[Cancel]`, numbered in order. `/autosketch queue` lists the queue, and `/autosketch queue cancel <n>` cancels one.
- **Delivered when the running turn ends**, one at a time, first in first out, each starting its own turn and status line.
- **`[Send now]`** delivers it into the running turn at once, which is today's behaviour. Use it to steer the agent while it works. The two requests then share the turn and end together.
- **Stop keeps the queue.** A player who stops usually wants to change course, and the queued prompt is often the correction.
- The queue is the MCP's, per player, at most 8 entries (over it, refused `busy`). It is dropped when the game disconnects. Each entry carries the context captured when it was sent (position, look, focus), not the context at delivery, since that is what the player was pointing at.

## Part B — Canvas and brush

### Model

| | Canvas (new) | Brush = work volume | Context |
|---|---|---|---|
| Size | Large: chunk columns, full build height, at most `canvasChunks` across (config, default 256) | Work + context at most `contextCap` | As `13` |
| Held by the MCP | Nothing up front; read on demand | Dense mirror (snapshot, hashes, change tracker, tickets) | Read-only mirror |
| Agent may | Read, search, fill, view anywhere | Write | Read |
| Set by | The player (wand, command, select confirm) | The agent inside the canvas; the player anywhere | Follows the brush; the player can add boxes |

- **The canvas is the agent's read area,** served the way select's grant is (`13`, *Read grants in select mode*): blocks, `mask` and `coarse` snapshots, surface snapshots, `search`, `fill` and `expand`, each capped per call by `contextCap`, chunks read from disk without generating or ticketing them. A canvas that lasts gives the same reads in every mode, including `build`, instead of a grant that lasts one select request.
- **Without a canvas,** everything works as today. The work volume alone sets the frame, and only the player moves it.

### The frame doesn't move with the brush

`01` says coordinates must stay stable while editing. If local (0,0,0) stayed at the work volume's minimum corner (`13`, *Frame*), every brush move would renumber everything the agent has planned. So, with a canvas set:

- **Local (0,0,0) is the canvas's minimum corner.** Brush moves don't change any coordinate. World = local + canvas minimum.
- **The linked document is sparse.** It holds the brush's and context's sections; `VoxelStore` is already sparse in 16³ sections. Reads of canvas positions outside the mirror don't read as air. Document tools (`query_*`, `view_slice`, `render`) read them through the world view, as select's tools do (`18`, piece 5), marked read-only and possibly stale. Positions outside the canvas are refused, as outside the volumes now.
- Without a canvas, the frame stays as `13` sets it.

### Placing and moving the brush

- `world_volumes({work, context?})` (`13`, B4) is allowed in every mode **for a work volume inside the canvas**, without asking the player. Outside the canvas, or with no canvas, it keeps today's rule (refused in read-only modes, `bad_volumes` beyond the cap).
- **A move is a relink** of the brush only. It happens between calls, never during one. Before moving, the MCP waits for the brush's pending patches to be acked, then drops the old brush's sections from the mirror (keeping the journal), releases the old tickets, snapshots the new brush and context, and takes new tickets. The result reports what moved and the time it took.
- **The brush's outline** (work box, solid; context, dashed) moves in-game, drawn by the overlay renderer (`16`). The canvas is drawn as a faint box, plus a chunk grid on the ground while the wand is held.
- **Undo of a stroke outside the current brush** is refused, naming the brush to move to ("This entry wrote at (120,64,40)–(150,80,70); move the brush there first"). Its blocks may have been hand-edited since, so moving back snapshots the region again, and the undo goes through the sync barrier as usual (`13`).
- **The fork ratio** (`11`) measures against the brush, as it measures against the root's work volume now. Several brushes at once (parallel jobs in distant parts of the canvas) are deferred (*Open*).

### Setting the canvas

- **Wand:** a new mode `canvas`, after `work` and `context` in the swap-hands cycle; the two corners give the canvas box, widened to whole chunk columns and the full build height.
- **Commands:** `/autosketch canvas here [radius]` (a square of chunks around the player, default 16), `canvas grow <chunks>`, `canvas clear`, and `canvas show`, which also lists the size in chunks.
- **Select confirm** (`18`, piece 9): a confirmed shape over the brush cap sets the **canvas** to the shape's box plus margin, and the result says the agent will place the brush itself. This replaces today's "too large for a work volume" refusal. A shape under the cap sets the volumes as now, and the canvas too when none contains them.
- **One canvas per server**, global like the volumes (`13`), not saved with the world. A brush the player marks outside the canvas clears the canvas (the result says so). Clearing the canvas keeps the brush and returns to the work-volume frame. That is a relink.
- Over `canvasChunks` across: `bad_volumes`, naming the config key.

### Seeing the whole canvas

These tools exist already. The canvas makes them available in every mode:

- `world_view_read` (`18`) for coarse and full reads anywhere in the canvas; `render` and `camera` with the world view for pictures; `world_search` and `world_fill` for finding things and their extents.
- **`world_map`** (new, MCP): the canvas from above, one cell per chunk column, shaded by surface height, with the brush, the context, any open jobs and the player marked, and a chunk grid labelled in local coordinates. It is how the agent sees the whole canvas before choosing where to put the brush. It reports measurements only: heights, block counts, where the brush and player are.
- The canvas's `skills/` guide (shipped, advisory, `07`): look at the whole canvas first, then place the brush over one coherent part.

## Changes to other specs

- `13`: the frame rule gains the canvas case. `world_volumes` is allowed inside the canvas in every mode. New messages `canvas.set` (MCP→mod, for select confirm) and `canvas` (mod→MCP, like `volumes`). New `chat` kind `status`, new `ui.request` kinds `request.stop`, `queue.send`, `queue.cancel` and `request.undo`, feature `requests`. Reads are served inside the canvas, as inside the select grant. Protocol version unchanged; all of these are new features.
- `11`: the ratio limit's "root work volume" is the brush.
- `16`: the HUD request line and the canvas outline.
- `18`, piece 9: confirm sets the canvas when the shape is over the brush cap.
- `14`: the plugin ships the `Stop` hook, and the install check reports it.

## Steps

| Step | Side | What |
|---|---|---|
| Q1 | MCP | Request lifecycle: states, per-player queue, `turn.end` route and port file, the fallbacks, `stopped` refusal and cancellation of in-flight scripts and reads; `status` chat messages. Unit tests with the fake host. |
| Q2 | Plugin | `Stop` hook and its command; install check. |
| Q3 | Mod | `/autosketch stop`, `queue`; `status` lines updated in place (client half), plain lines without it; HUD request line; `request.*` and `queue.*` requests; dropping unstarted patches on stop. GameTests and client tests. |
| Q4 | MCP | `[Undo request]`: one undo step over a request's entries. |
| K1 | Mod | Canvas: wand mode, commands, the `canvas` message, `canvasChunks`, reads served inside it, outline and chunk grid. |
| K2 | MCP | Canvas frame and sparse linked document; document reads outside the mirror through the world view; brush moves by `world_volumes` (wait for acks, relink the brush only); undo outside the brush refused. |
| K3 | MCP | Select confirm sets the canvas; `world_map`; the canvas skill. |
| K4 | Both | End-to-end on Craftoria: a canvas of 64×64 chunks, three brush moves, an undo after moving back, a stop while a patch is in flight, a queued prompt delivered on turn end. |

Q and K are independent. Within each, the order is as listed (Q3 needs Q1's messages; K2 needs K1's).

## Open

- **Several brushes at once.** Parallel jobs placed in distant parts of the canvas, each with its own dense mirror, instead of forks inside one brush. This needs the fork ratio measured against the canvas and a total mirror cap. Wait until one brush has been used in practice.
- **`canvasChunks` default.** 256 matches `selectChunks`; measure `world_map` and coarse reads at that size on Craftoria in K4 before settling.
- **Hook reliability.** Check in K4 whether the `Stop` hook fires when the user presses Esc in the terminal, and on an error stop. If not, the idle fallback covers it, and the line says so.
