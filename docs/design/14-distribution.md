# 14 — Distribution

How a player who isn't a developer gets Autosketch running: the MCP server installed with one command and pointed at their instance, and the companion mod installed from CurseForge or Modrinth. It also covers how the two pieces stay compatible once they release separately, and what in the mod has to change across Minecraft versions, loaders and modpacks.

Status: being designed. *Settled* marks points agreed with the user; *proposed* marks points still to confirm.

## Principles

1. **One command, then one choice.** Installing is one command; the only thing the user has to decide is which instance to build with. Everything else has a default.
2. **Look only where it's known, and ask before using it.** Instance discovery reads launchers' known folders and their own config files, and the mod's pointer file. It never searches the user's home folder. What it finds is offered for the user to choose, never picked silently.
3. **One package, many listings.** Every install route wraps the same npm package, so a listing costs packaging, not a fork.
4. **Version skew is normal.** The mod and the MCP release separately, so any pairing a user ends up with either works or says which side to update.
5. **Pack-agnostic by reading, not by knowing.** The MCP learns blocks, shapes and textures from the user's instance (`02`), and the mod works through vanilla game types. Neither ships a list of supported packs.

## MCP server: install and setup

### Package and listings

The server is pure JavaScript: rendering is software, the script sandbox is wasm, and no game assets ship (`02`). One npm package (`autosketch`, name free as of 2026-11-15) runs on every OS with `npx -y autosketch`, given Node 22 or newer.

| Route | Who it reaches | What it wraps |
|---|---|---|
| npm, `npx autosketch` | Everyone | The package |
| Official MCP Registry | Clients that browse the registry | A `server.json` pointing at the npm package (`mcpName` in `package.json`) |
| Claude Code plugin marketplace | Claude Code users | The MCP config, the knowledge files as skills, maybe the channel setup (*to confirm* what a plugin can declare for channels) |
| MCPB bundle | Claude Desktop | The package with its own Node. No channels in Desktop, so building and the world link work but in-game prompts don't |
| GitHub releases | Everyone | Changelog and the mod jar |

Settled: one-command install is the goal; listings on these platforms are for credibility.

### Setup (settled: command-line options, plus the management UI)

The MCP client starts the server and owns its stdin and stdout, so the server can never show a prompt of its own. There is no interactive terminal wizard. The management UI (`15`) is the setup wizard: a server with no remembered instance opens it on its Instance tab at startup, and the choice is kept in `config.toml` until the user unlinks it (settled 2026-11-16, replacing the earlier "no graphical wizard"). The command line edits the same file, for scripts and READMEs.

- **`npx autosketch instances`** lists what discovery found, one line per instance with a short id, the pack's name, Minecraft version, loader, launcher and folder.
- **`npx autosketch setup --instance <id | path>`** saves the choice to `~/.autosketch/config.toml`, with optional `--workspace`, `--version` and `--base-jar` (as the server takes today). `--client claude` also registers the server with that agent client, printing the exact command it runs (`claude mcp add …`).
- **`npx autosketch config set <key> <value>` / `config unset <key>`** edit `[settings]` (and `config unset instance` unlinks the instance), the same file and the same parsing the UI uses (`15`, *Settings tab*).
- **`config.toml` has priority** over the server's launch command and environment (settled 2026-11-16, `15`). Launch options still fill whatever `config.toml` leaves unset, so `claude mcp add autosketch -- npx -y autosketch --instance <path>` works with no setup step. With no instance remembered, the wizard still opens and offers that launch instance first, to keep with one click.
- **An unconfigured server still starts.** Every tool except `instance_info` answers `not_configured` with the discovered instances, the exact `setup` command for each and the management UI's URL (`15`), so the agent can tell the user what to run instead of failing silently.
- Reason: the audience already works in a terminal, since the agent CLI runs there, and options can be scripted, documented in one line and pasted from a README.

### Instance discovery

The same method the Modrinth App and GDLauncher use to import instances from other launchers: fixed, known locations only, with no recursive search.

- **Launchers' own records first.** Where a launcher keeps a list of its instances, read it: it already holds each instance's folder, version and loader, and it follows the user's moved folders. Checked on the dev machine (Windows, 2026-11-15):

  | Launcher | Where it records instances | What it gives |
  |---|---|---|
  | CurseForge | `%APPDATA%\CurseForge\agent\GameInstances\MinecraftGameInstance.json`: a list with `name`, `installPath`, `gameVersion`, `baseModLoader.name` (e.g. `neoforge-21.1.262`, `forge-47.4.4`, `fabric-0.19.2-1.21.11`) | Every instance, wherever it lives. The modding folder itself is `minecraftRoot` in `storage.json` → `minecraft-settings`. |
  | Prism Launcher / MultiMC | `InstanceDir` in `prismlauncher.cfg` (relative to the launcher's data folder unless absolute), then one folder per instance with `instance.cfg` and `mmc-pack.json` | Folders, versions, loaders. The Modrinth App's import ignores a moved `InstanceDir` (modrinth/code#4490), which is why reading the config matters. |
  | Vanilla launcher | `launcher_profiles.json`: per profile `gameDir` (absent = `.minecraft`) and `lastVersionId` | Folders and versions; the loader from the version id |
  | Modrinth App | SQLite `app.db` in the settings folder (the OS data folder + `ModrinthApp`, e.g. `%APPDATA%\ModrinthApp`; formerly `com.modrinth.theseus`). Instances: table `instances` (`id`, `path`, `name`, `applied_content_set_id`) joined to `instance_content_sets` (`game_version`, `loader`, `loader_version`), since the mid-2026 migration; before it, one `profiles` table with `path`, `name`, `game_version`, `mod_loader`, `mod_loader_version`. Folder: `<config dir>/profiles/<path>`, where the config dir is `settings.custom_dir` when the user moved it, else the settings folder. Mods are real files in the instance's `mods/` (hard links or copies from its content store), so the asset registry reads them as usual. | Every instance, version and loader |
  | ATLauncher | No fixed data folder: everything sits beside the launcher (`user.dir`; the Windows installer puts it in `%APPDATA%\ATLauncher`). Instances: `<base>/instances/<name>/instance.json`, with `id` (Minecraft version), `launcher.name`, `launcher.loaderVersion.type` and `.version`. | Folders, versions, loaders, at the default location only |
  | GDLauncher (Carbon) | App data folder `gdlauncher_carbon` in the OS data folder (`%APPDATA%`, `~/Library/Application Support`, `$XDG_DATA_HOME` or `~/.local/share`). The runtime path is `<app data>/data/`, or the path in the one-line text file `<app data>/runtime_path_override` when the user moved it. Instances: `<runtime path>/instances/<shortpath>/instance.json` (name, Minecraft version, loader), with the game folder in `instance/` beneath it. | Every instance, version and loader |

  Sources: each launcher's open repository (modrinth/code `packages/app-lib`, ATLauncher `FileSystem.java` and `Instance.java`, GDLauncher-Carbon's own docs *Anatomy of an Instance Folder* and *Runtime path vs app data*), read 2026-11-15.

  **Reading `app.db`** uses Node's built-in `node:sqlite` (settled 2026-11-16), so `engines` rises to `node >=22.13`, the first release where it needs no flag. Reason: no new dependency, and no native module, which would break "pure JavaScript, runs everywhere with `npx`" (`better-sqlite3` needs prebuilt binaries per OS and Node version). Its "experimental" warning goes to stderr, which never reaches the MCP channel, and is filtered out of the log.

  **Credentials live next to some of these records.** Modrinth's `app.db` also holds Minecraft account data, and GDLauncher's `gdl_conf.db` holds account and refresh tokens. So the Modrinth reader opens `app.db` read-only and queries only `instances`, `instance_content_sets` (or the old `profiles`) and `settings.custom_dir`, and the GDLauncher reader never opens its database at all: the `instance.json` files have everything needed.

  These files are the launchers' internal formats, not documented interfaces (Modrinth's schema changed in 2026), so each reader tolerates missing tables and fields and falls back to listing the launcher's instance folder, with a warning that names the launcher.
- **Launcher defaults** when there is no record: each launcher's default instance folder per OS (for CurseForge, `C:\Users\<user>\curseforge\minecraft\Instances` on Windows and `~/Documents/curseforge/minecraft/Instances` on macOS).
- **The mod's pointer file**, for anything else (an unknown launcher, a server folder). When the game starts, the mod writes `<user.home>/.autosketch/games/<hash of the game folder>.toml` with the game folder, Minecraft version, loader and pairing-file path, and deletes it when the game folder is gone. `user.home` is where the MCP already looks: the same home on one OS, and the Windows profile folder that WSL resolves (below). The mod's config can turn it off (`discovery.pointer`, default on). It is one small file per instance and the user opted in by installing the mod; *to check* against each site's rules on writing outside the game folder.
- **WSL.** When the server runs in WSL, it asks Windows for the user's profile folder (`cmd.exe /c echo %USERPROFILE%`, then `wslpath`, verified on the dev machine) and reads the same locations under it. It never searches all of `/mnt/c/Users`.
- Each candidate is checked before it is listed (a `mods/` folder or a version jar the asset registry can read, `02`), and listed with what the check found.

## Companion mod: CurseForge and Modrinth

### Publishing

- One tagged release publishes the same jars to both sites from CI (`mc-publish`, or Minotaur for Modrinth plus a CurseForge Gradle plugin), with the changelog from the tag.
- Side metadata: required on the server, optional on the client (B2's client half, `13`). In singleplayer the integrated server is the player's own game, so it goes in the client instance.
- Both sites accept a jar tagged with several game versions and loaders, so one build covers every version it actually runs on.
- **License.** Both pieces are `AGPL-3.0-or-later` (settled 2026-11-15; the mod was `-only` before), with no added Minecraft linking exception (declined by the user).
- *To check before submitting:* each site's current rules on mods that open a local socket or work with AI agents. The mod listens on loopback only and downloads no code.

### What has to change across versions, loaders and modpacks

Settled: the goal is modpack-, loader- and version-agnostic. Publishing to several versions is easy (above); what matters is what inside the mod has to differ. This section records the survey as input for that design, which is discussed separately. Measured from the current mod (77 Java files, about 6,300 lines, 2026-11-15):

**Loader-specific: 6 files.** `AutosketchMod`, `AutosketchConfig`, `AutosketchSetupEvent`, `WandEvents`, `WorldModule`, `PromptModule`. They cover entry point and lifecycle, server start and stop, the tick, command registration, the wand's click events, and config. Every other file (protocol and codec, bridge, volumes, hashing, patch applier, snapshots, chat) uses only vanilla types. The change tracker is a Mixin on `LevelChunk.setBlockState`, and Mixin works on NeoForge, Forge and Fabric alike. So a common module plus a thin module per loader (a MultiLoader or Architectury layout) costs little: the six files become three small sets.

**Version-specific: vanilla internals the common code touches.**

| Area | Why it varies | Affects |
|---|---|---|
| Block entity NBT | Item stacks moved to data components in 1.20.5; saving takes a registry provider from then on | Snapshots, patches, NBT hashing (`13`, *NBT*, *Hashing*) |
| Chunk sections and palettes | Accessors and storage change between versions | Snapshots, section hashes, the scan tracker |
| Names in the code | Mojang's own renames (for example `ResourceLocation` to `Identifier` in 1.21.11) and the move to unobfuscated releases | Compiling only |
| World height | Fixed −64..319 in vanilla but set per dimension, and changed by some packs | Volumes, snapshots |
| Networking payloads | The `CustomPacketPayload` API from 1.20.5 | B2's client half |
| Java version | 17 before 1.20.5, 21 after | Build toolchain |

**Range (settled).** The first public release follows Craftoria's profile: Minecraft 1.21.1 on NeoForge, Java 21. Other versions and loaders come after it through the layout below; none is promised yet.

**Build layout (settled).** The MultiLoader template's layout: a `common` module (everything that uses only vanilla types) and one thin module per loader, with no runtime library for players to install (Architectury would add one). Version differences inside a module go through Stonecutter (version-conditional lines in one source tree) rather than one git branch per Minecraft version.

**Config across loaders (settled: Cloth Config).** NeoForge and Forge have a built-in config system (`ModConfigSpec`, what the mod uses today); Fabric has none. A config library that exists on every loader removes the difference. Checked in the user's four packs (2026-11-15):

| Library | Craftoria (NeoForge 1.21.1) | ATM10 (NeoForge 1.21.1) | NightfallCraft (Forge 1.20.1) | Fabulously Optimized (Fabric 1.21.11) |
|---|---|---|---|---|
| Cloth Config | ✓ | ✓ | ✓ | ✓ |
| YetAnotherConfigLib | ✓ | ✓ | ✓ | ✓ |
| Resourceful Config | ✓ | ✓ | ✓ | — |
| Forge Config API Port | built-in API | built-in API | built-in API | ✓ |

Cloth Config is the choice (settled with the user 2026-11-15): it is in every pack checked, on all three loaders and from 1.20.1 to 1.21.11, so most players already have it, and CurseForge and the Modrinth App install a required dependency on their own. Its AutoConfig writes a plain config file on a dedicated server and gives a config screen on the client for free. The cost is one required dependency and rewriting `AutosketchConfig` (one file) away from `ModConfigSpec`; config files written by the current build are read once and migrated. YetAnotherConfigLib is as widespread but built around its client screens; Forge Config API Port would keep today's code but adds a mod on Fabric only.

**Tests across versions (settled for now).** Each extra version or loader gets a smoke test only: it builds, the GameTest server starts with the mod, and the bridge pairs. The full GameTest suite and the end-to-end tier keep running on the Craftoria profile only. Full coverage of the other targets remains to be done (`10`).

### Release naming and support rules (settled)

- **Name:** the mod is *Autosketch* on both sites and in the game's mod list (`mod_name`).
- **Jar:** the MultiLoader convention, `autosketch-<loader>-<minecraft version>-<mod version>.jar`, for example `autosketch-neoforge-1.21.1-0.1.0.jar`. Every jar goes into the same project on each site, tagged with its loader and game version.
- **Mod version:** semantic versioning. The major number goes up when the wire protocol changes incompatibly (the MCP's `N` and `N−1` rule below then tells the user which side to update), the minor number for features, the patch number for fixes. One version number covers every loader and Minecraft version it is built for, so `0.4.2` means the same features everywhere.
- **Which Minecraft versions get updates:**
  - **Active:** the newest Minecraft version that has a released NeoForge build, plus the Craftoria profile while Craftoria is our test pack. Get every release.
  - **Maintained:** any other version a supported major modpack still runs on (the largest packs on CurseForge and Modrinth for that version). Gets fixes and protocol updates, not necessarily new features.
  - **Dropped:** a version is dropped when it has been neither Active nor Maintained for 6 months, announced one release ahead in the changelog. Its last jar stays downloadable and keeps working with any MCP that still speaks its protocol (`N−1`).
- **New targets** (a loader or version) are added only when the smoke test passes, and are marked *smoke-tested* in the release notes until the full suite runs on them.

### Resource formats on the MCP side

Renders read block models, blockstates and textures from the instance (`02`), so the MCP must read each version's resource format. From the Minecraft Wiki's change history (*Model*, *Blockstates definition*, *Atlas*, *Resource pack*), the changes that matter for a block renderer, and where our reader (`src/assets/models.ts`) stands:

| Version | Change | Our reader |
|---|---|---|
| 1.19.3 | Texture atlases (`atlases/*.json`) list what gets stitched | Not needed: textures are resolved by path, block textures stay under `textures/block/` |
| 1.20.3 | PNG is the only texture format | Already PNG only |
| 1.21.2 | `light_emission` on model elements (0–15) | Ignored (affects lighting only); could brighten emissive faces |
| 1.21.4 | Item model definitions in `items/`; `overrides` removed from block models | Items only; block models unaffected |
| 1.21.6 | Element rotation no longer limited to multiples of 22.5° | *To check*: any snapping in the renderer |
| 1.21.11 | Elements rotate around several axes; blockstate variants gain a `z` rotation | **Missing**: `rotation` is read as one axis; variants as `x`/`y` only |
| 26.1 | Any model may use cutout or translucent textures; the `textures` map accepts objects (`sprite`, `force_translucent`) | **Missing**: texture entries read as strings |
| 26.3 | `shade` removed from elements; `shade_direction_override` added | Reads `shade`; would need the new field |

Nothing before 1.21.6 needs work, so Craftoria and every 1.18–1.21.5 pack are covered. The missing rows are work items for when a newer version becomes Active. No model or blockstate file carries a version field, so the reader accepts both old and new forms rather than switching on the game version. Loader-specific model formats (NeoForge's `neoforge_data` and custom model loaders, Fabric rendering-API models such as connected textures) are a separate question for each loader added.

**Modpack-specific: nothing in the mod.** The mod already treats every block as a state plus NBT and never names a mod. Pack variation reaches it in only two ways, both already handled: mods that write blocks without `setBlockState` (Axiom), covered by `tracker = "both"`, and multi-block structures, which the MCP's plugins describe (`09`). Pack knowledge lives in the MCP, in the asset registry (read from the instance) and in the plugins, and plugins are where versions of a single mod differ (Create 0.5 against Create 6 NBT, for example).

### Version-specific data lives in the mod (settled 2026-11-16)

**The problem.** The MCP carries its own per-version tables: release to `DataVersion` (`src/core/version.ts`, ending at 1.21.5) and every vanilla block's properties and default state (`data/vanilla/<version>.json`, fetched from minecraft-data). Each new release means new tables, and modded blocks aren't covered at all: the MCP guesses their properties from blockstate files, which miss properties that don't change the model (Create's `waterlogged`, FramedBlocks' `solid`; `13`, open question on modded states). **Where versions actually meet.** A document is transient: it belongs to the world it was made for, and anything meant to last is exported to a schematic format (`08`). So the version gap shows up when a lasting file comes in, not when a document is reopened: importing a `.schem`, `.bp` or `.nbt` made on another version (`doc_open({ path })`), and stamping prefabs, which the library keeps as `.schem` (`07`). Such a file can hold ids or NBT the running game rejects or reads differently (`grass` became `short_grass` in 1.20.3; item stacks in block entities moved to data components in 1.20.5). Import upgrades today with a small hand-kept table of vanilla renames (`src/formats/renames.ts`), which covers renamed ids only: no property changes, no NBT, no modded blocks.

**The idea.** The mod runs inside the exact game the world uses, so it can answer these questions from the game itself, correct for that version and that modset with no tables to maintain:

- **Registry report.** Every block with all its properties, allowed values and default state; block tags; which blocks have block entities; the game's `DataVersion`. From the live registries, so modded blocks are included with their full property sets.
- **Upgrades.** The game's own data fixer (`DataFixers.getDataFixer()`, the code that upgrades old worlds) upgrades block states and block entity NBT from an older `DataVersion` to the running one.

**How it reaches the MCP.**

- **Written at game start.** The mod writes the report to a file beside its pointer file (`<user.home>/.autosketch/games/<hash>.registry.json.gz`), so the MCP has it even when the game isn't running, once the game has been started with the mod. A protocol request returns the same report while linked, for a modset changed since.
- **Upgrades follow the established practice for schematic files** (below), with the mod as the host of the game's data fixer, since the MCP runs outside the game. This replaces the rename table while linked.
- **Order of trust in the MCP:** the mod's report, then the instance's files as today (`02`), then the bundled vanilla tables as the last fallback, kept only for drafting before the game has ever run with the mod. Unlinked imports fall back to the rename table.

**It also answers `13`'s modded-state question.** The registry report carries every property of every modded block, including the ones blockstate files leave out because they don't change the model (Create's `waterlogged`), so a typed `create:cogwheel` gets its full state and the game no longer rejects it as `unknown_state`. The two smaller options considered there were set aside: learning states from the link only knows blocks already seen in the world, and asking the mod per block works only while linked and does nothing for imports.

**What stays in the MCP.** Textures and models. A dedicated server has no client assets, and the mod is server-side, so rendering keeps reading the instance (`02`). Only data moves.

### Schematics from other versions: the established practice

Every format we read records the version it was written on, and every major tool upgrades the same way: forward, at load, through Minecraft's own data fixer (DataFixerUpper). We follow them rather than invent a scheme.

| Format | Version field | What its own tools do |
|---|---|---|
| Sponge `.schem` (WorldEdit, Axiom) | `DataVersion`, required since spec v2 "to provide validation and auto-conversion from older versions" | WorldEdit's reader runs the data fixer over blocks, block entities, entities and biomes. A v1 file has no `DataVersion`; readers assume the 1.13.2 era (FAWE uses 1631). |
| Structure `.nbt` (vanilla, Create) | `DataVersion` | The game upgrades the whole file with the `STRUCTURE` fix type when it differs from the running version, on every load (not cached). A file without one is treated as 500. |
| Litematica `.litematic` | `MinecraftDataVersion` | Runs the vanilla data fixer by default; warns when a file is more than 100 data versions ahead of the game; blocks the game lacks load as air. |
| MCEdit `.schematic` | None (numeric ids, pre-1.13) | Flattening maps from numeric ids to block states (Litematica's `BlockStateFlattening` maps; our legacy table, `08`), then the data fixer from 1.13 on. |
| Axiom `.bp` | `DataVersion` inside the block data (`08`) | Not documented: Axiom is closed source, and its docs (axiomdocs.moulberry.com, *Blueprint Browser*, *File*) say nothing about versions on load. The only version feature documented is exporting schematics for older versions (1.7 to 1.19), for Commercial License users. Treated like `.schem` until checked in game (open questions). |

So, for Autosketch:

- **Upgrade on import and prefab load, forward only.** A file older than the running game goes through the data fixer in the mod, with the fix type that fits it: the whole file as `STRUCTURE` for `.nbt`, and per element (block states, block entities, entities) for `.schem`, `.bp` and `.litematic`, as WorldEdit does. The file itself is never rewritten; prefabs stay as saved and are upgraded each time they load, as vanilla does with structures.
- **Missing versions take the formats' own defaults:** Sponge v1 as 1631, a structure as 500, MCEdit through the flattening table first.
- **Files newer than the game are never downgraded**, as no tool does. They import with a warning naming both versions. Blocks the game doesn't know are kept verbatim and reported (`01`), rather than turned to air as Litematica does, so nothing is lost silently.
- **Writing stamps the running game's version** (from the mod's report, else the instance's), and only that version: there is no export for older versions.
- **Unlinked** (no game running), imports fall back to the rename and legacy tables as today (`08`), with a warning that the upgrade was partial. `08`'s *Import* is updated when this is built.

**Limits.**

- **Vanilla only.** The data fixer covers vanilla's changes. Modded renames depend on each mod's own remapping, so modded blocks the running game doesn't know are reported by id, not guessed.
- **The mod's per-version code grows a little** (registry access and the data fixer API differ between versions), but that code lives in the mod's version branches (above), where version-specific code belongs anyway, and the MCP stops having any.

## Version skew between mod and MCP (settled 2026-11-16)

Today a protocol mismatch closes the link, which is right (`13`, *Version check*), but with separate releases it becomes common. Built with the first protocol change after the live link shipped (the request modes and scan messages of `13`'s backlog), so no pairing breaks from then on.

- The MCP supports its own protocol version and the one before it, so updating the MCP first never breaks a working setup. The mod speaks one version.
- Features gate on what the `hello`s list, as B6's `modes` do (`13`), not on version numbers.
- On a mismatch, both sides say which one is older and what to update: the MCP in the tool result, the mod on the action bar.

## Operator agent on other models (deferred)

Deferred by the user until later development. What was found, for when it comes back:

- Claude Code-specific today: in-game prompts through the `claude/channel` notification (`src/world/prompt.ts`), B3's token counts from Claude Code's OpenTelemetry events, and B5's auto memory. Client-neutral already: `world_reply`, B6's mode enforcement, scopes.
- Direction discussed: Claude Code stays the full tier; other agents get per-feature fallbacks through a runner that starts the user's own agent CLI in headless mode for each request (Codex `exec --json`, Gemini `-p` with JSONL events). The user's concern is not losing advantages that only Claude's harness gives, so this is tiers, not a lowest common denominator.
- Models differ in judging renders and in long tool sessions, which no harness changes. The eval harness's model driver (`10`, `test/eval/drivers/`) is where to measure that before claiming support.
- Until this resumes, B3 and B5 in `13` stay as settled.

## Open questions

- The launcher readers above come from source and docs; only CurseForge, Prism and vanilla were seen on a real machine. Check the others on a machine that has them.
- How Axiom treats an older `.bp` (closed source, undocumented). In-game check: write a `.bp` with `DataVersion` 3465 (1.20.1) holding `minecraft:grass` into Axiom's blueprint folder, open it in Axiom on 1.21.1, and see whether it places `short_grass` (upgraded), nothing or an error.
- The registry report's format and size on Craftoria (532 mods), measured before the file layout is fixed.

## Decisions

- **The management UI is the setup wizard, and has priority** (settled 2026-11-16, `15`, replacing "command line keeps priority"). A server with no remembered instance opens the UI at startup; the choice stays in `config.toml` until unlinked. `autosketch instances`, `setup` and `config` edit the same file for scripts. Launch options fill only what `config.toml` leaves unset. Reason: the user wants one place where setup is decided, seen once.
- **`node:sqlite` for Modrinth's instance list; `engines` raised to `>=22.13`** (settled 2026-11-16). Reason: no dependency and no native module.
- **The MCP speaks protocol `N` and `N−1`** (settled 2026-11-16). Reason: the mod and the MCP release separately, so updating either side first must never break a working setup.
- **Discovery reads launchers' own instance records first** (from the dev machine's CurseForge, Prism and vanilla files). Reason: they already hold folder, version and loader and follow moved folders, so nothing is guessed.
- **One-command install, with platform listings for credibility** (settled). Reason: the barrier for players is setup, and listings are where players judge trust.
- **No free-ranging search of the user's files** (settled). Reason: users don't want a tool roaming their home folder. Known locations, launcher configs and the mod's pointer cover the real cases.
- **The mod targets every pack, loader and version it can, published as one project per site** (settled as the goal; the range is open).
- **Model-agnostic operator deferred** (settled).
- **First release on Craftoria's profile** (NeoForge 1.21.1, settled). Reason: it is the pack the user builds on and the one every test runs against.
- **MultiLoader layout with Stonecutter** (settled). Reason: no runtime library for players, and one source tree for every version.
- **Cloth Config for the mod's config on every loader** (settled). Reason: it is already in every pack checked, on all three loaders, and gives a config file on servers and a screen on clients.
- **Smoke tests only for extra targets, for now** (settled); full coverage is recorded as outstanding in `10`.
- **Released as *Autosketch*, jars named by the MultiLoader convention, with the support rules above** (settled; the rules were proposed and accepted as a starting point).
- **`AGPL-3.0-or-later` for both the mod and the MCP** (settled). Reason: one license to explain, and later license versions apply without relicensing.
- **Version-specific data comes from the mod, not MCP tables** (proposed by the user, settled 2026-11-16). Reason: the mod runs on the world's exact version and modset, so its registry report and the game's data fixer are correct by construction, and the MCP needs no table per release. It also resolves `13`'s modded-state question.
