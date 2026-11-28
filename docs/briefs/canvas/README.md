# Work briefs: canvas and request control (`19`)

One brief per silo of `19`, as of the commit that adds this folder (2026-11-27). Each team reads the main [briefs README](../README.md) first (branching, file ownership, code style and *Done means* all apply), then the [world README](../world/README.md) and the [UI README](../ui/README.md)'s *Rules for this set* where it touches `src/world/`, `src/ui/` or `mod/`, then this README, then its own brief, then `19` and the sections of `11`, `13`, `14`, `16`, `17` and `18` the brief cites. `19` is the source of truth. A brief only scopes, sequences and assigns files.

Letters are local to this set. Agents work one step at a time and are never resumed (*How to run this set*). Branches are named `silo/cv-<letter>-<slug>`, agents `cv-<step>`.

| Silo | Brief | `19` part | Wave | Side | Depends on |
|---|---|---|---|---|---|
| W | [Wire contracts](W-wire.md) | A and B, wire parts | 0 | both | — |
| H | [Turn-end hook](H-hook.md) | A, *When a request has concluded* (hook, route) | 0 | MCP, plugin | — |
| Q | [Request lifecycle, MCP](Q-requests.md) | A | 1, then 2 | MCP | W1, H1 |
| G | [Request control in game](G-game-requests.md) | A (mod, client) | 1 | mod | W1 |
| K | [Canvas in the mod](K-mod-canvas.md) | B (mod) | 1 | mod | W1 |
| F | [Canvas frame and brush, MCP](F-frame-brush.md) | B (MCP) | 1, then 2 | MCP | W1 |
| M | [Seeing the canvas, select confirm](M-map-confirm.md) | B, *Seeing the whole canvas*, *Setting the canvas* (confirm) | 2 | MCP | F1 |
| Z | [End to end, close-out](Z-e2e.md) | Steps K4; *Open* | 3 | both | all |

```
wave 0               wave 1                                     wave 2                       wave 3
W1 wire ──────────┬─► Q1 lifecycle, queue, stop (MCP) ─────────► Q2 [Undo request] ─────────┐
H1 hook + route ──┘   G1 stop/queue/status in game (mod) ──────────────────────────────────┤
                  ├─► K1 canvas in the mod ────────────────────────────────────────────────┼─► Z1 end to end
                  └─► F1 canvas frame, sparse doc, reads ──┬─► F2 brush moves, undo rule ──┤   Z2 status, handoff
                                                           └─► M1 world_map, confirm, skill┘
```

**Why this split.** As in earlier sets, the MCP and the mod meet only at the protocol, so W freezes the wire first and both sides build against it, the MCP against the fake host. The hook is separate from the lifecycle so the turn signal exists before the lifecycle that reads it, and so packaging stays in one silo. Part A (requests) and Part B (canvas) don't share files beyond the wire and `prompt.ts`, so they run side by side.

## Cross-silo contracts

The owner lands the contract in its first merge, and the users code against it.

| Contract | Owner | Users | Shape |
|---|---|---|---|
| `turn.end` event | H1 | Q1 | The observe bus (`src/observe/bus.ts`) emits `{type: "turn.end", at, reason?}` when the hook's `POST` arrives. Q1 subscribes. No other coupling |
| Status line | W1 (shape), Q1 (sends), G1 (shows) | Q, G | `chat` kind `status`: `request`, `state` (`working`, `stopping`, `done`, `stopped`, `queued`), `text`, `calls`, `elapsedMs`, `queuePos?`, `noTurnSignal?`, `actions[]` (as `17`'s reply action, each a `ui.request`). Feature `requests` |
| Request control | W1 (shape), Q1 (behaviour), G1 (sends) | Q, G | `ui.request` kinds `request.stop {request}`, `queue.send {request}`, `queue.cancel {request}`, `request.undo {request}`. The server-side commands `/autosketch stop` and `queue …` reach the MCP from the server half too, so a vanilla client can use them (W1 picks the message; `13`, *Relay*) |
| Queued prompt | W1 (shape), Q1 | G1 | `prompt.result` gains `queued` with `request` and `position`; the prompt's context is the one captured when it was sent |
| Canvas messages | W1 (shape), K1 (mod), F1 (MCP) | K, F, M | mod→MCP `canvas {box|null, dimension}` after hello and on every change; MCP→mod `canvas.set {id, box}` answered by `canvas` with that id, or `bad_volumes`. Boxes are whole chunk columns, full build height. Feature `canvas` |
| Canvas reads | W1 records, K1 enforces | F, M | Inside the canvas the mod serves what it serves inside the select grant (`13`, *Read grants in select mode*), in every mode |
| Canvas frame | F1 | F2, M1, Z | With a canvas, local (0,0,0) = canvas min; the linked document holds the brush and context sections; reads elsewhere in the canvas go through the world view, marked read-only |
| Fake host | W1 | Q, F, M | `test/support/fake-host.ts` answers the canvas messages and reads, and accepts the new `chat` and `ui.request` kinds |

## Contested files

| File | Who touches it | Protocol |
|---|---|---|
| `src/world/protocol/**`, `test/data/world-protocol/**`, `test/support/fake-host.ts`, `test/support/fake-mcp.ts`, `mod/common/.../protocol/**` | W, bug fixes only otherwise | W owns them |
| `docs/design/13-live-world.md` | W (wire sections), each silo its *Implementation status* row | Edit only your rows |
| `docs/design/19-canvas-and-requests.md` | W1 adds the *Implementation status* table; each silo its own rows; Z2 the *Status* line | Edit only your rows |
| `src/world/prompt.ts`, `src/world/chat-stream.ts` | Q1 (lifecycle, queue, status), F1 (canvas frame in the event text) | Q1 first; F1 additive |
| `src/world/link.ts`, `live-link.ts`, `sync.ts`, `set-volumes.ts` | F1, then F2 | F only |
| `src/world/select/confirm.ts` | M1 | M only |
| `src/server/session.ts`, `src/server/index.ts` | H1 (route wiring), Q1 (stop refusal in the call path), F1 (canvas on the session) | Additive; rebase often |
| `src/observe/http.ts`, `guard.ts` | H1 | H only |
| `packaging/claude-plugin/**`, `src/cli/**` | H1 | H only |
| `mod/common/.../command/**`, `prompt/InGamePrompts.java` | G1 (stop, queue), K1 (canvas subcommands) | Additive subcommands, each in its own class |
| `mod/common/.../volume/**`, `AutosketchConfig.java` | K1 | K only |
| `mod/neoforge/.../client/ui/hud/**`, chat handling | G1 | G only |
| `mod/neoforge/.../client/ui/overlay/**` | K1 (canvas outline, chunk grid) | K only |

## Rules for this set

- **No opinions in code.** The status line, `world_map` and every result report measurements: counts, times, heights, boxes. Nothing judges the work.
- **The brush is the only write limit.** The canvas grants reads and moving the brush, never writes outside the brush.
- **Coordinates don't move with the brush** (`01`). Any change that renumbers local coordinates on a brush move is a bug.
- **Mirror Claude Code** for request handling: queued prompts are visible and cancellable, stop ends the turn at the next tool boundary, the indicator says working or done.
- **Clients without the client half work** with plain lines and commands, everywhere.
- **Tick slicing in the mod** as before; canvas reads never generate or ticket chunks.

## How to run this set

As in the select set (`../select/README.md`, *How to run this set*): **one fresh agent per step, never resumed or messaged** (the hook blocks SendMessage to `cv-…`). Worktrees in `.claude/worktrees/cv-<letter>`, with `node_modules` linked to the main checkout. Review fixes are a new agent `cv-<step>-fix`; an interrupted step gets a WIP commit and a fresh agent. State lives in git, `19`'s *Implementation status* and [PROGRESS.md](PROGRESS.md).

| Silo | Steps (one merge each) |
|---|---|
| W | W1 every wire addition of `19` (status chat kind, request-control kinds and the server-half path for commands, `prompt.result` `queued`, canvas messages, canvas reads recorded, features `requests` and `canvas`); vectors, both codecs, fake host; `13`'s wire sections; `19`'s status table |
| H | H1 `POST` route on the observe listener with token, port file, `turn.end` on the bus; the hook command; `hooks/hooks.json` in the plugin; install check reports the hook |
| Q | Q1 lifecycle states, per-player queue (8, `busy` over it), turn ownership by order, fallbacks, `stopped` refusal, cancelling scripts, procedures and world reads in flight, telling the mod to drop unstarted patches, status messages · Q2 `[Undo request]`: one undo step over the request's entries |
| G | G1 `/autosketch stop`, `queue`, `queue cancel <n>`; status lines rewritten in place by the client half, plain lines without it; buttons; HUD request line and queue length; dropping unstarted patches on stop |
| K | K1 wand mode `canvas`, `canvas here|grow|clear|show`, `canvasChunks` (default 256), `canvas` messages, reads served inside the canvas, canvas outline and chunk grid on the overlay |
| F | F1 canvas frame, sparse linked document, document reads outside the mirror through the world view, event and results naming the canvas · F2 brush moves by `world_volumes` inside the canvas in every mode (wait for acks, relink the brush only, new tickets), undo outside the brush refused, fork ratio against the brush |
| M | M1 select confirm sets the canvas when the shape is over the brush cap; `world_map`; the canvas skill (`library/knowledge/skills/`, regenerated into packaging) |
| Z | Z1 end to end on Craftoria (`19` step K4) and the *Open* measurements · Z2 status, `HANDOFF.md` |

**Waves.** Wave 0: W1, H1. Wave 1: Q1 (W1, H1), G1, K1, F1 (W1). Wave 2: Q2 (Q1), F2, M1 (F1). Wave 3: Z1, then Z2.

**Step prompt** (the whole prompt; add review notes or WIP instructions after it):

> You are agent `cv-<step>` in the autosketch repo, worktree `<path>`, branch `silo/cv-<letter>-<slug>`. Read `docs/briefs/README.md`, `docs/briefs/canvas/README.md` and `docs/briefs/canvas/<brief>.md`, then the spec sections the brief cites. Do step <step> only: <one line from the table>. Meet the *Done means* for what this step builds, commit only your own changes (check `git diff --stat main` first; attribution line from the main README), and don't merge or push. Use your own scratchpad subfolder `<scratch>/cv-<step>`. Write full test and build output to files and read only the summary or the failures; run clienttest under `timeout 900`. Then stop with this report and nothing else:
> ```
> cv-<step> · branch <branch> · commits <first>..<last>
> tiers: typecheck <ok|fail> · npm test <n passed / n failed> · gradle <ok|fail|n/a> · clienttest <n steps ok|fail|n/a>
> decisions: <one line each, already recorded in the spec>
> questions for the lead: <one line each, or none>
> ```

The lead checks a step by running the tiers on the branch and reading `git log --stat main..<branch>`, then adds one line to `PROGRESS.md`.

## Done means (in addition to the main README's)

- `npm run typecheck`, `npm test`, `cd mod && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./gradlew build test runGameTestServer` and `mod/clienttest.sh` pass (the last two for silos touching `mod/`).
- `19`'s *Implementation status* has a row per step, marked built, and the *Changes to other specs* are made in the specs they name.
