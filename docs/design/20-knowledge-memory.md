# 20 — Knowledge packs as long-term memory

The agent can read, record and manage knowledge packs, so the player's build tastes and the long-running facts of their projects carry from one session to the next. Memory is the existing library (`07`): plain markdown files that the player owns, can see and can edit in the game. No other store is added.

Status: designed with the user 2026-11-28 (*Decisions*). Not built. Builds on `07` (library, knowledge packs), `15`/`17` piece 6 (hash-checked writes, trash, in-game editors) and `13` (in-game requests).

## Decisions

Settled with the user on 2026-11-28.

- **The agent writes only when the player asks.** "Remember that I like steep roofs", "add that to my gothic style" and "forget the note about the harbour" are requests. A taste the agent notices but the player didn't ask to keep stays in the conversation. Reason: as in `17`, nothing persists unless the player means it. This is a rule in the tool descriptions. The server can't check intent, so it doesn't try.
- **Recall gives summaries, not bodies.** At the start of a session the agent receives one line per preference and note pack (name, tags, summary) and reads full packs with `knowledge_read` when they matter. Reason: the cost stays small and fixed as the library grows, and the agent still knows what exists without having to think of looking.
- **One global library, with context in tags.** Packs live in the user's writable library root. Tags such as `world:<name>`, `style:<name>` or `instance:<name>` say where a pack applies. The agent weighs them (*advise, don't constrain*), and the server filters only when a tool's `tags` argument asks it to. Reason: no new storage, and one place for the player to curate.

## Principles

1. **Advise, don't constrain** (`07`). A preference is advice for the agent to weigh against the current request. The server never refuses or changes an op because of one.
2. **List, don't interpret.** Recall lists what is saved, with its tags. The server doesn't judge whether a pack applies to this build.
3. **The library belongs to the player.** Every pack the agent writes is a file the player can open, edit, rename or delete in the in-game library (`17` piece 6). Hand edits are never overwritten (*Writes*).
4. **Model-agnostic** (`14`). Memory is reached through MCP tools and tool results, not through any one client's memory or features.
5. **Documents stay transient** (`04`). Notes about a single document's work in progress are out of scope (*Deferred*). This spec covers what outlives a document.

## Kinds

Two kinds are added to `style | heuristic | technique | skill | kit`:

| Kind | Folder | Holds | Example |
|---|---|---|---|
| `preference` | `knowledge/preferences/` | The player's tastes and standing instructions | "Roofs: steep, 45° or more; dark oak trim; no glass on north faces" |
| `note` | `knowledge/notes/` | Long-term facts: ongoing projects, decisions made, plans | "Harbour town (world:craftoria): east wing next; palette `harbour` agreed" |

`note` is already the kind given to a file with no folder (`src/library/knowledge.ts`). The folder makes it explicit. The starter library ships no preferences or notes.

The agent can also write the existing kinds when the player asks ("save this as a technique", "add to my gothic style"). Kits are still written only through `component_set({save_as})` (`17`), because their `entries` block is structured.

## Tools

All three work across documents and need no open document (`doc: false`).

### `knowledge_read` (changed)

Its output now starts with a header line, `hash:<sha256> root:<label> editable:<bool>`, followed by the file. The hash comes from `entryHash`. A replace sends it back (*Writes*).

### `knowledge_save` (new)

```
knowledge_save({ name, text?, summary?, tags?, kind?, mode?, section?, hash? })
```

- `name`: the path under `knowledge/`, such as `"preferences/roofs"`. A bare name goes into the folder for `kind` (default `note`).
- `mode`:
  - `create` (default): refused if the name exists in any root.
  - `append`: adds `text` at the end of the body, or at the end of the `## <section>` heading, which is created if missing. Needs no hash, because it never removes the player's text. This is the common case: "remember that too".
  - `replace`: writes the whole body. Needs `hash` from `knowledge_read`.
- `summary` and `tags` update the frontmatter in any mode, and other frontmatter keys are kept. `create` needs a summary, because recall shows summaries.
- Writing over a pack from a read-only root (the starter library or Axiom) first copies it into the writable root (`copyToLibrary`), where the copy shadows the original (`07`, *Roots*). The result says so.
- Result: the file, the mode, the new hash, and the pack's line as `knowledge_list` prints it.
- The description says: *"Only when the player asks to remember, record or change something. Don't save tastes you inferred."*

### `knowledge_manage` (new)

```
knowledge_manage({ action: "delete" | "rename" | "restore", name, to? })
```

- `delete` moves the pack to the root's `.trash/` (`deleteEntry`). It can be recovered from the in-game library or with `restore`. The description gives the same rule as `knowledge_save`: only when the player asks.
- `rename` uses `renameEntry`. A different folder in `to` changes the kind the folder implies.
- `restore` takes a name or trash id (`listTrash`, `restoreEntry`).
- Writable root only. A read-only root is refused with the message the library UI already gives.

## Writes

- **Atomic and hash-checked** through `writeEntryText` and `EntryChangedError` (`src/library/manage.ts`), as the in-game editors do. A `replace` whose hash no longer matches is refused with "changed since you read it (the player may have edited it); read it again". `append` re-reads the file just before writing, so it never loses a hand edit made in between.
- **No extra confirmation step.** The player asked, and the tool result names the file and the change. If the in-game library screen is open, it gets a `library.changed` push (the existing refresh path), so the edit shows up at once.
- **Size guard.** A pack over 8k characters is still saved, with a warning suggesting a split. Recall shows summaries only, so a large body costs nothing until it is read.

## Recall

- **A `library:` note on the session's first tool result**, added through the session's call hooks the same way the `world:` notes are (`src/server/session.ts`, `callHooks`). It lists one line per `preference` and `note` pack in the formatted-list form (`name [kind] (tags): summary`), newest first, then the line *"Saved preferences and notes. Advice to weigh, not rules. knowledge_read({name}) for one."*
- **A cap.** At most 40 lines, about 1k tokens. Above that, the note ends with "+n more: knowledge_list({kind})".
- **Changes later in the session.** When a preference or note pack the agent didn't write itself changes on disk (for example, edited by hand in the game), the next tool result carries a short `library:` line naming it. The check is cheap, because entries are already re-read on each library call (`07`). The hook compares a name→hash map against the one from the last note.
- **Why not the server instructions.** They are fixed when the client connects, and some clients summarise or drop them. A tool-result note works with any client and reflects the library at that moment. It also leaves `07`'s rule untouched: the server never names or injects **skills**. Recall covers `preference` and `note` only.
- An empty library gives no note.

## Changes to other specs

- `07`: kinds table (`preference`, `note`), folders in *Layout*, `knowledge_save`/`knowledge_manage` in *Implementation status*, and the `knowledge_read` header.
- `17` piece 6: the in-game editor already covers every knowledge kind. No change beyond listing the two folders.
- The `knowledge_list` `kind` description gains `preference | note`.

## Steps

| Step | Side | Piece |
|---|---|---|
| M1 | MCP | `knowledge_save` and `knowledge_manage`, plus the `knowledge_read` header, in `src/library/knowledge.ts` and `src/server/tools/library.ts`, reusing the `manage.ts` writes. Tests: each mode, hash conflict after a hand edit, append under a section, shadowing copy from the starter root, trash round trip. |
| M2 | MCP | Recall hook: the first-result note, the cap, change lines after hand edits. Tests: an empty library adds no note; the cap; a hand edit reported once; the agent's own writes not reported back. |
| M3 | Docs | `07` updates. A starter **skill** `skills/memory.md`: when to offer to remember something (offer in words and never save unasked), how to choose between preference and note, and tag conventions. The player can edit or delete it like any skill. |

## Deferred

- **Per-document notes** (plans tied to one document's work in progress). They belong with the document (`04`) and go when it does. Separate spec.
- **Agent-initiated saving.** Rejected for now (*Decisions*). An *offer* in words ("want me to remember that?") is allowed, because it is just conversation.
- **Search inside pack bodies.** `knowledge_list` matches kind and tags only. Add word search if recall at 40 lines proves too coarse.

## Open

- Should `world:<name>` tags match automatically when the session is linked to that world, for example by listing matching packs first in the recall note? That would be ordering only, not filtering. It is a cheap measurement, so it doesn't break *list, don't interpret*, but it needs the world's name from the link.
