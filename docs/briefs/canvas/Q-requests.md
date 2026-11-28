# Silo Q: Request lifecycle, MCP

**Wave 1** (Q1, after W1 and H1), **wave 2** (Q2).

**Specs:** `19` Part A (all); `13` (*Prompting from the game*, *What streams back*, B6 modes, *Disconnect*); `17` piece 3 (actions); `11` and `05` (undo, journal).

## Deliverables

**Q1**

1. Request states `working`, `stopping`, `done`, `stopped`, `queued` on the MCP (`src/world/prompt.ts`, `chat-stream.ts`, or a new module beside them), measured `calls` and `elapsedMs`.
2. **Turn ownership by order** (`19`): a request delivered with no turn running starts one; the next `turn.end` ends it and every request delivered into it. Fallbacks when no `turn.end` has been seen this session: `world_reply done`, then `idleMs`; the status says `noTurnSignal`.
3. **Queue** per player, at most 8, `busy` over it; context captured at send; delivered first in first out on turn end; `queue.send` delivers into the running turn; `queue.cancel` removes; stop keeps the queue; dropped on disconnect.
4. **Stop:** `request.stop` (and the server-half command path W1 chose) → `stopping`; abort a running `run_script` or procedure between steps and long world reads; tell the mod to drop its unstarted patches (as W1 records); refuse every tool call with `stopped` until `turn.end`, then `stopped` and the next queued prompt.
5. Status messages (W1's `chat` kind `status`), at most one a second plus every state change; plain lines without feature `requests`.
6. Tests with the fake host and synthetic `turn.end` events: every transition, queue order, send now, cancel, stop mid-script, fallbacks.

**Q2**

7. `request.undo`: the journal entries the request made (base and merged scopes), undone as one step through the usual undo, sync barrier included; refused with the reason when another edit came after them.

## Files you own

The lifecycle module(s) in `src/world/`, the stop refusal in the call path (`src/server/session.ts`, additive), `src/ui/` handlers for the new kinds, `19`'s Q rows.

## Done when

- A queued prompt is never delivered into a running turn unless the player sent it now; a stopped request's agent gets `stopped` on every call until the turn ends.
