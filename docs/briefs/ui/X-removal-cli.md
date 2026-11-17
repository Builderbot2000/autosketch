# Silo X: Removal and CLI

**Wave 2**, once M's move of `model.js` and `replay.js` merges. Mostly deletion; the one new behaviour is automatic instance choice.

**Specs:** `16` (*What goes, what stays, what moves*, *Command line*), `14` (*Instance discovery*, pointer files), `12`, `13`, `15`.

## Goal

The browser UI and everything that only served it are gone, the command line handles startup alone, and the docs say so.

## Deliverables, in merge order

1. **Delete** `viewer/` (page, 3D view, panels, tabs, CSS, `voxels.js`), `src/observe/atlas.ts`, `open.ts`, `instance-api.ts`, `voxels.ts` if only the viewer used it, `src/server/instance-host.ts`, `src/server/ui-command.ts` (`autosketch ui`), `autosketch observe`, the `three` dependency and `/vendor/three/`, and their tests (`viewer.test.ts`, `ui.test.ts`, `ui-command.test.ts`, `offline.test.ts`, `instance.test.ts` where they only test removed code). `observe.open` removed from the settings, so a value in `config.toml` is reported as unknown. Check with a search that nothing else imports what you delete before deleting it.
2. **Automatic instance choice:** with no instance saved, pick one when exactly one candidate is found (preferring games that wrote a pointer file), say so on stderr and in the first tool result; otherwise the first tool result lists the candidates and the `autosketch setup --instance` command. No wizard.
3. **Docs:** `12` (*Live viewer* section points to `16`), `13`, `14`, `15` (marked superseded by `16`), `README.md` (no browser, `autosketch ui` and `observe` gone), `world/test-setup.md` (checklist items H now automates), and the release briefs' *Release gate*, which names K's U4 wizard: replace it with automatic instance choice.
4. Measure what went (lines removed, dependencies removed, package size before and after) and record it in `16`'s *Cost*.

## Files you own

- Everything deleted above; `src/server/index.ts` (removals and the instance message); `src/core/settings.ts` (`observe.open` only); `package.json` (`three`); the doc sections listed in deliverable 3.

## Done when

- `npm run typecheck`, `npm test` and `npm pack --dry-run` pass, and the packed file list has no `viewer/` or `three`.
- Unit tests for automatic instance choice: one candidate picked and reported; one with a pointer file preferred over one without; several listed with the setup command; none says how to set one.
- A search for `viewer`, `autosketch ui`, `autosketch observe` and `observe.open` finds only `16`'s history and *Decisions*.
