# Progress: canvas and request control (`19`)

The lead's log, one line per step (*How to run this set* in the README). Read this, not old transcripts, to pick the run back up.

| Step | Agent | State | Merge | Notes |
|---|---|---|---|---|
| W1 | cv-w1 | merged | 8094542 | features `requests`, `canvas`, protocol 4; MCP_FEATURES unchanged, Q1 adds `requests`, F1 adds `canvas` (mod lists neither yet: G1/K1 add them); `chat` kind `status` {request, player, lines[1], state, text, calls, elapsedMs, queuePos?, noTurnSignal?, actions[{label,kind,args}]}, relayed whole to the client half (op 0), server half prints lines[0] otherwise; server-half commands = mod→MCP `request.control` {player, action: stop|queue|queue.cancel, position?}, answered by `notice` (stop, cancel) or `chat` (queue); ui.request `request.stop|queue.send|queue.cancel|request.undo` {request}, new ui.result `refused`; prompt.result queued {delivered:false, queued:true, request, position}, `busy` at QUEUE_MAX 8; `canvas` {id?, dimension, box|null} after `volumes`, `canvas.set` {id, dimension, box}, mod widens to chunk columns, `bad_volumes` over canvasChunks 256 per axis; canvas reads = select grant's (no hashes) in every mode, union with grant, search without `around` centres on canvas middle; src/ui/requests.ts answers the four kinds bad_request until Q1. Lead: a mod without `requests` gets no queueing (Q1 delivers as today); full clienttest needs `timeout 1800` (900 s too short for all nine suites). Lead tiers green: npm 1347, 67 GameTests, clienttest overlay+candidates 264 (3 overlay timeouts in the agent's loaded run did not repeat) |
| H1 | cv-h1 | merged | 80d430e | port file ~/.autosketch/run/mcp-<pid>.json (owner-only, pid/port/token); hook pings every live MCP, prunes dead pids, carries session_id; bus event `kind: "turn.end"` (bus keys by kind, not type), reason stop/error; hooks.json has Stop + StopFailure (Esc fires neither → fallbacks); install check = `turn-end hook:` line in instance_info (lead: kept there, no CLI command); `19` has a `### Implementation status (H1)` note to fold into W1's table. Lead tiers green: typecheck, npm test |
| Q1 | cv-q1 | running | | |
| G1 | cv-g1 | running | | |
| K1 | cv-k1 | running | | |
| F1 | cv-f1 | running | | |

**Resume here (2026-11-27).** Wave 0 merged (W1, H1). Wave 1 launched: Q1, G1, K1, F1. Prompts: `timeout 1800` for a full clienttest.
