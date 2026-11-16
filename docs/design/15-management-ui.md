# 15 — Management UI

The live viewer (`12`) grows into the user's general UI for the MCP: one localhost page with tabs for watching a build, changing settings, managing the library (`07`) and choosing the instance, including first-run setup (`14`). Players who aren't developers can then run Autosketch without editing environment variables or JSON.

Status: being designed. *Settled* marks points agreed with the user; *proposed* marks points still to confirm.

## Principles

1. **For the human, never the model** (from `12`). No tool reads the UI, and nothing shown there is returned to an agent. The agent sees the *results* of what the user changes, through what it already reads: library files on its next call, settings as behaviour.
2. **Files stay the source of truth.** The UI edits the same files a user could edit by hand (`~/.autosketch/config.toml`, the library folders). It keeps no state of its own, and anything it does can be done without it.
3. **Show where each value comes from.** A setting can be set in several places, so the UI shows which one won. A value fixed by the MCP client's command line or environment is shown as locked, with the reason, never as a control that silently does nothing.
4. **Never slows the build** (from `12`). UI requests are served off the tool-call path, and no op waits for the UI.
5. **Local, and guarded where it writes.** Loopback only, as today. Every request that changes something carries a per-launch token (*Security*).

`12`'s second principle, *read-only*, still holds for observability itself: the event stream, deltas and observe panels never mutate anything. The writing parts are the Settings, Library and Instance tabs, which go through their own endpoints.

## App shell (proposed)

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

## Settings tab (proposed)

**A new layer: `config.toml`.** Settings are read today from `--set`, a flag alias, `AUTOSKETCH_<KEY>`, then the default (`12`, *Settings*). The UI needs somewhere to write, and `14` already plans `~/.autosketch/config.toml` for `setup`. Settings go into a `[settings]` table there, read after the environment and before the default:

```
--set <key>=<value>  >  flag alias  >  AUTOSKETCH_<KEY>  >  config.toml [settings]  >  default
```

```toml
# ~/.autosketch/config.toml
instance = "C:/Users/me/curseforge/minecraft/Instances/Craftoria"

[settings]
"observe.snapshots" = "merge"
"scope.maxDepth" = 2
"library.roots" = ["~/autosketch/library", "~/shared/castle-kit"]
```

Values are stored as text and go through each setting's own `parse`, so a hand-edited file and the UI agree on what's valid. An invalid value in the file is reported in the UI and the server log and the default is used, as with an invalid environment value.

**Generated, not hand-written.** Each `setting(…)` gains three optional fields, and the tab is built from the registry, so a new setting appears in the UI with no UI change:

| Field | Meaning |
|---|---|
| `summary` | One line shown under the control |
| `group` | Section heading (`Observe`, `Scopes`, `Assets`, `Library`). Defaults to the key's first segment |
| `applies` | `"live"` (read on each use) or `"restart"` (read at startup). Defaults to `"restart"` |

The control follows the parser: a toggle for `parseBool`, a select for `parseOneOf`, a number field with bounds for `parseInt0`, a list editor for `parseList`, a text field otherwise.

**Each row shows** the effective value, its source (`command line`, `environment: AUTOSKETCH_SCOPE_MAX_DEPTH`, `config.toml`, `default`), and a *restart needed* note when a saved value differs from the running one. If the source is above `config.toml`, the control is locked and says where to change it (usually the MCP client config). *Reset* removes the key from `config.toml`.

**Live versus restart.** Settings are read once at startup today. A setting marked `live` must be read through the `Settings` object on each use, which re-reads `config.toml` when the file changes. A setting is marked `live` only once its code does that. Everything starts as `restart`, and settings move over one by one.

**Library settings.** Library roots come from `AUTOSKETCH_LIBRARY`, read directly in `src/library/roots.ts` (`07`, *Roots*), not through the registry. They become settings so the UI can show them:

| Setting | Default | Meaning |
|---|---|---|
| `library.roots` | `<workspace>/library` | User roots in order; the first is writable. `AUTOSKETCH_LIBRARY` keeps working as an alias |
| `library.starter` | `true` | Include the starter library |
| `library.axiom` | `true` | Include the instance's Axiom blueprints as a root |
| `library.hidden` | none | Entries to leave out of every listing, as `<kind>/<name>` (`prefabs/park_bench`), so a starter or Axiom entry can be hidden without deleting it |

## Library tab (proposed)

**Roots.** One row per root in search order: label, path, kind, writable or read-only, entry counts, with a link that opens the folder in the OS file manager.

**Entries.** One list per kind (prefabs, palettes, procedures, knowledge), filterable by text and tag. Each entry shows the root it comes from. An entry that shadows another root's entry of the same name says so (`overrides starter: park_bench`), and so does a hidden one.

| Kind | Shown | Editable (writable root) |
|---|---|---|
| Prefab | Thumbnail grid (the cached `prefab_sheet` thumbnails), and a 3D preview using the Observe tab's renderer and atlas | `prefab.json` fields: name, tags, front, notes, anchors, roles |
| Palette | Roles with each member's texture from the atlas and its weight | Weights, add or remove members, rename roles (the `palette_edit` operations, `03`) |
| Procedure | Header (summary and `@param` lines) and the source | Source, in a plain text editor |
| Knowledge pack | Frontmatter fields and the rendered Markdown | Frontmatter and text, in a plain text editor |

**Actions.**

- In a writable root: *rename* (checked against `ENTRY_NAME`, `07`), *delete*, *duplicate*.
- In a read-only root (starter, Axiom): *copy to my library*, which writes the entry into the first writable root under the same name, so it shadows the original and can then be edited. And *hide*, which adds it to `library.hidden`.
- **Delete is recoverable.** Deleted entries move to `<root>/.trash/<timestamp>/` rather than being removed. Listings skip `.trash/`, and the tab offers *restore* and *empty trash*.
- Editing the blocks of a prefab is out of scope. That is document work (`04`, `05`), done by the agent or by opening the file in Axiom.

**Concurrent edits.** The agent can write the same files while the UI is open (`prefab_save`, `palette_save`). Every UI write sends the hash of the file it started from, and the server refuses it with a conflict if the file has changed since, so the UI reloads instead of overwriting. Writes are whole-file: a temporary file, then rename. The server already re-reads library entries on each call (`07`, *Implementation status*), so the agent sees UI edits on its next call with no notification.

## Instance tab and first-run setup (settled: the UI may do first-run setup)

**Shown:** the instance in use (pack name, folder, Minecraft version, loader, mod count), how it was chosen (command line, environment, `config.toml`, or none), the asset registry status (`02`), and the companion mod's link status (`13`: connected or not, world, pairing), read-only. The mod's own settings stay in its Cloth Config screen (`14`), not here.

**Choosing.** The tab lists what discovery found (`14`, *Instance discovery*, the same list `autosketch instances` prints) and offers a folder field for anything else. Choosing one writes `instance` to `config.toml`, exactly as `autosketch setup --instance` does.

**First run.** This reverses `14`'s "no graphical wizard" decision, at the user's request (2026-11-16):

- An unconfigured server still starts (`14`). The HTTP server starts with it, since the viewer already works without an instance (flat colours, `12`), and unless `observe.open=false` the browser opens on the Instance tab.
- Tools still answer `not_configured`, and the answer now gives the UI's URL as well as the `setup` commands, so the agent can point the user at either.
- **No restart for the first choice.** With nothing loaded there is nothing to tear down, so the server loads the chosen instance in place and the tools start working. Switching away from a loaded instance writes `config.toml` and needs a restart, because the registry, atlas and open documents are built on the old one.
- The command line stays the scriptable route and keeps priority: an `--instance` on the server command line locks the tab's choice.
- In an environment with no browser (SSH, a container), `observe.open` fails quietly as today, and the `not_configured` answer carries the `setup` command.

## Security (proposed)

The viewer only reads today, so binding to `127.0.0.1` and refusing other `Host` headers (DNS rebinding) is enough. Once endpoints write, any web page open in the user's browser can send a cross-origin request to `127.0.0.1:<port>`, with a `Host` header that passes. So:

- **Per-launch token.** The server makes a random token at start and puts it in the URL fragment it opens and prints (`…/#t=<token>`). The page keeps it in `sessionStorage` and sends it as `X-Autosketch-Token` on every request that changes something. A custom header can't be sent cross-origin without a preflight, which the server never approves.
- **Origin check.** Changing requests must carry an `Origin` that matches the server's own origin.
- **Changes only through POST, PUT and DELETE.** GET stays side-effect free.
- **No raw paths.** Library entries are addressed as `<root label>/<kind>/<name>` and resolved by the server, which refuses anything that resolves outside its root. Folder paths are accepted only for `library.roots` and the instance field. Both are settings the user could set by hand anyway, and the server only reads them as a library root or an instance.
- The token is also written into `observe/<session>/url`, which sits in the user's own workspace.

## Endpoints (proposed)

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
```

## Phases

| # | Piece |
|---|---|
| U1 | App shell with tabs around the existing viewer; token and Origin check; `/api` routing |
| U2 | `config.toml` `[settings]` layer in `core/settings.ts`; `summary`/`group`/`applies` on settings; the Settings tab |
| U3 | `library.*` settings; the Library tab (browse, metadata and text editing, rename, copy, hide, trash) |
| U4 | Instance tab; first-run setup with loading in place; the URL in `not_configured` |
| U5 | `autosketch ui` |

U4 depends on `14`'s `config.toml` and discovery, so it lands with or after them.

## Open questions

- **Which settings can become live**, and whether any `restart` setting should restart the session itself (the MCP client would need to restart the server; there is no general way to ask it to).
- **How long trash is kept.** For now, until emptied.
- **Text editing.** A plain `<textarea>` keeps the no-build-step rule. Is a vendored editor with Markdown and JavaScript highlighting worth it later?
- **A Claude Code panel** (`12`, open question) is answered by this doc: one web UI rather than a second surface to maintain.

## Decisions

- **The viewer becomes a general management UI for the MCP** (settled, proposed by the user 2026-11-16). Reason: it already runs a local server with the instance's textures, and players shouldn't need environment variables or JSON to run Autosketch.
- **The UI may do first-run setup** (settled 2026-11-16, reversing `14`'s "no graphical wizard"). Reason: an unconfigured server can already open a browser, and choosing an instance from a list is the easiest path for players. The command line stays and keeps priority.
- **Files stay the source of truth; the UI writes `config.toml` and library files** (proposed). Reason: nothing becomes UI-only, and hand edits and the UI never disagree.
- **`config.toml` becomes a settings layer below the environment** (proposed). Reason: the MCP client's own config keeps priority, so the UI can't silently override what the client set.
- **Writes need a per-launch token and a matching Origin** (proposed). Reason: loopback binding and the Host check don't stop cross-origin writes from other pages.
