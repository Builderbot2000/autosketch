# Silo J: MCP install and config

**Waves 0, 1, 2.** Wave 0 lands the `config.toml` store and the settings layer that silo K builds on. Wave 1 adds discovery and the command line. Wave 2 packages the server for every listing.

**Specs:** `14` (*MCP server: install and setup*, *Instance discovery*, *Package and listings*), `15` (*Settings tab*: the layer and its order; *Instance tab and first-run setup*: the server side of the wizard), `12` (*Settings*), `02` (the instance locator and its check).

## Goal

A player installs with one command, chooses an instance once (in the UI that K builds, or on the command line), and the choice is remembered in `~/.autosketch/config.toml` until they unlink it. What the user saved there beats the launch command, and nothing is ever ignored without a trace.

## Deliverables, in merge order

1. **`config.toml` store** (wave 0, contract). `src/core/config.ts` per the README's contracts table. Read on startup and on demand; writes are whole-file, temp file then rename, refused when the file's hash differs from the caller's. A TOML parser is a new dependency: prefer a small pure-JS one (`smol-toml`) and say so in the merge request.
2. **Settings layer** (wave 0, contract). `core/settings.ts`: `config.toml [settings]` first, then `--set`, flag alias, `AUTOSKETCH_<KEY>`, default (`15`). Values are text through each setting's own `parse`; an invalid value in the file is logged and skipped, like an invalid env value. `resolve()` returns value, source and the overridden launch value per key, for K's Settings tab and for one stderr line at startup per conflict. Add the optional `summary`, `group` and `applies` fields. No tool result changes.
3. **Instance from `config.toml`.** The instance is resolved the same way: `config.toml` `instance`, then the launch `--instance` or env, then none. `instance_info` reports which source won.
4. **Instance discovery** (wave 1). `src/assets/discover/`, one reader per launcher in `14`'s table (CurseForge, Prism/MultiMC, vanilla, Modrinth App, ATLauncher, GDLauncher), then launcher defaults, then pointer files, then WSL's Windows profile via `cmd.exe /c echo %USERPROFILE%` and `wslpath`. Modrinth through `node:sqlite`, read-only, querying only `instances`/`instance_content_sets` (or the old `profiles`) and `settings.custom_dir`; never open GDLauncher's database. Every reader tolerates missing files, tables and fields and falls back to listing the instance folder with a warning. Every candidate goes through `02`'s check before it is listed. Never search beyond the known locations. Raise `engines` to `>=22.13`.
5. **Pointer file format** (wave 1, contract for X). Write the format and the game-folder hash into `14`, and read pointer files in discovery (dropping entries whose game folder is gone).
6. **Command line** (wave 1). `autosketch instances`, `autosketch setup --instance <id|path> [--workspace] [--version] [--base-jar] [--client claude]` (prints the `claude mcp add` command it runs), `autosketch config set|unset <key> [value]`, with `config unset instance` as the unlink. Same parsing and validation as the UI.
7. **Not configured** (wave 1). The server starts with no instance. Every tool except `instance_info` answers `not_configured` with the discovered candidates, the `setup` command for each and the UI's URL. Loading an instance in place (no restart) is a function K's U4 calls: `session.loadInstance(path)`, valid only while nothing is loaded. With no instance in `config.toml`, the server asks the observe layer to open the UI on the Instance tab at startup (a hook K wires to its tab). A launch `--instance` still loads meanwhile.
8. **Packaging** (wave 2). npm package contents (`files`, bin, `mcpName`), a `server.json` for the official MCP Registry, an MCPB bundle for Claude Desktop, a Claude Code plugin (MCP config plus knowledge files as skills; channels if a plugin can declare them, checked and recorded in `14`). A GitHub release workflow for the npm side. Publishing itself waits for the user's accounts (README, *Release gate*).

## Files you own

- New: `src/core/config.ts`, `src/assets/discover/**`, the CLI subcommand modules (for example `src/cli/**`), packaging files (`server.json`, the MCPB manifest, the plugin folder), `.github/workflows/` for npm, tests in `test/unit/config/` and `test/unit/discover/` with synthetic launcher layouts.
- Shared: `core/settings.ts` (wave 0, then K's), `server/index.ts` (subcommand dispatch, not-configured start), `server/session.ts` (`loadInstance`), `src/server/tools/instance.ts`, `package.json`.

## Done when

- With `observe.snapshots` in both `config.toml` and `--set`, the `config.toml` value applies, `resolve()` names the ignored launch value, and stderr says it once.
- Deleting the key from `config.toml` makes the `--set` value apply on the next start.
- Each launcher reader passes on a synthetic layout, including one with a missing table or field (warning and folder fallback), and the Modrinth reader opens the database read-only and touches only the named tables (assert the SQL).
- WSL resolution is unit-tested with a stubbed `cmd.exe`.
- An unconfigured server answers `not_configured` with candidates, commands and the URL; `loadInstance` makes the next tool call work without a restart; a second `loadInstance` is refused.
- `npx autosketch` from a packed tarball starts on a clean machine with Node 22.13.
- `14`'s setup and discovery points have an *Implementation status* table; the unverified launcher readers are marked so.
