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

**Reminders.** The set is in the agent's context from the moment it's made, but long sessions get summarised. While the set is not empty, one line (`set: corner tower = gothic_tower_a, gatehouse = gate_small`) is appended to the results of `prefab_search`, `prefab_sheet` and `stamp`, and to the text of each in-game request's channel event (`13`, *Prompting from the game*). Those are the moments the agent is choosing or placing components. Other tool results don't carry it, to save tokens.

**Resolving by label.** `stamp({prefab: "corner tower"})` resolves a set label to its prefab before resolving library names and sheet cells. This is a convenience, not a constraint: any library prefab can still be stamped by name.

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

### 3. Candidates in a reply (MCP and wire)

`world_reply` takes an optional `candidates`: up to 24 entries `{ prefab, cell? }`. The cell defaults to the cell the prefab had on the last `prefab_sheet`, so the screen and the agent use the same ids. The MCP stores the list under a candidates id, valid while the request is open and for the rest of the session after it. It appends one clickable line to the reply. The click runs a client action, as replay's log lines do, and the client sends `ui.request` `candidates.open {id}`.

New `ui.request` kinds (feature `ui`, `16`, *Wire additions*):

| Kind | Answer |
|---|---|
| `candidates.open {id}` | The list: per entry, cell, prefab name, root, size, tags, notes; plus the open request id and question text |
| `candidates.ghost {id, prefab, at, rotate?}` | Shows one prefab as the session's candidate ghost at `at` (world coordinates); replaces any earlier candidate ghost |
| `candidates.ghost.clear` | Removes it |
| `candidates.submit {id, picks: [{prefab, cell, label?}], note?}` | Sends the picks to the agent as text (*Picks as text*) |

Thumbnails and the 3D preview reuse `library.thumbnail` and `library.preview`. The schemas and golden vectors go into `13`'s *Message schemas*, as for the other `ui` messages.

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

### 8. Flash on save

When `prefab_save` runs on a linked document, the saved box is sent as a change flash (`ui.flash`) in a fixed colour, so the player sees what was saved without an approval step. If it's wrong, the player says so, and the agent saves again with `overwrite`.

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
- **Candidates limit.** 24 fits one sheet page (6×4). Should a reply be able to carry more, paged like the sheet?

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
