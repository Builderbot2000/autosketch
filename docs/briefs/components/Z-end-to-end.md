# Silo Z: End to end and close-out

**Wave 2**, after every other silo has merged.

**Specs:** `17` (*Workflow*, *Testing* end to end, *Open questions*).

## Deliverables

1. **End-to-end test** (`test/e2e/world/`, the world tier with the real mod): save a component in the world (the flash arrives), search it in a fresh MCP session, open the candidates screen from the reply line, pick and label it, check the agent receives the exact text, call `component_set`, then `stamp` by label lands the prefab and one undo removes it.
2. **Open questions:** resolve both in `17` with K's token measurements and the run's evidence, moved into the body with the answer and the reason; anything needing the user's call is raised, not decided.
3. **Close-out:** `17`'s *Status* line and *Implementation status* complete; a `HANDOFF.md` in this folder in the UI set's format (state, decisions taken, follow-ups).

## Done when

Every tier in the README's *Done means* passes on `main` with all silos merged, and the e2e test passes against the Craftoria server (`AUTOSKETCH_E2E_SERVER=~/servers/craftoria`).
