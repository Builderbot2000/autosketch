# Silo H: Turn-end hook

**Wave 0** (H1). Independent of the wire.

**Specs:** `19` Part A *When a request has concluded*; `12` (*observe.http*, the receiver); `14` (*Setup*, plugin, install check).

## Deliverables (H1)

1. A route on the observe HTTP listener (`src/observe/http.ts`): `POST /v1/hooks/turn-end`, behind the existing Host and Origin checks (`guard.ts`) plus a bearer token. A wrong token gets 403 and no event.
2. A **port file** in the MCP's state directory (where it lives: decide, record in `19`) with port and token, written when the listener opens, removed on exit. Several MCPs at once: one file per process, the hook pings each live one (or pick a simpler rule and record why).
3. The bus emits `{type: "turn.end", at, reason?}` on a valid ping (README contract).
4. The hook command: a small Node entry in the package (for example `autosketch hook turn-end`, through `src/cli`), reading the port file(s), posting with a 1 s timeout, always exiting 0, printing nothing on success.
5. `packaging/claude-plugin/hooks/hooks.json` with a `Stop` hook running it. Check Claude Code's plugin hook format in the docs (`claude-code-guide` agent or the docs site) and cite it in `14`.
6. The install check (`14`) reports whether the hook is installed.
7. Tests: the route (token, guard, event), the command against a live listener and against none (exits 0 quickly).

## Files you own

`src/observe/http.ts`, `guard.ts`, the new hook module, `src/cli/**`, `packaging/claude-plugin/**`, `14`'s rows.

## Done when

- A `Stop` hook run against a running MCP produces exactly one `turn.end` on the bus; with no MCP running it returns within 1 s with exit 0.
