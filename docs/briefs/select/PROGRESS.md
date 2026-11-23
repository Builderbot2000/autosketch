# Progress: select (`18`)

The lead's log, one line per step (*How to run this set* in the README). Read this, not old transcripts, to pick the run back up.

| Step | Agent | State | Merge | Notes |
|---|---|---|---|---|
| W1 | sl-w1 | started | | worktree .claude/worktrees/sl-w-wire |
| V1 | sl-v1 | merged | 008fd03 | view = read-only Document in world coords, refusal `world_view_read_only`, tied to held/current request; renders w1…; view calls need no scope; reads over contextCap refused until V2. 18's status table started (W1 will conflict: lead merges). For V2: `18` piece 6 writes `{dilate:["candidate",8]}`, real syntax `{dilate:"candidate", by:8}`; fix the spec text. Follow-up (not in this set): the MCP SDK strips unknown args, so `fill({view:"world"})` edits the open doc; strict schemas would fix it, deferred to the user. Worktrees need `node_modules` linked to the main checkout (fake-mcp CLI test spawns `node_modules/.bin/tsx`) |
| S1 | — | scheduled | | added 2026-11-23 with the user: strict tool args (V1 follow-up), wave 3 |
