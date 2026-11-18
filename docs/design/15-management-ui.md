# 15 — Management UI

The live viewer (`12`) grows into the user's general UI for the MCP: one localhost page with tabs for watching a build, changing settings, managing the library (`07`) and choosing the instance, including first-run setup (`14`). Players who aren't developers can then run Autosketch without editing environment variables or JSON.

> **Superseded by `16` entirely** (2026-11-17). The browser UI is removed: instance choice is command-line only, with automatic choice when exactly one candidate is found (`16`, *Command line*); Settings and Library are in-game screens (`16`, *Settings screen*, *Library screen*); Observe is overlays, ghosts and replay in the world. `viewer/`, `autosketch ui`, the Instance tab's server side (`src/server/instance-host.ts`), the setup wizard and `observe.open` are deleted; the Settings and Library endpoints are being rewritten as bridge request handlers (`16`, *MCP side*), reusing `core/settings.ts`, `library/manage.ts` and `library/roots.ts` unchanged. This document is kept as the record of what was built and why; read `16` for the current design.

Status: superseded by `16`. Everything in *Implementation status* was built and its browser half has been removed; the `config.toml` settings layer, the settings metadata (`summary`, `group`, `applies`) and the library management in `src/library/` remain in use.

## Principles

1. **For the human, never the model** (from `12`). No tool reads the UI, and nothing shown there is returned to an agent. The agent sees the *results* of what the user changes, through what it already reads: library files on its next call, settings as behaviour.
2. **Files stay the source of truth.** The UI edits the same files a user could edit by hand (`~/.autosketch/config.toml`, the library folders). It keeps no state of its own, and anything it does can be done without it.
3. **The UI has priority, and shows what it overrides.** What the user saves in the UI (or with the `autosketch setup` and `autosketch config` commands, which write the same file) wins over the server's launch command and environment. A launch value that loses is never dropped silently: its row says what was ignored and where it came from (settled 2026-11-16).
4. **Never slows the build** (from `12`). UI requests are served off the tool-call path, and no op waits for the UI.
5. **Local, and guarded where it writes.** Loopback only, as today. Every request that changes something carries a per-launch token (*Security*).

`12`'s second principle, *read-only*, still holds for observability itself: the event stream, deltas and observe panels never mutate anything. The writing parts are the Settings, Library and Instance tabs, which go through their own endpoints.

## App shell (settled 2026-11-16)

The page served at the viewer URL becomes an app with four tabs. The current viewer becomes the first one, unchanged.

| Tab | Contents | Needs a live session |
|---|---|---|
| **Observe** | The viewer from `12` (3D view, scope tree, feed, timeline, activity map, replay) | Yes. Without one it lists recent session logs to replay |
| **Settings** | Every server setting, generated from the settings registry | No |
| **Library** | Library roots and their prefabs, palettes, procedures and knowledge packs | No |
| **Instance** | The instance in use, how it was found, discovered alternatives, live link status | No |

- **Same server, same setting.** It runs on the HTTP server `src/observe/http.ts` already starts, still turned on and off by `observe.http` and opened by `observe.open`. Renaming those keys isn't worth breaking existing configs.
- **Standalone: `autosketch ui`.** A subcommand of the existing bin, beside `autosketch observe`, serves the same app with no MCP session, so the library and settings can be managed between sessions. It prints the URL, opens it unless `--no-open`, and runs until interrupted. Observe there opens finished logs, like `autosketch observe`.
- **No build step** (as `12`, *Packaging*): plain ESM in `viewer/`, with the tabs as separate modules loaded when first opened, so the Observe tab costs nothing more than today.

## Settings tab (settled 2026-11-16)

**A new layer: `config.toml`, first.** Settings are read today from `--set`, a flag alias, `AUTOSKETCH_<KEY>`, then the default (`12`, *Settings*). The UI needs somewhere to write, and `14` already plans `~/.autosketch/config.toml` for `setup`. Settings go into a `[settings]` table there, and the file comes **before** every other source (settled 2026-11-16):

```
config.toml [settings]  >  --set <key>=<value>  >  flag alias  >  AUTOSKETCH_<KEY>  >  default
```

- **One store, two ways to change it.** The UI and the command line (`autosketch setup`, `autosketch config set <key> <value>`, `autosketch config unset <key>`, `14`) edit the same file, so a change made either way shows in the other. The UI watches the file and reloads when it changes.
- **Launch values are fallbacks.** `--set`, flag aliases and `AUTOSKETCH_*` given in the MCP client's config still apply to every key `config.toml` doesn't set, so `claude mcp add … -- npx -y autosketch --instance <path>` keeps working with no setup step.
- **Conflicts are shown in the UI only.** When a launch value loses to `config.toml`, the setting's row says so ("launch command sets `observe.snapshots=off`; ignored, config.toml says `merge`"), and the server's log on stderr says it once at startup. No tool result mentions it (principle 1).
- Reason: the user wants the UI to be the one place settings are decided. A launch value buried in an MCP client's config should not silently beat what the user chose on screen.

```toml
# ~/.autosketch/config.toml
instance = "C:/Users/me/curseforge/minecraft/Instances/Craftoria"

[settings]
"observe.snapshots" = "merge"
"scope.maxDepth" = 2
"library.roots" = ["~/autosketch/library", "~/shared/castle-kit"]
```

Values are stored as text and go through each setting's own `parse`, so a hand-edited file and the UI agree on what's valid. A number, boolean or list in the file is read as the text a launch value would carry (a list becomes `a, b`). An invalid value in the file is reported in the UI and the server log and skipped, so the next source applies: the launch value if there is one, else the default. Reason: a hand-editing mistake should fall back to what the user had before saving, not to a value nobody chose. Only invalid `config.toml` values are skipped: an invalid launch value (a `--set`, flag alias or `AUTOSKETCH_*` value) still stops the server, as today, since it is a mistake in the MCP client's config, which the user sees at once.

**Generated, not hand-written.** Each `setting(…)` gains three optional fields, and the tab is built from the registry, so a new setting appears in the UI with no UI change:

| Field | Meaning |
|---|---|
| `summary` | One line shown under the control |
| `group` | Section heading (`Observe`, `Scopes`, `Assets`, `Library`). Defaults to the key's first segment |
| `applies` | `"live"` (read on each use) or `"restart"` (read at startup). Defaults to `"restart"` |

The control follows the parser: a toggle for `parseBool`, a select for `parseOneOf`, a number field with bounds for `parseInt0`, a list editor for `parseList`, a text field otherwise.

**Each row shows** the effective value, its source (`config.toml`, `command line`, `environment: AUTOSKETCH_SCOPE_MAX_DEPTH`, `default`), any launch value it overrides (above), and a *restart needed* note when a saved value differs from the running one. No control is ever locked. *Reset* removes the key from `config.toml`, so the launch value (or the default) applies again.

**Live versus restart.** Settings are read once at startup today. A setting marked `live` must be read through the `Settings` object on each use, which re-reads `config.toml` when the file changes. A setting is marked `live` only once its code does that. Everything starts as `restart`, and settings move over one by one.

**Library settings.** Library roots come from `AUTOSKETCH_LIBRARY`, read directly in `src/library/roots.ts` (`07`, *Roots*), not through the registry. They become settings so the UI can show them:

| Setting | Default | Meaning |
|---|---|---|
| `library.roots` | `<workspace>/library` | User roots in order; the first is writable. `AUTOSKETCH_LIBRARY` keeps working as an alias |
| `library.starter` | `true` | Include the starter library |
| `library.axiom` | `true` | Include the instance's Axiom blueprints as a root |
| `library.prefabFormat` | `schem` | Format `prefab_save` writes when the call gives none: `schem`, `litematic`, `nbt` or `bp` (`17`, piece 7) |
| `library.hidden` | none | Entries to leave out of every listing, as `<kind>/<name>` (`prefabs/park_bench`), so a starter or Axiom entry can be hidden without deleting it. Applies to read-only roots only (settled with the user 2026-11-16): a copy made with *copy to my library* has the same name and must stay visible; entries in a writable root are deleted (to trash) instead |

## Library tab (settled 2026-11-16)

**Roots.** One row per root in search order: label, path, kind, writable or read-only, entry counts, with a link that opens the folder in the OS file manager.

**Entries.** One list per kind (prefabs, palettes, procedures, knowledge), filterable by text and tag. Each entry shows the root it comes from. An entry that shadows another root's entry of the same name says so (`overrides starter: park_bench`), and so does a hidden one.

| Kind | Shown | Editable (writable root) |
|---|---|---|
| Prefab | Thumbnail grid (the cached `prefab_sheet` thumbnails), and a 3D preview using the Observe tab's renderer and atlas | `prefab.json` fields: name, tags, front, notes, anchors, roles |
| Palette | Roles with each member's texture from the atlas and its weight | Weights, add or remove members, rename roles (the `palette_edit` operations, `03`) |
| Procedure | Header (summary and `@param` lines) and the source | Source, in a plain text editor |
| Knowledge pack | Frontmatter fields and the rendered Markdown | Frontmatter and text, in a plain text editor |

**Built in two steps** (settled): browsing and the actions below first, then the editors in the *Editable* column. Each step is usable on its own.

**Actions.**

- In a writable root: *rename* (checked against `ENTRY_NAME`, `07`), *delete*, *duplicate*.
- In a read-only root (starter, Axiom): *copy to my library*, which writes the entry into the first writable root under the same name, so it shadows the original and can then be edited. And *hide*, which adds it to `library.hidden`.
- **Delete is recoverable.** Deleted entries move to `<root>/.trash/<timestamp>/` rather than being removed. Listings skip `.trash/`, and the tab offers *restore* and *empty trash*.
- Editing the blocks of a prefab is out of scope. That is document work (`04`, `05`), done by the agent or by opening the file in Axiom.

**Concurrent edits.** The agent can write the same files while the UI is open (`prefab_save`, `palette_save`). Every UI write sends the hash of the file it started from, and the server refuses it with a conflict if the file has changed since, so the UI reloads instead of overwriting. Writes are whole-file: a temporary file, then rename. The server already re-reads library entries on each call (`07`, *Implementation status*), so the agent sees UI edits on its next call with no notification.

## Instance tab and first-run setup (settled: the UI may do first-run setup)

**Shown:** the instance in use (pack name, folder, Minecraft version, loader, mod count), how it was chosen (command line, environment, `config.toml`, or none), the asset registry status (`02`), and the companion mod's link status (`13`: connected or not, world, pairing), read-only. The mod's own settings stay in its Cloth Config screen (`14`), not here.

**Choosing.** The tab lists what discovery found (`14`, *Instance discovery*, the same list `autosketch instances` prints) and offers a folder field for anything else. Choosing one writes `instance` to `config.toml`, exactly as `autosketch setup --instance` does.

**Setup wizard: the UI first, then remembered** (settled 2026-11-16, reversing `14`'s "no graphical wizard"):

- **When the server starts with no instance remembered** (no `instance` in `config.toml`), it opens the UI on the Instance tab at once, as a setup wizard. This is the one exception to opening the viewer on the first tool call (`12`): the server has nothing useful to do until an instance is chosen. The HTTP server starts with it, since the viewer already works without an instance (flat colours, `12`). `observe.open=false` still stops the browser opening.
- **A launch `--instance` is offered, not imposed.** If the launch command or environment names an instance, the server loads it meanwhile so tools work, and the wizard shows it first, marked as the launch value, ready to keep with one click. Keeping it, or choosing another, writes `config.toml`.
- **Remembered until unlinked.** Once `config.toml` names an instance, later starts load it with no wizard, and the viewer opens on the first tool call as usual. The Instance tab's *Unlink instance* (and `autosketch config unset instance`) removes it, so the next start shows the wizard again. This is about which Minecraft instance the MCP reads assets from. It is separate from the live world link (`13`).
- **No restart for the first choice.** With nothing loaded there is nothing to tear down, so the server loads the chosen instance in place and the tools start working. Switching away from a loaded instance writes `config.toml` and needs a restart, because the registry, atlas and open documents are built on the old one.
- Until an instance is loaded, tools answer `not_configured`, and the answer gives the UI's URL as well as the `setup` commands, so the agent can point the user at either.
- In an environment with no browser (SSH, a container), `observe.open` fails quietly as today, and the `not_configured` answer carries the `setup` command.

## Security (settled 2026-11-16)

The viewer only reads today, so binding to `127.0.0.1` and refusing other `Host` headers (DNS rebinding) is enough. Once endpoints write, any web page open in the user's browser can send a cross-origin request to `127.0.0.1:<port>`, with a `Host` header that passes. So:

- **Per-launch token.** The server makes a random token at start and puts it in the URL fragment it opens and prints (`…/#t=<token>`). The page keeps it in `sessionStorage` and sends it as `X-Autosketch-Token` on every request that changes something. A custom header can't be sent cross-origin without a preflight, which the server never approves.
- **Origin check.** Changing requests must carry an `Origin` that matches the server's own origin.
- **Changes only through POST, PUT and DELETE.** GET stays side-effect free.
- **No raw paths.** Library entries are addressed as `<root label>/<kind>/<name>` and resolved by the server, which refuses anything that resolves outside its root. Folder paths are accepted only for `library.roots` and the instance field. Both are settings the user could set by hand anyway, and the server only reads them as a library root or an instance.
- The token is also written into `observe/<session>/url`, which sits in the user's own workspace.

## Endpoints (settled 2026-11-16)

Beside `12`'s endpoints. Every write needs the token.

```
GET    /api/settings                          every setting: value, source, default, accepts, group, summary, applies
PUT    /api/settings/<key>                    {value}  → config.toml (refused when locked by a higher source)
DELETE /api/settings/<key>                    remove from config.toml
GET    /api/library                           roots and entries, with origin, shadowing and hidden flags
GET    /api/library/<root>/<kind>/<name>      one entry: metadata, text, file hash
PUT    /api/library/<root>/<kind>/<name>      {hash, metadata | text}  (409 on a hash mismatch)
POST   /api/library/<root>/<kind>/<name>/rename | /duplicate | /copy | /hide | /delete
POST   /api/library/<root>/trash/<id>/restore,  DELETE /api/library/<root>/trash
GET    /api/instance                          current instance, source, registry and link status, discovered list
PUT    /api/instance                          {id | path}  → config.toml; loads in place when unconfigured
DELETE /api/instance                          unlink: remove `instance` from config.toml (the wizard shows on the next start)
```

## Phases

| # | Piece |
|---|---|
| U1 | App shell with tabs around the existing viewer; token and Origin check; `/api` routing |
| U2 | `config.toml` `[settings]` layer in `core/settings.ts`; `summary`/`group`/`applies` on settings; the Settings tab |
| U3 | `library.*` settings; the Library tab (browse, metadata and text editing, rename, copy, hide, trash) |
| U4 | Instance tab; the setup wizard at startup with loading in place; unlink; the URL in `not_configured` |
| U5 | `autosketch ui` |

U4 depends on `14`'s `config.toml` and discovery, so it lands with or after them.

## Implementation status

Since `16` (2026-11-17): the rows for U1, U3, U4 and U5 describe code that has been removed (the page and its tabs, `instance-host.ts`, `ui-command.ts`, the wizard signal) or was rewritten as bridge request handlers in `src/ui/` (`settings-api.ts`, `library-api.ts`, `library-host.ts`; `http.ts` and `guard.ts` reduced to the OTLP receiver). The settings layer (U2's first two rows) and `src/library/manage.ts` and `roots.ts` (U3a) are unchanged.

| Piece | Status |
|---|---|
| U2: `config.toml` `[settings]` layer | Done (the server side): `src/core/settings.ts` reads `config.toml [settings]` (`src/core/config.ts`, `14`, *Implementation status*) before `--set`, the flag alias and `AUTOSKETCH_<KEY>`. `Settings.from(argv, env, readConfig())`; `resolve(setting)` returns the value, its `source` (`kind` and the label shown: `config.toml`, `--set`, `--mod-order`, `AUTOSKETCH_…`, `default`), the `raw` text, the launch value it `overrides`, an `invalid` config value, or an `error` for an invalid launch value (which `get` still throws); it never throws itself. `resolveAll()` covers every registered setting, `notes()` gives the startup lines (one per overridden launch value whose meaning differs, per invalid or unknown `config.toml` key, per read problem), and `reload(snapshot)` swaps in a newer read for `live` settings. An invalid `config.toml` value is skipped and the next source applies (the launch value if any, else the default). No tool result changed. |
| U2: `summary`, `group`, `applies` | Done as optional fields on `setting(…)`, with `settingGroup()` (default: the key's first segment, capitalised) and `settingApplies()` (default `restart`). `setting(…)` registers the key for `registeredSettings()`; declaring a key again replaces it. No setting sets them yet. |
| U1: app shell, `/api` routing, security | Done (silo K). `viewer/index.html` has a tab bar (Observe, Settings, Library, Instance) and a small inline module as the shell, so the Observe tab requests exactly what it did before (`style.css`, `js/main.js` and its static imports; a test checks this). Other tabs are ESM modules in `viewer/js/tabs/<name>.js`, imported on first open; each exports `mount(el, ctx)` and may return `{ show, hide }`. `ctx.api(path, {method, body})` fetches `api/<path>` and adds `X-Autosketch-Token` on writes; `ctx.canWrite()` says whether the page has a token. The open tab goes in the fragment (`#settings`). Library and Instance are placeholders for U3 and U4. Server (`src/observe/http.ts`, `guard.ts`): a random per-launch token (24 bytes, base64url) goes into the URL printed, opened and written to `observe/<session>/url` (`…/#t=<token>`; `Observer.ready` resolves to it); the page keeps it in `sessionStorage` and removes it from the address bar. `/api/*` takes GET/HEAD to read, and POST/PUT/DELETE only with the token (constant-time compare) and an `Origin` that is this server's own (`127.0.0.1`, `localhost` or `[::1]` on its port). Everything else is refused: 403 for a missing or wrong token or Origin, 405 for other methods (preflights get no CORS headers), and 405 for a GET on a write-only path. Paths outside `/api` and `/v1/logs` stay GET only. A finished log (`autosketch observe`) prints its URL without a token and has no settings endpoints. |
| U2: Settings tab, file watching | Done (silo K). `src/observe/settings-api.ts`: `GET /api/settings` (path, hash, read warnings, unknown keys, and one row per registered setting: group, summary, applies, accepts, control, default, value, text, source label as in *Settings tab*, `overrides` with the sentence "launch command sets `--set k=v`; ignored, config.toml says …" (`environment sets …` for `AUTOSKETCH_*`), `invalid`, `error`, `restartNeeded` with the `running` value read at startup). `PUT /api/settings/<key>` `{value, hash?}` checks the value with the setting's `parse` (400), refuses a stale `hash` or a file that changed during the write (409, `writeConfig`'s compare-and-set), and refuses to rewrite a file with read problems (409 with the warnings). `DELETE` removes the key. The file is polled (`fs.watchFile`, 1 s) and re-read before each GET, and `Settings.reload` is called when its hash changes. The control comes from `settingControl()`, added to `core/settings.ts` (`parseInt0` and `parseOneOf` record their bounds and options). Tab (`viewer/js/tabs/settings.js`): sections by group; toggle, select, number with bounds, list editor or text field; Save writes with the last hash, and a 409 reloads with a message; Reset is enabled when the source is `config.toml`; the page polls every 2 s while the tab is open and doesn't redraw while a field is being typed in. Every existing setting now has `summary` and `group` (Observe, Scopes, World, Server, Assets); all stay `applies: "restart"`, since each is read once at startup. The tab's DOM was checked only by parse and HTTP, not in a browser. |
| U4 (server side) | Done by silo J (`14`, *Implementation status*): discovery, `chooseInstance`, `session.loadInstance`, the `not_configured` answer with the URL, and the startup signal (`wantsSetupWizard`, `#tab=instance`). The tab, `/api/instance` and the wizard view are silo K's. |
| U4 (UI) | Done (silo K). `src/observe/instance-api.ts`: `GET /api/instance` returns the instance in use (`none`, `loading`, `loaded` or `failed`, with folder, how it was chosen, name, Minecraft version, loader, launcher, game folder, mod count, registry block count and warnings, or the last load error), what config.toml remembers (`wizard: true` when nothing), the launch command's instance (`--instance` or `AUTOSKETCH_INSTANCE`, whether config.toml beat it or not) and whether it is the one loaded, `restartNeeded` when the saved instance isn't the loaded one, the live link's state and dimension, and discovery's candidates and warnings (cached 30 s; `?refresh` runs it again). `PUT /api/instance` `{id \| path, version?, baseJar?, hash?}` goes through `chooseInstance` (400 with the locator's reason) and `setInstance`, written with `writeConfig`'s compare-and-set (409 on a stale hash or a file with read problems). It then calls `session.loadInstance` when nothing is loaded or loading (`loading: true`), or answers `restartNeeded` when another instance is loaded (keeping the loaded one answers neither). `DELETE /api/instance` unlinks through `unsetInstance`. The server side reaches `observe/` as an `InstanceHost` built by `src/server/instance-host.ts` and passed through a new `startObserve({ instance })` option (one line in `server/index.ts`). Tab (`viewer/js/tabs/instance.js`): a wizard heading and explanation when nothing is remembered; the instance in use; the link status; the candidate list with the launch value first, marked and offered as *Keep*; candidates that fail the check are shown with the reason and can't be chosen; a folder field (version and client jar behind a disclosure); *Unlink instance*. The shell opens the tab on `#tab=instance`, alone or after the token (`#t=…&tab=instance`), as the server's wizard URL gives it. The tab's DOM was checked only by parse and HTTP, not in a browser. |
| U3a: library settings, Library tab (browse and actions) | Done (silo K). `src/library/roots.ts` declares `library.roots`, `library.starter`, `library.axiom` and `library.hidden` (group Library, `applies: "live"`). The tools build them on every library call (`librarySettings()`: config.toml as it is on disk, then the launch values), so a change in the Settings tab applies to the agent's next call. `library.roots` beats `AUTOSKETCH_LIBRARY`, which stays as an alias. `library.hidden` applies to read-only roots only (starter, Axiom): a user's own entry is deleted to the trash instead, and so a copy made with *copy to my library* is never hidden along with its original. Hidden entries are left out of `prefab_search`, `prefab_sheet`, `palette_list`, `knowledge_list` and `procedure_list`. `src/library/manage.ts` lists every root's entries per kind, hidden and shadowed ones included, with `overrides` and `shadowedBy`. An address `<root>/<kind>/<name>` resolves only to an entry in that root's listing; names with empty, `.`, `..` or dot-leading parts or backslashes are refused (400), and the resolved path is checked against the root (403). It also does rename and duplicate (`ENTRY_NAME` per part; a palette's or `prefab.json`'s own `name` follows when it matched), delete (moved to `<root>/.trash/<id>/` with an `entry.json` manifest), restore (409 if the name was taken since), empty trash, and copy to the first writable root (409 if taken). `src/observe/library-api.ts`: the endpoints in *Endpoints*, plus `?thumb` (PNG, through the tools' `Library`, so cached, embedded or rendered), `?preview` (the prefab's voxels in the viewer's ASVX format with its own state table, and models baked into the shared atlas when an instance is loaded; `null` otherwise), `GET /api/library/<root>/trash` and `POST /api/library/<root>/open` (opens the folder with the browser opener). *hide* and *unhide* write `library.hidden` with compare-and-set. The host is `src/server/library-host.ts` (`startObserve({ library })`, one line in `server/index.ts`). Tab (`viewer/js/tabs/library.js`): a roots table with counts, trash (restore, empty) and *Open folder*; per-kind lists filtered by text and `tag:`, prefab thumbnails in a grid, flags for origin, overrides, shadowed and hidden (hidden shown on request); a detail pane with metadata or text, and a 3D preview drawn with the Observe tab's `gl.js` and `voxels.js`, which are imported only when a preview opens. The tab's DOM was checked only by parse and HTTP, not in a browser. |
| U5: `autosketch ui` | Done (silo K). `src/server/ui-command.ts` (`startUi`, `uiCommand`; one case in `server/index.ts`'s subcommand dispatch): `autosketch ui [--port <n>] [--no-open] [--workspace <dir>] [--set k=v]` serves the same app with no MCP session. It prints the URL with the token on stdout, opens it unless `--no-open`, and runs until interrupted. Settings: the same endpoints, with nothing marked *restart needed*, since no server is running. Instance: `standalone: true`, so a choice is saved and never loaded (a running server with no instance picks it up on its next tool call, `14`). Library: the roots the settings name, with the saved instance's Axiom folder (its `minecraft/` or `.minecraft/` subfolder when that holds `config/`), thumbnails only where cached or embedded, and previews in flat colours. Observe: `/info` says `standalone`, and the tab lists the workspace's session logs (`GET /api/logs`, `src/observe/logs.ts`, newest 50); *Open* (`POST /api/logs/open {id}`, a listed id only) starts that log's own viewer through `serveLog`, as `autosketch observe` does, and opens it in a new tab. |
| U3b: Library editors | Done (silo K). `GET /api/library/<root>/<kind>/<name>` now also returns `hash` (sha256 of the editable file: `prefab.json` for a prefab folder, the entry's file otherwise; `absent` when a prefab folder has none yet), `editable`, and the parsed palette. `PUT` on the same address takes `{hash, …}`. Procedures and knowledge packs send `text`. Prefabs send `metadata`: name, tags, front, notes, anchors and roles are validated (400) and merged into `prefab.json`, keeping its other fields; a loose schematic file has no `prefab.json`, so it is refused with 409. Palettes send `tags` and `notes` (always), and member changes as `edit` (the `palette_edit` operations `weights`, `remove`, `drop`, `rename`, `add`, applied with `editPalette`, `03`) and `addBlocks` (members by block id at an even share). Member changes need the loaded instance's palette index (409 without one). Weights are normalised, saved colours are kept and new members get their family's colour. Every write is refused with 409 when the file's hash isn't the one sent, so a file the agent saved meanwhile stays as the agent wrote it. Writes go through a temporary file and a rename (`src/library/manage.ts`: `entryHash`, `writeEntryText`, `writePrefabMeta`, `writePaletteFile`). Tab: a `<textarea>` for text, a form for `prefab.json` (anchors and roles as `name: …` lines), and a role editor for palettes (weights, remove, rename, drop role, add blocks by id). A 409 shows the message and reloads the version on disk, and polling doesn't redraw over an editor that has focus. The tab's DOM was checked only by parse and HTTP, not in a browser. |

## Open questions

- **Which settings can become live**, and whether any `restart` setting should restart the session itself (the MCP client would need to restart the server; there is no general way to ask it to).
- **How long trash is kept.** For now, until emptied.
- **Text editing.** A plain `<textarea>` keeps the no-build-step rule. Is a vendored editor with Markdown and JavaScript highlighting worth it later?
- **A Claude Code panel** (`12`, open question) was answered by this doc (one web UI rather than a second surface), and then by `16`: no web UI at all.

## Decisions

- **The viewer becomes a general management UI for the MCP** (settled, proposed by the user 2026-11-16). Reason: it already runs a local server with the instance's textures, and players shouldn't need environment variables or JSON to run Autosketch.
- **The UI is the setup wizard** (settled 2026-11-16, reversing `14`'s "no graphical wizard"). A server with no remembered instance opens the UI on the Instance tab at startup; the choice is kept in `config.toml` until the user unlinks it. Reason: choosing an instance from a list is the easiest path for players, and a remembered choice means the wizard is seen once.
- **The UI has priority over the launch command** (settled 2026-11-16, reversing the earlier "command line keeps priority"). `config.toml` comes before `--set`, flag aliases and the environment; launch values fill only keys it doesn't set. Conflicts are shown in the UI and the server log, never to the agent. Reason: the user wants one place where settings are decided, and that place is the UI.
- **One store, edited both ways** (settled 2026-11-16). The UI and the `autosketch setup` / `autosketch config` commands write the same `config.toml`. Reason: each route sees the other's changes, so they never disagree.
- **Files stay the source of truth; the UI writes `config.toml` and library files** (settled 2026-11-16). Reason: nothing becomes UI-only, and hand edits and the UI never disagree.
- **Writes need a per-launch token and a matching Origin** (settled 2026-11-16). Reason: loopback binding and the Host check don't stop cross-origin writes from other pages.
- **The full Library tab, in two steps** (settled 2026-11-16): browse and actions, then editors. Reason: the first step already covers copy, hide and recoverable delete, and the editors can follow without blocking it.
- **`library.hidden` applies to read-only roots only** (settled 2026-11-16). Reason: a copy in the user's own library shares the original's name, so hiding by name everywhere would hide the copy too.
