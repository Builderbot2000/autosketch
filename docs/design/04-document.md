# 04 — Document Model

**One schematic per session.** Other schematics enter only as **prefabs** stamped from the library (`07`). A session may also hold **sandboxes**: isolated sub-documents forked from it for subagent jobs, addressed by `scope` id and merged back as a single journal entry (`11`).

## Session

```ts
interface Session {
  doc: Document;
  instance: InstanceContext;   // registry, palette index, plugins (02, 03, 09)
  library: Library;            // prefabs, palettes, knowledge packs (07)
}
```

Open a session with `doc_new({ size?, front? })` or `doc_open({ path })`. Opening another document closes the current one. The current one is saved automatically.

## Document

```ts
interface Document {
  meta: { name; front: Facing; dataVersion; seed; createdAt; source?: string };
  voxels: VoxelStore;          // block states
  blockEntities: Map<PosKey, NbtCompound>;
  entities: EntityRecord[];    // preserved on round-trip, not edited in v1
  components: ComponentGraph;  // semantic layer
  palettes: Record<string, NamedPalette>;
  journal: Journal;
}
```

### Voxel store

- Chunked into 16³ sections. Empty sections are not stored. In memory a section is a flat array of global state ids (8 KB). The native file stores each section as a local palette plus bit-packed indices.
- A global state table interns canonical state strings (`01`) as integer ids.
- Bounds grow on write, into negative coordinates if needed, and never shift existing coordinates while editing. Exports normalise them (`01`, `08`).
- Implementation: blocks are stored in internal "store" coordinates plus an `origin` offset, and journal entries use store coordinates, so a future explicit re-origin is O(1) and keeps undo valid.
- Expected scale: v1 targets builds up to about 512³ in bounding box with a few million non-air blocks.

### Component graph (semantic layer)

Named parts that let both the agent and the analysis refer to "the north tower" instead of coordinates.

```ts
interface Component {
  id: string;                  // "tower_ne"
  kind?: string;               // free-form: "tower", "wall", "roof", "window_bay", "prefab:oak_tree"
  region: Region | Mask;       // bounding box, optionally a voxel mask
  parent?: string;             // hierarchy: "keep" > "keep.roof"
  anchors: Record<string, Anchor>; // named points/faces: "top", "door", "front_face"
  tags: string[];
  notes?: string;
}
```

- Ops can register what they create with `as: "tower_ne"`. Prefab stamps register automatically.
- Analysis (`06`) can *propose* components (detected storeys, rooms, roof), which the agent may accept.
- Component regions are updated when ops transform them (move, rotate, mirror). Edits made by other ops inside a component do not change its region.
- Components are metadata only. Deleting one never deletes blocks unless `clear: true` is passed.

### Journal and checkpoints

- Every op is one **journal entry**: a sparse before/after diff (positions, old/new state ids, NBT), the op name, and its args.
- `undo` / `redo` with unlimited depth, memory capped: old entries are compacted to disk segments (Persistence) and survive reopening.
- **Checkpoints:** `checkpoint({ name })` and `restore({ name })`. These are cheap named markers in the journal. The agent should checkpoint before risky multi-step work. The server instructions recommend it.
- `history()` returns a terse op list for the agent to orient itself after context loss.

## Persistence

```
<workspace>/
  <doc-name>/
    doc.autosketch       # native format: gzip NBT (voxels, NBT, components, palettes, meta)
    journal/             # journal segments (<firstSeq>-<lastSeq>.seg) + index.json
    exports/             # last exported .schem/.bp/.nbt (08)
```

- The workspace defaults to `~/autosketch/`, configurable.
- Autosave after each op (debounced). A crash loses at most the last op.
- The native format is a superset of what the export formats can hold (components, palettes, journal). Exports are lossy views of it.

### Journal segments

- The history is a chain of entries. Memory holds a contiguous **window** of it. Each save appends the entries not yet on disk to `journal/` as an immutable segment, merging into the last segment while it is under about 4 MB, then rewrites `index.json` (segment list in history order, next sequence number, checkpoints). The journal is written before `doc.autosketch`, whose `Meta.JournalHead` names the last applied op.
- Segments name block states by string, with their own small table, because the document's state table is renumbered on every save.
- **Memory bound:** when the window passes the cap, it is persisted, then entries furthest from the undo point leave memory (never the one undo needs next). Undo or redo past the window loads the neighbouring segment back. Without a store (a document never saved in the workspace) the old behaviour stays: the oldest entries are dropped.
- **Reopen:** `doc_open` attaches the segments and puts the undo point at `JournalHead`. Nothing is read until undo, redo or `history()` needs it. If `JournalHead` isn't in the chain (the journal and document disagree after a crash or a foreign save), history starts fresh and the next save replaces the folder.
- A new edit after undo discards the redo tail on disk too, rewriting a segment that also holds kept entries.
- Imports (`doc_open({path})`) and `doc_new` start a fresh journal folder. Only files named `doc.autosketch` (the workspace layout) persist a journal; `saveNative`/`loadNative` take `journal: boolean` to override.
- Checkpoints are saved with the index. Creating one doesn't bump the revision, so it reaches disk with the next save.

## Implementation status

| Piece | Status |
|-------|--------|
| Voxel store, components, journal, checkpoints | Built (`document/`). |
| Native format | Built (`native.ts`), including `JournalHead`. |
| Journal persistence | Built (`journal.ts`, `journal-store.ts`): segments, memory window with load-back, history across reopen, redo-tail discard on disk, mismatch fallback. Synchronous file I/O: undo and redo are synchronous. |
| Sandboxes (`11`) | Not built here (silo F). |

## Open questions

- Should components support boolean masks from the start, or only boxes in v1? (Proposal: boxes plus optional masks generated by ops.)
- Does entity editing (armor stands, item frames) ever matter for builds? Defer.
