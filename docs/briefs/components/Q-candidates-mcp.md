# Silo Q: Candidates, MCP side

**Wave 1**, from W. Land `world_reply` candidates and `candidates.open` first: V needs a real answer to test against beyond the fake MCP.

**Specs:** `17` pieces 3 and 5, *Principles* 3, *Open questions* (candidates limit); `13` (*Prompting from the game*); `16` (*Ghost blocks*).

## Deliverables, in merge order

1. **Last sheet cells:** the session remembers prefab → cell from the last `prefab_sheet` call.
2. **`world_reply({candidates})`:** up to 24 `{prefab, cell?}`; cell defaults from deliverable 1. Stored under a candidates id, valid while the request is open and for the rest of the session. Appends one clickable line (W's reply-line action naming `candidates.open {id}`).
3. **Handlers** (new `src/ui/candidates.ts`, one dispatch line each in `src/ui/requests.ts`): `candidates.open`, `candidates.ghost` (the session's candidate ghost through `src/ui/ghosts.ts`, replacing the previous one), `candidates.ghost.clear`, `candidates.submit`.
4. **Picks as text:** submit becomes a channel event on the open request with the exact wording in `17` piece 5; if the request is closed, a new in-game request in the same mode with the same text. Submit clears the candidate ghost and marks the list answered (later `open` says so). The MCP never touches the component set.

## Files you own

`src/ui/candidates.ts`, the `world_reply` change in `tools/world-prompt.ts`, the submit path in `src/world/prompt.ts`, the session fields for the store and sheet cells, `prefab_sheet`'s one-line record in `tools/library.ts`.

## Done when

The *Testing* MCP items for `world_reply` candidates, the `candidates.*` handlers against the fake host, and submit on an open and on a closed request pass. The candidates-limit open question gets a recommendation in `17` (keep 24 unless the end-to-end run shows otherwise).
