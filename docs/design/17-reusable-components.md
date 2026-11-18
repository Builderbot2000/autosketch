# 17 — Reusable Components

The player and the agent build an architectural component together (a buttress, a tower, a wall bay), save it to the library, and later find components by describing them. The player picks the ones they want, and for the rest of the session the agent uses those picks as its own vocabulary, pasting them into the build without asking again. The player can edit every library entry by hand in the game.

Status: designed with the user 2026-11-17 (*Decisions*). Not built. Split into silos W, K, F, Q, V, E and Z in `docs/briefs/components/` (2026-11-18). Builds on `07` (library), `13` (live world, in-game requests) and `16` (in-game UI).

## Principles

1. **Advise, don't constrain** (from `07`). The component set is the agent's preferred vocabulary for the session, not a rule. The server never forces a stamp or refuses an op because of the set.
2. **The set is session context.** It belongs to the session, not to a build, a document or the world. It exists so the player doesn't reselect or re-explain components in a busy session. It ends with the session.
3. **The player's choice reaches the agent as words.** The candidates screen answers the agent the way a multiple-choice prompt does: as text in the conversation. The screen never changes the set or the build itself.
4. **Undo instead of previews.** Automatic pastes go straight in. Each stamp is one journal entry and one world patch (`13`, *World undo and restore*), so a wrong one costs one undo. There is no approval step.
5. **The library belongs to the player.** Everything the agent can save, the player can see and edit by hand in the game. Files stay the source of truth (`16`, principle 7).
6. **Model-agnostic.** Nothing depends on one agent client's memory or features beyond what the MCP already uses (`14`).

## The workflow

1. **Build.** The player marks a work volume and builds with the agent as today (`13`).
2. **Save.** "Save that buttress." The agent works out the extent (`select` with a box, `{connected}`, a component), checks it with slices or a render, and calls `prefab_save`. The saved box flashes in the world, so the player sees what was saved.
3. **Search.** In a later session: `/autosketch ask show me a tower`. The agent searches the library (`prefab_search`, `prefab_sheet`) and answers in chat with a short summary and a clickable **[Show candidates]** line.
4. **Choose.** The link opens the candidates screen: thumbnails under the same cell ids as the agent's sheet, a 3D preview, and *Preview here* to see one candidate at full scale where the player is looking. The player ticks some, labels them ("corner tower") and submits. The agent receives *"Picked: B2 (corner tower), A3 (gatehouse)"* as text. The player can also skip the screen and type the same thing.
5. **Use.** The agent records the picks in the session's component set. From then on, "add towers on the corners" means the picked tower, stamped with rotation, mirroring and palette recolouring as needed. "That's the wrong tower" makes the agent search and offer candidates again.
6. **Keep a set (optional).** "Save this set as *gothic cathedral kit*" writes it to the library as a kit pack. In a later session, "use my gothic cathedral kit" loads it back into the session set.

## Already built

| Piece | Where |
|---|---|
| Building in the live world, linked document, selections, perception | `13`, `05`, `06` |
| `prefab_save` from a selection or component on the linked document (anchors, roles, `requires`, thumbnail) | `07`, `src/server/tools/library.ts` |
| `prefab_search` (keywords, tags, footprint) and `prefab_sheet` (thumbnails with cell ids) | `07` |
| `stamp` with rotate, mirror, `palette_remap`, in scripts and procedures, registering a component | `07`, `05` |
| Undo and redo of stamps in the world, guarded against overwriting hand edits | `13` |
| In-game library screen: browse, filter, thumbnails, 3D preview, rename, duplicate, copy, hide, recoverable delete | `16`, `LibraryScreen` |
| Ghost drawing and ghost anchoring; clickable chat lines (replay log list); change flashes | `16` |
| Writers for `.schem`, `.bp`, `.litematic`, structure `.nbt` | `src/formats/` |
| Knowledge packs that name prefabs | `07` |

`prefab_save` reaches only the linked document's work and context volumes. Saving something outside them means marking a volume around it first. That is accepted, not changed here.

## New pieces

### 1. Component set (MCP)

A small record on the MCP session: an ordered list of entries `{ prefab, label?, notes? }`, where `prefab` is a library name (`axiom/…` names included). It is in memory only and cleared when the session ends.

One tool, `component_set`, keeps it:

| Argument | Effect |
|---|---|
| none | Shows the set |
| `add: [{prefab, label?, notes?}]` | Adds or replaces entries (an entry with the same label or prefab is replaced) |
| `remove: [label or prefab]` | Removes entries |
| `clear: true` | Empties the set |
| `save_as: "<name>"` | Writes the set as a kit pack (*Kits*) in the first writable root |
| `load: "<name>"` | Replaces the set with a kit's entries |

Every result shows the whole set afterwards. Unknown prefab names are refused with the nearest names, so a typo never ends up in the set.

Settled while building it (K1): the arguments combine in one call and apply in the order `load` or `clear` (not both), `remove`, `add`, `save_as`, after every name has been checked, so a refused call leaves the set as it was. `add` takes a prefab's id or display name and stores the id; sheet cells are not accepted there (cells name the last sheet, which changes, while the set must outlive it). `remove` names that match nothing are reported, not refused. The record lives on the MCP `Session` (`session.componentSet`, logic in `src/library/component-set.ts`) and is not tied to the open document: opening or closing documents leaves it alone.

**Reminders.** The set is in the agent's context from the moment it's made, but long sessions get summarised. While the set is not empty, one line (`set: corner tower = gothic_tower_a, gatehouse = gate_small`) is appended to the results of `prefab_search`, `prefab_sheet` and `stamp`, and to the text of each in-game request's channel event (`13`, *Prompting from the game*). Those are the moments the agent is choosing or placing components. Other tool results don't carry it, to save tokens.

**Resolving by label.** `stamp({prefab: "corner tower"})` resolves a set label to its prefab before resolving library names and sheet cells. This is a convenience, not a constraint: any library prefab can still be stamped by name.

Settled while building it (K2): a label wins even when it equals another prefab's name or a sheet cell id ("A1"), since the order is labels, then names, then cells; labels match case-insensitively, as everywhere in the set. Resolution is in the `stamp` tool only, not in `stamp` inside scripts and procedures, because a saved procedure must not depend on one session's labels. The reminder is the last line of the result text (the caption for `prefab_sheet`), also on "No prefabs match" results, and not on refused calls. Logic: `ComponentSet.stampRef` and `ComponentSet.remind`.

### 2. Kits

A kit is a knowledge pack (`07`) with `kind: kit` under `knowledge/kits/`. Its frontmatter lists the entries, and the body holds free notes from the player or the agent:

```markdown
---
kind: kit
name: Gothic cathedral kit
tags: [gothic, church]
summary: Buttresses, corner towers and gatehouse from the 2026-11 cathedral.
entries:
  - { prefab: buttress_flying_a, label: buttress, notes: every third bay }
  - { prefab: gothic_tower_a, label: corner tower }
  - { prefab: gate_small, label: gatehouse }
---
Used with palette `castle`.
```

`knowledge_list({kind: "kit"})` lists them. A kit is written only when the player asks to keep a set. It is never saved automatically.

Settled while building it (K1): `save_as` writes `knowledge/kits/<stem>.md`, the stem being the name lower-cased with other characters turned into `_` ("Gothic cathedral kit" → `gothic_cathedral_kit`), with the name as `name:` and a generated `summary`. Saving again under the same name rewrites only `entries`, keeping the player's other frontmatter and notes. `load` finds a kit by path, file name, title or that stem, and only packs of kind `kit`. An entry whose prefab is no longer in the library is skipped with a warning naming the nearest prefabs, rather than refusing the whole kit, since the rest are still valid picks. The light frontmatter reader takes one line per key, so `entries` has its own reader: flow maps as above, block maps (`- prefab: a` with indented `label:` lines) and bare prefab names, with quoted values for commas.

### 3. Candidates in a reply (MCP and wire)

`world_reply` takes an optional `candidates`: up to 24 entries `{ prefab, cell? }`. The cell defaults to the cell the prefab had on the last `prefab_sheet`, so the screen and the agent use the same ids. The MCP stores the list under a candidates id, valid while the request is open and for the rest of the session after it. It appends one clickable line to the reply. The click runs a client action, as replay's log lines do, and the client sends `ui.request` `candidates.open {id}`.

New `ui.request` kinds (feature `ui`, `16`, *Wire additions*):

| Kind | Answer |
|---|---|
| `candidates.open {id}` | The list: per entry, cell, prefab name, root, size, tags, notes; plus the open request id and question text |
| `candidates.ghost {id, prefab, dimension, at, rotate?}` | Shows one prefab as the session's candidate ghost (id `candidate`) at `at` (world coordinates); replaces any earlier candidate ghost |
| `candidates.ghost.clear` | Removes it |
| `candidates.submit {id, picks: [{prefab, cell, label?}], note?}` | Sends the picks to the agent as text (*Picks as text*); answers with the request the text went to |

Thumbnails and the 3D preview reuse `library.thumbnail` and `library.preview`. The exact schemas are in `13`'s *Request kinds*, with golden vectors, as for the other `ui` messages.

**Wire shape** (silo W, step W1, 2026-11-18):

- **The clickable line is an optional `action` on a `chat` reply**, `{line, kind, args}`: `lines[line]` is clickable and the click sends the `ui.request` `kind` with `args`. Reason: the line is generic (any `ui.request`, not only `candidates.open`), costs one optional key, and a mod or client without the `ui` feature ignores the key and shows the same line as plain text. One action per message is enough for piece 3; a second clickable line would be a second `chat`.
- **`candidates.ghost` also takes `dimension`**, as `ghost.anchor` does. Reason: every ghost message names its dimension (`13`, `ui.ghost`), and the player may be in another dimension than the linked document.
- **A new error code, `answered`**, for `candidates.open` and `candidates.submit` after the list was answered, instead of reusing one. Reason: none of the existing codes means it (`conflict` says reload and retry, `not_found` says the id is unknown), and the screen needs to tell "answered" apart to show the line as answered. Only the `candidates.*` kinds return it, so a mod from before them never receives it.
- **`candidates.ghost.clear` with no ghost shown is `{}`**, not `not_found`, so the menu entry can clear without knowing whether one is shown.

**MCP side** (silo Q, step Q1, 2026-11-18):

- **The session keeps the last sheet's cells** (`Session.candidates`, `src/library/candidates.ts`): `prefab_sheet` records prefab id → cell for the page it shows, replacing the previous sheet's. A stored list keeps the cells it was made with, so a later sheet never changes it.
- **A prefab not on the last sheet and given no cell gets `#n`**, its place in the list. Reason: every entry needs an id the picks can name, and a made-up sheet cell ("B2") would mean a different prefab on the agent's sheet; `#n` can't be confused with one. An explicit `cell` must look like a cell (`B2`). A prefab or cell given twice, or an unknown prefab, refuses the call and nothing is sent.
- **Prefabs resolve as `stamp` resolves them** (id, display name, a cell of the last sheet), but not by set label: labels are the agent's words for picks already made, and candidates are offered before a pick. Entries are stored with their size, tags and notes as they were at reply time, and `candidates.open` serves that snapshot, so the list the player sees is the one the agent described.
- **The appended line** is `[Show candidates (n)]` with the action `candidates.open {id}`, the line after the agent's own. When the mod lacks `ui` the MCP sends no action (`13`, `chat`), and since that line could open nothing, it lists the cells instead (`Candidates: B1 park_bench, A1 lamp_post`), so the player can still answer by typing. The tool result names the id, each cell and prefab, and which of the two went out.
- **Ids are `c1`, `c2`, …**, one per reply with candidates, kept for the rest of the session. The list records the request the reply went to and that request's text (the question); a reply to no request stores `request` null and an empty question. `candidates.open` reports `request` while that request is still open: its activity stream, or its read-only mode still held (`13`, B6), since an ask answered with `done` is still the player's open question until they end it. Otherwise `null`.

### 4. Candidates screen (mod)

A screen built from `LibraryScreen`'s parts (`PaneScreen`, the thumbnail grid, the preview, `Requests`):

- The agent's question line at the top, then a grid of thumbnails labelled with their cells.
- Selecting one shows its 3D orbit preview, size, tags and notes.
- Per candidate: a tick box and a label field.
- **Preview here** shows the candidate as a ghost at the block the player is looking at, then closes the screen so the player can look around. The ghost stays until another candidate is previewed, the screen is submitted, or the player clears it from the Autosketch menu (*Ghost here* already sits there).
- An optional note field ("smaller if possible") and **Submit**. Submitting closes the screen and clears the candidate ghost.

The screen can be reopened from the chat line until the player submits. After that, the line says it was answered.

### 5. Picks as text (MCP)

`candidates.submit` becomes text for the agent, delivered as a channel event on the open request, with the request id:

```
Candidates answer from Kev (request 12): picked B2 gothic_tower_a as "corner tower", A3 gate_small as "gatehouse". Note: smaller if possible.
```

If the request is already closed, the answer opens a new in-game request in the same mode, with the same text. The MCP doesn't add the picks to the set. The agent does that with `component_set` after reading the answer, so the player's words, the agent's understanding and the set stay in one place, the conversation.

### 6. Library editors in game (MCP and mod)

The editors `15` built for the browser, removed with it (commit `0e7a40c`), come back as `ui.request` kinds and in-game forms. The hash-checked write logic is recovered from commit `b6e60bf` (`writeEntryText`, `writePrefabMeta`, `writePaletteFile`, with their tests). The entry detail already sends `hash` and `editable` (`src/ui/library.ts`).

| Kind | Editable in a writable root |
|---|---|
| Prefab | `prefab.json`: name, tags, front, notes, anchors, roles |
| Palette | Tags, notes, member weights, remove, rename and drop roles, add members by block id (the `palette_edit` operations, `03`) |
| Procedure | Source, as text |
| Knowledge pack (kits included) | Frontmatter and text |

Each write sends the hash it started from. A changed file is refused with `conflict` and the screen reloads, so a file the agent just saved is never overwritten. Entries in read-only roots offer *Copy to my library* first, as now.

Editing a prefab's **blocks** stays out of scope (`15`). The round trip already works: stamp it in the world, edit it, `prefab_save` with `overwrite`.

### 7. Save format

`prefab_save` takes `format`: `schem` (default), `litematic`, `nbt` or `bp`, and the setting `library.prefabFormat` changes the default. A prefab folder holds one schematic file (`prefab.<ext>`). Every format is already readable, so stamping and the library screen work the same with any of them.

Built details (F1, 2026-11-18): `.litematic` joined the extensions a library scan accepts (it was readable but never listed). Saving over a prefab in another format removes the old `prefab.<ext>`, so a folder never holds two. A `.bp` save leaves out block entities and entities with the same warning `export` gives, and embeds the rendered thumbnail so Axiom's browser shows it. The setting is read on each save, like the other `library.*` settings (`applies: "live"`); an invalid launch value falls back to `schem`.

### 8. Flash on save

When `prefab_save` runs on a linked document, the saved box is sent as a change flash (`ui.flash`) in a fixed colour, so the player sees what was saved without an approval step. If it's wrong, the player says so, and the agent saves again with `overwrite`.

## Implementation status

| Piece | Silo | Status |
|---|---|---|
| 1. Component set | K (K1) | Record and `component_set` tool built: `src/library/component-set.ts`, `src/server/tools/components.ts`, `Session.componentSet`. Tests: `test/unit/library/component-set.test.ts`, `test/unit/server/components.test.ts`. Label resolution in `stamp` and the reminder on `prefab_search`, `prefab_sheet` and `stamp` built (K2): `ComponentSet.stampRef`, `ComponentSet.remind`, `src/server/tools/library.ts`; tests in the same two files (label before name and cell, block-level; reminder only on the named results and only while non-empty). Token cost measured under *Open questions*. Reminder on in-game request events: K3. |
| 2. Kits | K (K1) | Built. `save_as`, `load`, `knowledge_list({kind: "kit"})`; `src/library/knowledge.ts` (`findKit`, `readKit`, `writeKit`, `parseKitEntries`). |
| 3. Candidates in a reply, wire | W (step W1) | Built. The four `candidates.*` kinds, the error `answered` and the `chat` `action` in `13` (*Request kinds*, `chat`), both codecs (`src/world/protocol/`, `mod/common/.../protocol/`: `Messages.Chat`, `UiMessages`), golden vectors, the fake host's `playerClick`, the fake MCP answering the kinds from its table. The MCP answers the kinds `bad_request` until Q serves them (`13`, *Implementation status*) |
| 3. Candidates in a reply, MCP | Q (Q1) | Sheet cells, `world_reply({candidates})` and `candidates.open` built (*MCP side* above): `src/library/candidates.ts` (`Candidates`, on `Session.candidates`), `prefab_sheet`'s record in `src/server/tools/library.ts`, `src/server/tools/world-prompt.ts`, the reply action through `InGameReplies.reply` and `clickable` (`src/world/prompt.ts`, `chat-stream.ts`; the request's text now kept on `OpenRequest`), `src/ui/candidates.ts` dispatched from `src/ui/requests.ts` and wired in `startUi`. Tests: `test/unit/ui/candidates.test.ts` (cells from the last sheet, explicit and `#n` cells, the clickable line and its click, plain text without `ui`, refusals that send nothing, `not_found`, `answered`, the id outliving its request), `test/unit/ui/ui-fake-host.test.ts`. `candidates.ghost`, `candidates.ghost.clear` (Q2) and `candidates.submit` (Q3) still answer `bad_request`. |
| 4. Candidates screen | V (V1) | Shared parts extracted (V1), behaviour unchanged: `ThumbnailGrid` (cards in a pane, `library.thumbnail` textures asked as cards come into view and freed on close; an abstract `Card` whose subclass gives title, selection, click and corner mark) and `OrbitPreview` (`library.preview` voxels meshed, laid out as a square in a pane, drawn with the drag-to-turn orbit camera), both in `mod/neoforge/.../client/ui/screen/`, used by `LibraryScreen`. Covered by the existing `library` and `preview` client suites, unchanged. Reply-line click and the screen: V2. *Preview here* and the menu entry: V3. |
| 5. Picks as text | Q | Not built |
| 6. Library editors in game | W (wire, step W2), E | Not built |
| 7. Save format | F (F1) | Built. `prefab_save({format})` with `schem`, `litematic`, `nbt`, `bp` in `src/library/prefabs.ts` (`savePrefab`, `PREFAB_FORMATS`), setting `library.prefabFormat` (group Library, live) beside it. Tests: `test/unit/library/prefab-formats.test.ts` (each format read back by stamp block for block, block entity kept except `.bp`, thumbnail, overwrite across formats, setting parse), `test/unit/server/library.test.ts` (format argument and setting default through the tools). |
| 8. Flash on save | W (wire, step W2), F | Not built |

## Deferred

- **Web sourcing.** Searching schematic sites and downloading builds into the library from a prompt. Deferred: needs research into which sites offer APIs and what their licences allow. Downloads would be handled as untrusted files.
- **A library button on the pause menu.** Dropped: the Autosketch menu already opens the library.

## Testing

- **MCP:** `component_set` (add, replace by label, remove, clear, unknown names with suggestions, save and load a kit, the reminder line only on the named results and only while the set has entries); stamp resolving a label before names and cells; `world_reply` candidates (default cells from the last sheet, the clickable line, the id's lifetime); `candidates.*` request handlers against the fake host; submit as a channel event on an open request and as a new request when closed; editor writes with hash conflicts (the recovered tests); `prefab_save` in every format, read back by stamp; the flash on save.
- **Wire:** golden vectors for the new `ui.request` kinds and results.
- **Mod, client half:** the candidates screen (grid, preview, tick and label, submit sends the request, reopen after submit shows answered); *Preview here* draws the ghost at the crosshair and replaces it; the editors (each kind, conflict reload, read-only roots offer copy).
- **End to end:** save a component in the world, search it in a fresh session, pick it through the screen, and check the agent receives the text and stamps it.

## Open questions

- **Reminder placement.** Is a line on search, sheet, stamp and in-game request text enough to survive summarising, or should it go on every result of a linked document while the set has entries? Measure the token cost before widening it.
  - *Measured (K2, 2026-11-18)*, on a cathedral set with two-word labels and library-style ids: 5 entries make a 148-character line (`set: corner tower = gothic_tower_a, gatehouse = gate_small, buttress = buttress_flying_a, rose window = rose_window_round, spire = spire_octagonal_b`), about 40–50 tokens; 15 entries make 430 characters, about 110–145 tokens. Estimated at 3–4 characters a token (underscore ids sit near 3), since no tokenizer is available offline; a count through the token-counting API would firm it up. On the current placement this is paid only on search, sheet and stamp results. Widened to every result of a linked document, a 15-entry set would add roughly 11–14k tokens over 100 tool calls. Placement not widened.
- **Candidates limit.** 24 fits one sheet page (6×4). Should a reply be able to carry more, paged like the sheet?
  - *Recommendation (Q1, 2026-11-18)*: keep 24 unless the end-to-end run shows otherwise. The default cells come from one sheet page, which holds 24, so a longer list would mix cells from several pages; and a player choosing among more than a page is better served by the agent narrowing the search first.

## Decisions

All settled with the user on 2026-11-17.

- **Component sets aren't tied to a build.** They are session context, so the player doesn't reselect or re-explain components in a busy session. They change only when the player says a choice was wrong or asks to reselect.
- **The set lives in the agent's context plus a small record on the MCP session**, not in the agent client's long-term memory. Reason: the session is where the set belongs; memory would bring old picks into unrelated builds; a session record works with any client and survives summarising.
- **Keeping a set is explicit**: the player asks, and it's saved as a kit pack in the library. Reason: nothing persists without the player meaning it, and kits are visible and editable in the library screen.
- **Search results open from a chat link into an in-game candidates screen**, and the player's picks go back to the agent as text, like a multiple-choice answer. Reason: the agent never opens a screen on its own, the player sees real models, and the agent stays in charge of what it understood.
- **Preview here is included**: one candidate as a ghost at the crosshair.
- **No ghost previews or approvals for automatic pastes.** Reason: undo is one step.
- **Library entries are fully editable by hand in the game**, not only reachable by agents. Editing a prefab's blocks is done by the stamp, edit, save round trip.
- **No pause-menu entry.** Reason: the Autosketch menu already reaches the library.
- **Web sourcing is deferred.**
- **Rejected: ghosts of every candidate lined up in the world.** Reason: cluttered and slow with several large candidates, and the player had already dropped ghost-based approval.
- **Rejected: a text-only candidate list in chat** as the main view. Reason: names and sizes don't show what a tower looks like. Typing picks in chat still works alongside the screen.
