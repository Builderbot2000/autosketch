# Silo V: Candidates screen

**Wave 1**, from W. Land the extraction of `LibraryScreen`'s parts (deliverable 1) first, in its own merge, behaviour unchanged: E builds its editor forms on them.

**Specs:** `17` piece 4, *Decisions* (Preview here, rejected ghost line-ups); `16` (*Screens*, *Ghost blocks*, the replay log list's clickable lines).

## Deliverables, in merge order

1. **Shared parts:** the thumbnail grid and the 3D orbit preview out of `LibraryScreen` into reusable classes in `client/ui/screen/`.
2. **Reply-line click:** the client half handles W's reply-line action by sending its `ui.request` (as the log list does) and opens the screen with the answer.
3. **Candidates screen:** question line, grid labelled by cell, selection shows preview, size, tags, notes; per candidate a tick box and label field; optional note; **Submit** sends `candidates.submit`, closes the screen and clears the candidate ghost. Reopening after submit shows that it was answered.
4. **Preview here:** sends `candidates.ghost` at the block under the crosshair, then closes the screen; *Clear candidate ghost* in the Autosketch menu beside *Ghost here*.

## Files you own

New `client/ui/screen/CandidatesScreen.java` and the extracted parts, the reply-line action handler, the menu entry in `MenuScreen`, client tests in a `candidates` suite.

## Done when

The *Testing* client items for the screen and Preview here pass on H's harness against the fake MCP; nothing draws or sends while `LinkState` isn't `connected`; vanilla-join GameTest and `runServer` still pass.
