# Progress: canvas and request control (`19`)

The lead's log, one line per step (*How to run this set* in the README). Read this, not old transcripts, to pick the run back up.

| Step | Agent | State | Merge | Notes |
|---|---|---|---|---|
| W1 | cv-w1 | running | | |
| H1 | cv-h1 | merged | 80d430e | port file ~/.autosketch/run/mcp-<pid>.json (owner-only, pid/port/token); hook pings every live MCP, prunes dead pids, carries session_id; bus event `kind: "turn.end"` (bus keys by kind, not type), reason stop/error; hooks.json has Stop + StopFailure (Esc fires neither → fallbacks); install check = `turn-end hook:` line in instance_info (lead: kept there, no CLI command); `19` has a `### Implementation status (H1)` note to fold into W1's table. Lead tiers green: typecheck, npm test |

**Resume here (2026-11-27).** Wave 0 launched: W1, H1.
