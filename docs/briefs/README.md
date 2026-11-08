# Work briefs for agent teams

One brief per silo of unfinished spec work, as of commit `5f94416` (2026-11-07). Each team reads this README first, then its own brief, then the design docs the brief cites. The design docs (`docs/design/NN-*.md`) are the source of truth. A brief only scopes, sequences and assigns files.

| Silo | Brief | Wave | Depends on |
|---|---|---|---|
| A | [Transforms and edit completion](A-transforms-edits.md) | 1 | — |
| B | [Perception](B-perception.md) | 1, then 2 | semantic selections after A merges |
| C | [Generators, anchors, scripting](C-generators-scripting.md) | 2 | A |
| D | [Library](D-library.md) | 1 | prefab rotate/mirror after A |
| E | [Mod-compat plugins](E-plugins.md) | 1, then 2 | actions after A |
| F | [Scoped sessions](F-scoped-sessions.md) | 3 | A (auto-connection), B (ghost render) |
| G | [Observability](G-observability.md) | 1, then 3 | phases 3–5 after F |
| H | [Formats and assets loose ends](H-formats-assets.md) | 1 | — |
| I | [Test tiers](I-test-tiers.md) | 1, then 3 | eval tier last |

A wave starts when the previous wave's dependencies have merged. Within a wave, teams run in parallel.

## Rules for every team

**Branching.** Branch from `feat/assets` at or after `5f94416`, one branch per silo (`silo/<letter>-<slug>`), ideally in its own worktree. Rebase on `feat/assets` before asking for a merge. Merge small, coherent steps rather than one large branch at the end.

**Stay in your files.** Each brief lists the files the silo owns. Create new files freely inside your own areas. For a file another silo owns, keep the change minimal and additive (a new optional field, a new export), and say so in the merge request. The contested files are listed below.

**Tools.** MCP tools live in `src/server/tools/`, one module per area, registered in order in `tools/index.ts`. Add your own module (e.g. `tools/library.ts`) and one line in `index.ts`. Do not grow another silo's module. `server/` stays a thin adapter: all logic goes in the layer below, so scripts and tests use the same functions.

**Conventions** (`docs/design/01-conventions.md`): document-local coordinates, inclusive boxes in the public API and half-open internally, canonical block states, unknown blocks never dropped. Every op goes through `doc.edit(op, summary, tx => …)`, so it is one journal entry and undoable. Op results follow the result contract in `05` (terse text: what changed, count, box, warnings).

**Design principles** (`docs/ARCHITECTURE.md`): shrink before showing, text first, images on demand, and every tool description carries a token-cost hint. *Advise, don't constrain:* heuristics and styles are retrievable suggestions and the server never enforces them. The only hard limits are mechanical ones the specs name (sizes, sandbox volumes, nesting).

**Code style.** TypeScript ESM, Node ≥ 22, `strict` with `noUncheckedIndexedAccess`, relative imports ending in `.js`. Match the surrounding code: small exported functions, a doc comment that cites the design doc section, no new abstractions without a second user.

**Done means:**
- `npm run typecheck` and `npm test` pass.
- New behaviour has unit tests in `test/unit/<area>/` with exact block-level assertions where it edits blocks.
- The design doc's *Implementation status* table is updated to match what was built (add the table if the doc has none). Open questions you resolved are moved into the body with the answer and the reason.
- Nothing derived from game or mod assets is committed (`02`, *Legal stance*). Fixtures are original builds or synthetic.
- Commit messages end with the attribution line used in this repo's history.

**Decisions you should not make alone.** Changes to the dependency rules in `ARCHITECTURE.md`, to the conventions in `01`, or to any tool's existing name or argument shape. Raise them with the user rather than working around them.

## Contested files

| File | Who touches it | Protocol |
|---|---|---|
| `src/ops/selection.ts`, `selSchema` in `src/server/tools/shared.ts` | A (wave 1), then B (wave 2) | A owns them in wave 1. B adds its semantic cases after A merges |
| `src/document/document.ts` | A (component transforms), G (event sink), H (journal persistence), F (sandboxes) | Additive changes only, kept small. Rebase often |
| `src/plugins/types.ts` | A adds `rotate?` and connection hooks in wave 1, E extends in wave 2 | A's fields are optional and land first |
| `src/server/session.ts`, the `tool()` wrapper in `server.ts` | D (resource registration), F (scope addressing) | D's small change lands early in wave 1. F's lands in wave 3 |
| `package.json` | C (quickjs), G (none expected), I (scripts) | Trivial conflicts: rebase and re-run `npm install` |

## Unverified items (no in-game checks planned)

These would need someone in-game, and that is not planned. Don't wait on them or ask for samples. Work from the best evidence available (the mods' public source, existing behaviour), keep the uncertain part isolated in one place, warn where the specs already say to, and leave the item marked unverified in the spec:

- How Axiom `.bp` stores block entities and entities. Keep the current behaviour: leave them out on write, with a warning pointing to `.schem`.
- Whether Axiom accepts an Autosketch-written blueprint, and which folder Axiom reads `.schem` from. Keep the current targets.
- The Craftoria server's real `maxTotalSchematicSize`. Keep reading the local config, defaulting to 256 KB.
- FramedBlocks and Copycats camo NBT layout (silo E).

## Later sets

- [Live world link and companion mod (`13`)](world/README.md): silos L, N, O, P, Q, R.
