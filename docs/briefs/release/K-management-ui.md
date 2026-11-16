# Silo K: Management UI

**Waves 1 and 2.** Starts once J's `config.toml` store and settings layer merge. U4 needs J's discovery and `loadInstance`.

**Specs:** `15` (all of it), `12` (*Live viewer*, *Packaging*, *Settings*), `13` B3 (token spend), `07` (library roots and entries), `03` (`palette_edit` operations).

## Goal

The viewer becomes the user's one UI for the MCP: an app with Observe, Settings, Library and Instance tabs, on the same localhost server, guarded for writes. It's also the setup wizard on first run. The agent never reads it and sees only the effects of what the user changes there.

## Deliverables, in merge order

1. **U1: app shell and security.** Tabs around the existing viewer, which becomes the Observe tab unchanged. Each tab is a separate ESM module loaded when first opened; no build step. `/api` routing in `src/observe/http.ts`. A per-launch token in the URL fragment (`#t=…`), kept in `sessionStorage` and sent as `X-Autosketch-Token`; an `Origin` check; writes only through POST/PUT/DELETE; the token also written to `observe/<session>/url`.
2. **U2: Settings tab.** Generated from the registry through J's `resolve()`: control type from the parser, effective value, source, any overridden launch value ("launch command sets …; ignored"), *restart needed*, *Reset*. Watch `config.toml` and reload on change. `PUT`/`DELETE /api/settings/<key>` through J's compare-and-set write. Fill in `summary` and `group` for the existing settings.
3. **B3: token spend.** The OTLP/HTTP JSON receiver at `/v1/logs`, each record appended unchanged as an `otel` event (so replay has it); per-prompt totals by token type with `cost_usd`; per-action labels by matching autosketch `tool_result` events to `call.end` (`13` B3 has the method); per-job spend by `agent_id` in the scope tree; a notice when no OTLP data has arrived, linking the setup snippet. Confirm the two *to confirm* points in B3 and record them in `13`.
4. **U4: Instance tab and the setup wizard.** Current instance, source, registry status and link status (read-only); the discovered list and a folder field; choosing writes `instance` through J's store and calls `loadInstance` when nothing is loaded; *Unlink instance* removes it (`DELETE /api/instance`). Open on this tab at startup when J's hook says no instance is remembered, with a launch `--instance` shown first, marked as the launch value.
5. **U3a: Library tab, browsing and actions.** `library.roots`, `library.starter`, `library.axiom`, `library.hidden` as settings (`AUTOSKETCH_LIBRARY` kept as an alias), in `src/library/roots.ts`. Roots table; per-kind lists with origin, shadowing and hidden flags; prefab thumbnails and 3D preview with the Observe renderer; rename, duplicate, delete to `.trash/<timestamp>/`, restore, empty trash, copy to my library, hide. Entries addressed as `<root label>/<kind>/<name>`, never raw paths; refuse anything resolving outside its root.
6. **U5: `autosketch ui`.** The same app with no MCP session, prints the URL, opens it unless `--no-open`; Observe lists finished logs as `autosketch observe` does.
7. **U3b: Library editors.** `prefab.json` fields, palette roles and weights (reuse `palette_edit`'s functions), procedure and knowledge text in a plain `<textarea>`. Every write sends the file's hash and gets a 409 on a mismatch.

## Files you own

- `viewer/**`, `src/observe/http.ts` and new modules beside it (for example `src/observe/api/**`, `src/observe/otel.ts`), `src/library/roots.ts`, tests in `test/unit/observe/` and `test/unit/library/`.
- Shared: `core/settings.ts` (per-setting `live` marks and summaries), `server/index.ts` (one `ui` case).

## Done when

- A write without the token, with a foreign `Origin`, or through GET is refused; the page opened from the printed URL can write.
- Saving a setting in the UI writes `config.toml`; `autosketch config set` on the same key shows in the open UI; a key also given on the launch command shows as overridden.
- A conflicting library write (file changed since the UI read it) returns 409 and leaves the file as the agent wrote it.
- Delete then restore returns an entry byte-for-byte; `.trash/` never appears in `prefab_search`, `palette_list` or `knowledge_list`.
- A path like `../../etc` in an entry address is refused.
- A recorded OTLP batch (synthetic, from the documented event shapes) gives the expected prompt total and per-action labels, including after replay.
- The wizard opens at startup only with no remembered instance; choosing loads in place; unlink makes it open on the next start.
- The Observe tab's behaviour and load cost are unchanged (no extra requests until another tab is opened).
- `15`'s phases U1–U5 and `13`'s B3 have *Implementation status* rows.
