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

The server is pure JavaScript: rendering is software, the script sandbox is wasm, and no game assets ship (`02`). One npm package (`autosketch`, name free as of 2026-11-15) runs on every OS with `npx -y autosketch`, given Node 22.13 or newer.

| Route | Who it reaches | What it wraps |
|---|---|---|
| npm, `npx autosketch` | Everyone | The package |
| Official MCP Registry | Clients that browse the registry | A `server.json` pointing at the npm package (`mcpName` in `package.json`) |
| Claude Code plugin marketplace | Claude Code users | The MCP config, the knowledge files as skills, and a `channels` entry bound to the server (below) |
| MCPB bundle | Claude Desktop | The package with its production dependencies, run by Desktop's Node. No channels in Desktop, so building and the world link work but in-game prompts don't |
| GitHub releases | Everyone | Changelog, the MCPB bundle and the mod jar |

Settled: one-command install is the goal; listings on these platforms are for credibility.

**What a Claude Code plugin can declare for channels** (checked 2026-11-16 against the plugin manifest and channels references on code.claude.com). `plugin.json` has a `channels` array; each entry binds one of the plugin's MCP servers (`server`, plus optional `displayName` and `userConfig` prompted when the plugin is enabled). Declaring it doesn't turn the channel on: the user still starts Claude Code with `--channels plugin:autosketch@autosketch`, and during the research preview `--channels` accepts only plugins on Anthropic's allowlist (or the organisation's `allowedChannelPlugins`). Until Autosketch is on that list, the plugin's channel loads with `claude --dangerously-load-development-channels plugin:autosketch@autosketch`. Team and Enterprise organisations also need `channelsEnabled`. So the plugin carries the channel declaration (no extra configuration is needed, since pairing is through the mod's pairing file), and the setup step that remains is the launch flag. Getting onto the allowlist means submitting the plugin to Anthropic's directory (*Open questions*).

**Version.** One version for everything: `package.json`'s, copied into `server.json`, the MCPB manifest, the plugin (which runs `npx -y autosketch@<version>`, so a plugin version always runs its own server version) and `SERVER_VERSION` by `npm run package:version`; a unit test fails while they disagree. The first release is `0.1.0`.

**Publishing, once the accounts exist** (nothing has been published):

1. npm: create the `autosketch` package's owner account, make an automation (or granular, publish-rights) token, and add it as the repository secret `NPM_TOKEN`. Then `npm version <x>`, `npm run package:version`, commit, and push the tag `v<x>`: `.github/workflows/release-npm.yml` checks the secret first (and stops with an error naming it when it is missing, before building anything), checks the tag against `package.json`, runs typecheck and tests, publishes with provenance, builds the MCPB bundle and attaches it to a GitHub release for the tag.
2. MCP Registry: after the npm version is live, `mcp-publisher login github` as the `Builderbot2000` GitHub account (the `io.github.Builderbot2000/` namespace is proved by GitHub login), then `mcp-publisher publish` in the repository root (it reads `server.json`; the registry checks `mcpName` in the published `package.json`).
3. Claude Code plugin: the marketplace is the repository itself (`.claude-plugin/marketplace.json` → `packaging/claude-plugin`), so pushing it to GitHub is the listing: `/plugin install autosketch --marketplace Builderbot2000/autosketch`. A listing icon (square PNG, 512–2048 px) is still missing; submitting to Anthropic's directory is optional and a separate step.
4. Claude Desktop: the `.mcpb` from the GitHub release opens in Desktop. Submitting to Desktop's extension directory is optional and separate.

### Setup (settled: command-line options, plus the management UI)

The MCP client starts the server and owns its stdin and stdout, so the server can never show a prompt of its own. There is no interactive terminal wizard. The management UI (`15`) is the setup wizard: a server with no remembered instance opens it on its Instance tab at startup, and the choice is kept in `config.toml` until the user unlinks it (settled 2026-11-16, replacing the earlier "no graphical wizard"). The command line edits the same file, for scripts and READMEs.

- **`npx autosketch instances`** lists what discovery found, one line per instance with a short id, the pack's name, Minecraft version, loader, launcher and folder.
- **`npx autosketch setup --instance <id | path>`** saves the choice to `~/.autosketch/config.toml`, with optional `--workspace`, `--version` and `--base-jar` (as the server takes today). `--version` and `--base-jar` are saved as the top-level keys `version` and `baseJar` and apply only together with the `instance` they were saved with: choosing another instance or unlinking clears them (settled 2026-11-16). When the instance is a discovered one, its locator hints (a game jar outside the folder, as Modrinth App keeps it) are saved the same way. The choice is checked with the locator before it is saved, and refused with the reason when it can't be loaded. `--client claude` also registers the server with that agent client, printing the exact command it runs (`claude mcp add …`).
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
- **The mod's pointer file**, for anything else (an unknown launcher, a server folder). When the game starts, the mod writes `<user.home>/.autosketch/games/<hash of the game folder>.toml` with the game folder, Minecraft version, loader and pairing-file path, and deletes it when the game folder is gone. `user.home` is where the MCP already looks: the same home on one OS, and the Windows profile folder that WSL resolves (below). The mod's config can turn it off (`discovery.pointer`, default on). It is one small file per instance and the user opted in by installing the mod; neither site's rules address writing outside the game folder (*Site rules*, below), so the project description discloses it.

  **Pointer file format** (settled 2026-11-16; the contract between the mod, which writes it, and the MCP, which reads it; `src/assets/discover/pointer.ts` is the TypeScript reference). TOML, UTF-8, written whole (temp file, then rename):

  ```toml
  # Autosketch pointer file: written by the companion mod when the game starts.
  format = 1
  gameDir = "C:/Users/me/curseforge/minecraft/Instances/Craftoria"
  minecraft = "1.21.1"
  loader = "neoforge"
  loaderVersion = "21.1.262"
  pairing = "C:/Users/me/curseforge/minecraft/Instances/Craftoria/config/autosketch-bridge.toml"
  name = "Craftoria"
  modVersion = "1.0.0"
  updated = "2026-11-16T10:00:00Z"
  ```

  | Key | Required | Meaning |
  |---|---|---|
  | `format` | yes | `1`. A reader skips (with a warning) a format it doesn't know |
  | `gameDir` | yes | The game folder as the game's JVM reports it (`toAbsolutePath().normalize()`), written with `/` separators |
  | `minecraft` | yes | Minecraft version |
  | `loader`, `loaderVersion` | no | `neoforge`, `forge`, `fabric` or `quilt`, and its version; absent for vanilla |
  | `pairing` | no | The live-link pairing file (`13`, *Pairing file*), same path style |
  | `name` | no | Instance or pack name when the mod can tell; the reader falls back to the folder name |
  | `modVersion`, `updated` | no | The mod's version and when the file was written (ISO 8601 text) |

  Unknown keys are ignored, so later fields can be added without a format bump. Entries whose game folder no longer exists are dropped by the reader (the mod deletes them too). Under WSL, paths with a drive letter are converted with `wslpath`.

  **The game-folder hash** (the file name, computed the same way on both sides): take `gameDir` as above; replace every `\` with `/`; drop a trailing `/` unless the path is a drive root; if it starts with a drive letter (`C:/`), lower-case the whole path (Windows paths ignore case); then the first 16 lowercase hex characters of the SHA-256 of its UTF-8 bytes. Reference vectors (also in `test/unit/discover/discover.test.ts`): `C:\Users\Me\curseforge\minecraft\Instances\Craftoria` → `b5a55e002a16ad14` (the same for `c:/users/me/curseforge/minecraft/instances/craftoria/`); `/home/me/.local/share/PrismLauncher/instances/Pack/minecraft` → `c3225877496e34ed`. From WSL, the MCP turns `/mnt/c/…` into `C:/…` before hashing (`windowsFormOfWslPath`).
- **WSL.** When the server runs in WSL, it asks Windows for the user's profile folder (`cmd.exe /c echo %USERPROFILE%`, then `wslpath`, verified on the dev machine) and reads the same locations under it. It never searches all of `/mnt/c/Users`. The Windows `%APPDATA%` is taken to be `<profile>\AppData\Roaming` rather than asked for (unverified for profiles that redirect it).
- Each candidate is checked before it is listed (a `mods/` folder or a version jar the asset registry can read, `02`), and listed with what the check found.

## Companion mod: CurseForge and Modrinth

### Publishing

- One tagged release publishes the same jars to both sites from CI (`mc-publish`, or Minotaur for Modrinth plus a CurseForge Gradle plugin), with the changelog from the tag.
- Side metadata: required on the server, optional on the client (B2's client half, `13`). In singleplayer the integrated server is the player's own game, so it goes in the client instance.
- Both sites accept a jar tagged with several game versions and loaders, so one build covers every version it actually runs on.
- **License.** Both pieces are `AGPL-3.0-or-later` (settled 2026-11-15; the mod was `-only` before), with no added Minecraft linking exception (declined by the user).
- **Site rules (checked 2026-11-16, before the first publish).** Neither site has a rule on mods that open a local socket, that work with AI agents, or that write outside the game folder. What applies is disclosure and honest metadata:
  - *Modrinth* ([Content Rules](https://modrinth.com/legal/rules), last modified 2026-08-13). Network: the only rule is §1.11, against being "designed to upload any data to a remote server" without clear disclosure, where remote means a server "that the user does not directly choose to connect to in-game"; a loopback-only socket that uploads nothing is outside it. AI: §6.1 requires the *Contains AI-generated content* disclosure when "a substantial portion of the project's code is a product of AI output" or "the project's design or functionality relies on the use of generative AI", and §6.2 bars projects "primarily or entirely a product of AI output" and AI-generated images on the page. The mod calls no generative AI itself, but the repository history shows its code was written with an AI coding agent (Co-Authored-By lines), so **the disclosure very likely applies**; the user decides that, and how §6.2 reads for this project, before submitting. Files outside the game folder: not addressed. Metadata: §2 and §5.1 ask for accurate descriptions, environment information and content disclosures; §5.6 wants every dependency listed per version (Cloth Config is, by the workflow). The [Terms](https://modrinth.com/legal/terms) restrict using Modrinth content to train AI, not mods that talk to AI tools.
  - *CurseForge* ([Moderation Policies](https://support.curseforge.com/en/support/solutions/articles/9000197279-moderation-policies), modified 2026-10-22; [Mod Author Terms](https://legal.overwolf.com/docs/curseforge/mod-authors-terms), 2025-08-05). Network and files: nothing specific; §4.1(x) forbids malware and harmful code, and §3.1 asks for "accurately disclosing the permissions necessary for the Mod to function", the closest match to the socket and the pointer file. AI: the only rule is the *AI Misleading Content Disclosure* for AI-modified showcase images. The description must say what the project adds or changes, and every file needs a changelog (the tag message). No documented client/server environment field for Minecraft projects: the description states server-required, client-optional.
  - **Description, both sites:** the mod listens on 127.0.0.1 only for a local Autosketch MCP, sends nothing off the machine, downloads no code, writes `config/autosketch-bridge.toml` in the game folder and one pointer file in `~/.autosketch/games/` (config `discovery.pointer` turns it off), and is made for use with an AI coding agent. Open with CurseForge support: whether a home-folder write needs more than the description, and the environment setting for a server-side NeoForge mod.

### What has to change across versions, loaders and modpacks

Settled: the goal is modpack-, loader- and version-agnostic. Publishing to several versions is easy (above); what matters is what inside the mod has to differ. This section records the survey as input for that design, which is discussed separately. Measured from the current mod (77 Java files, about 6,300 lines, 2026-11-15):

**Loader-specific: 6 files.** `AutosketchMod`, `AutosketchConfig`, `AutosketchSetupEvent`, `WandEvents`, `WorldModule`, `PromptModule`. They cover entry point and lifecycle, server start and stop, the tick, command registration, the wand's click events, and config. Every other file (protocol and codec, bridge, volumes, hashing, patch applier, snapshots, chat) uses only vanilla types. The change tracker is a Mixin on `LevelChunk.setBlockState`, and Mixin works on NeoForge, Forge and Fabric alike. So a common module plus a thin module per loader (a MultiLoader or Architectury layout) costs little: the six files become three small sets. *Found during the restructure (silo X, 2026-11-16):* one more loader dependency hid in a vanilla-looking file, `InGamePrompts`, which kept the `/autosketch log` setting in `Entity.getPersistentData()`, a method NeoForge adds to a vanilla class. Compiling `common` against vanilla Minecraft caught it; it now goes through the `Platform` interface.

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
| 1.21.6 | Element rotation no longer limited to multiples of 22.5° | Checked: nothing snapped; the baker turns by the exact angle (`rotateElement` in `perception/render/bake.ts`) |
| 1.21.11 | Elements rotate around several axes (`x`, `y`, `z` angles in degrees, applied x then y then z; `axis` + `angle` still valid and wins when both are given; the ±45° limit is gone); blockstate variants gain `z` (0/90/180/270, applied after `x` and `y`) | Read: `parseElementRotation` gives the one-axis form when only one angle is non-zero (so both spellings bake identically), else `angles`; variant `z` in `ModelRef`, `rotateFace`, the baker, the registry's face textures and the camo plugin. `rescale` applies to one-axis rotations only (undocumented for several axes) |
| 26.1 | Any model may use cutout or translucent textures; the `textures` map accepts objects (`sprite`, `force_translucent`) | Read: an object entry ends the `#variable` chain at its `sprite`; `force_translucent` marks the face (`ModelFace.forceTranslucent`) and the baker draws it in the blended pass. Translucent pixels were already blended in any model |
| 26.3 | `shade` removed from elements; `shade_direction_override` added (a direction; faces are shaded as if they faced it, and `"up"` is the old `shade: false`) | Read: both; `ModelElement.shadeDirection` wins over `shade`. The named direction is used as written, not turned by the blockstate rotation (undocumented) |

Nothing before 1.21.6 needs work, so Craftoria and every 1.18–1.21.5 pack are covered, and every row above is now read (silo V, 2026-11-16; formats from the wiki's *Model* and *Blockstates definition* pages and the 25w46a and 26.3 Snapshot 3 changelogs; tested with synthetic models in `test/unit/assets/resource-formats.test.ts`). No model or blockstate file carries a version field, so the reader accepts both old and new forms rather than switching on the game version. Loader-specific model formats (NeoForge's `neoforge_data` and custom model loaders, Fabric rendering-API models such as connected textures) are a separate question for each loader added.

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

**The report file (format 1, built 2026-11-16).** UTF-8 JSON, gzipped, keys in a fixed order and blocks, properties and tags sorted, so the same modset gives the same bytes:

```json
{"format":1,"minecraft":"1.21.1","dataVersion":3955,"loader":"neoforge","loaderVersion":"21.1.249",
 "blocks":{"create:cogwheel":{"properties":{"axis":["x","y","z"],"waterlogged":["true","false"]},
                              "default":{"axis":"y","waterlogged":"false"},"blockEntity":true},
           "minecraft:stone":{}, …},
 "tags":{"minecraft:logs":["minecraft:oak_log", …], …}}
```

Property values are in the game's order; `properties` and `default` are left out for a block without properties, `blockEntity` unless true. Its hash (the protocol's `hash`, `13`) is the first 8 bytes of SHA-256 over the JSON. The MCP rejects other formats with a warning.

**Measured on the Craftoria server** (532 mods, 2026-11-16): 32,537 blocks from 192 namespaces (5,403 with a block entity), 2,509 block tags with 318,435 memberships. 16,021,961 bytes of JSON (4.6 MB of blocks, 11.4 MB of tags: a few tags such as mining tools' `mineable` list over 27,000 blocks each), 1,549,278 bytes gzipped; built and written in 509 ms on a worker thread at server start. The format stays as it is: 1.5 MB is small beside a 256 MiB frame and the files the MCP already caches, the tags compress well, and indexing tags by block number would only trade readability for a size nobody pays for.

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
- **Writing stamps the running game's version** (the linked game's, else the mod's report's, else the instance's), and only that version: there is no export for older versions.
- **Unlinked** (no game running), imports fall back to the rename and legacy tables as today (`08`), with a warning that the upgrade was partial. Built 2026-11-16 (`08`, *Import*).

**Limits.**

- **Vanilla only.** The data fixer covers vanilla's changes. Modded renames depend on each mod's own remapping, so modded blocks the running game doesn't know are reported by id, not guessed.
- **The mod's per-version code grows a little** (registry access and the data fixer API differ between versions), but that code lives in the mod's version branches (above), where version-specific code belongs anyway, and the MCP stops having any.

## Version skew between mod and MCP (settled 2026-11-16)

Today a protocol mismatch closes the link, which is right (`13`, *Version check*), but with separate releases it becomes common. Built with the first protocol change after the live link shipped (the request modes and scan messages of `13`'s backlog), so no pairing breaks from then on.

- The MCP supports its own protocol version and the one before it, so updating the MCP first never breaks a working setup. The mod speaks one version.
- Features gate on what the `hello`s list, as B6's `modes` do (`13`), not on version numbers.
- On a mismatch, both sides say which one is older and what to update: the MCP in the tool result, the mod on the action bar.
- The wire rules (which version the MCP says hello in, the mod's `features`, what changed in version 2) are in `13`, *Wire format*, *Versions and features*.

## Operator agent on other models (deferred)

Deferred by the user until later development. What was found, for when it comes back:

- Claude Code-specific today: in-game prompts through the `claude/channel` notification (`src/world/prompt.ts`), B3's token counts from Claude Code's OpenTelemetry events, and B5's auto memory. Client-neutral already: `world_reply`, B6's mode enforcement, scopes.
- Direction discussed: Claude Code stays the full tier; other agents get per-feature fallbacks through a runner that starts the user's own agent CLI in headless mode for each request (Codex `exec --json`, Gemini `-p` with JSONL events). The user's concern is not losing advantages that only Claude's harness gives, so this is tiers, not a lowest common denominator.
- Models differ in judging renders and in long tool sessions, which no harness changes. The eval harness's model driver (`10`, `test/eval/drivers/`) is where to measure that before claiming support.
- Until this resumes, B3 and B5 in `13` stay as settled.

## Implementation status

| Piece | Status |
|---|---|
| `config.toml` store | Done: `src/core/config.ts` (`readConfig`, `parseConfig`, `writeConfig`, `formatConfig`, `configPath`, `autosketchHome`). Reads `~/.autosketch/config.toml`, or `$AUTOSKETCH_HOME/config.toml`: `instance`, `version`, `baseJar`, `workspace` and `[settings]` (numbers, booleans and lists turned into the text a launch value would carry; tables and dates warned about and left out); unknown top-level keys are kept and written back. Unreadable TOML is an empty config with a warning. Writes are whole-file through a temp file and rename, refused with `ConfigConflictError` when the file's sha256 differs from the snapshot the caller edited (`ABSENT` for "no file yet"); `updateConfig` does read-change-write with retries, and `setInstance` / `unsetInstance` keep `version` and `baseJar` tied to the instance. A write drops comments in a hand-edited file. TOML parsing is `smol-toml` (pure JS, no dependencies). Tests set `AUTOSKETCH_HOME` to a temp folder (`vitest.config.ts`), so spawned servers never read the user's file. |
| Priority over the launch command | Done: `config.toml` `instance` and `workspace` beat `--instance` / `--workspace` and `AUTOSKETCH_INSTANCE` / `AUTOSKETCH_WORKSPACE` (`startupArg` in `server/context.ts`, `~` expanded). The launch `--version` and `--base-jar` are dropped when `config.toml` names a different instance, since they describe the launch one. Settings: `15`, *Implementation status*. Each overridden launch value is one stderr line at startup. `instance_info` says which source chose the instance (`chosen by config.toml`, `command line (--instance)`, `environment (AUTOSKETCH_INSTANCE)`). |
| `autosketch instances`, `setup`, `config` | Done: `src/cli/index.ts`, dispatched from `server/index.ts`. `instances [--json]` prints id, name, version, loader, launcher and folder, plus a *can't load yet* line from the check. `setup --instance <id \| path> [--workspace] [--version] [--base-jar] [--client claude]` resolves the id or path against discovery (`chooseInstance` in `src/assets/discover/choose.ts`, which the UI uses too), runs the locator check, and saves `instance` with `version` / `baseJar` (top-level keys in `config.toml`, cleared when the instance changes or is unlinked); `--client claude` prints and runs `claude mcp add --scope user autosketch -- npx -y autosketch`. `config set\|unset <key> [value]`: `instance` (same as `setup`), `workspace`, `version` and `baseJar` (only while an instance is saved), or any registered setting through its own `parse`; `config unset instance` unlinks. Writes go through `updateConfig` (read, change, compare-and-set write, retried on a conflict). |
| Not-configured start | Done: the server starts with no instance. Every tool except `instance_info` answers `not_configured` (an error result with the refusal code) listing up to 8 discovered instances with a `setup` command for each and the UI's URL on its Instance tab (`#tab=instance`); `instance_info` gives the same text without an error. `session.loadInstance(path, {version, baseJar})` loads in place while nothing is loaded or loading, else refuses with `instance_loaded`; after a failed load the session is unconfigured again. An instance saved in `config.toml` since startup (by `setup` or by hand) is loaded in place on the next tool call. With no `instance` in `config.toml`, the entry point opens the UI on `#tab=instance` at startup (`wantsSetupWizard`, `withFragment` in `server/setup.ts`; `observe.open=false` still stops the browser) and logs the URL; a launch `--instance` still loads meanwhile. The tab itself is silo K's (`15`, U4). |
| Instance discovery, pointer files, WSL | Done: `src/assets/discover/` (`discover()`, `discoverInstances()`), one reader per launcher in the table above, then pointer files, for the local profile and, under WSL, the Windows profile (`cmd.exe /c echo %USERPROFILE%`, `wslpath`; failures are a warning). Each reader tolerates missing files, tables and fields and falls back to listing the launcher's instance folder with a warning naming it. Modrinth's `app.db` is opened read-only with `node:sqlite` (loaded on first use, its experimental warning dropped) and only the statements in `MODRINTH_SQL` run (`settings.custom_dir`; `instances` joined to `instance_content_sets`, then bare `instances`, then `profiles`); GDLauncher's database is never opened. Every candidate goes through the locator (`checkInstance`) and is listed with what it found; one candidate per game folder, launcher records before pointers; ids are name slugs made unique. Tests use synthetic layouts only. **Unverified on a real machine:** the Modrinth App, ATLauncher and GDLauncher readers, the macOS and Linux locations of every launcher, CurseForge's `storage.json` shape, and the game-jar locations used as `baseJar` hints for Modrinth (`meta/versions/`), ATLauncher and GDLauncher. Verified shapes: CurseForge's record, Prism's config and instance files, the vanilla launcher's profiles (all on Windows). `engines` is `node >=22.13`. |
| Packaging and listings | Done, not published. `package.json`: version `0.1.0`, `mcpName` `io.github.Builderbot2000/autosketch`, bin `autosketch` → `dist/server/index.js`, `files` = compiled JS (no maps or typings), `data/` (minecraft-data's block table, MIT), the starter library (knowledge, palettes, original prefabs; not the builder script), `viewer/`, `server.json`, README, LICENSE; `prepack` cleans and builds. `npm pack`: 214 files, 450 kB, nothing derived from game or mod assets; `npx --package=<tarball> autosketch` with a temp `AUTOSKETCH_HOME` starts unconfigured, answers `initialize` and `tools/list`, serves the viewer and `three`, and runs `config set`. `server.json` (MCP Registry, schema 2025-12-11, npm over stdio, optional `AUTOSKETCH_INSTANCE` / `AUTOSKETCH_WORKSPACE`). MCPB: `packaging/mcpb/manifest.json` (manifest 0.3, node server at `server/dist/server/index.js`, `user_config` instance and workspace folders passed as env) and `npm run package:mcpb` (`scripts/build-mcpb.ts`: the packed package plus production dependencies, zipped with fflate to `build/autosketch-<version>.mcpb`, about 15 MB, mostly `three`); the unpacked bundle starts with the placeholder env Desktop may pass. Not checked with the official `mcpb validate` CLI or in Claude Desktop. Claude Code plugin: `packaging/claude-plugin` (`plugin.json` with the server as `npx -y autosketch@<version>` and a `channels` entry; six skills generated from `library/knowledge` by `npm run package:plugin`, checked current by a unit test) and the repository-root `.claude-plugin/marketplace.json`; both pass `claude plugin validate` (one warning: no icon). `npm run package:version` syncs the version everywhere. `.github/workflows/release-npm.yml`: on a `v*` tag, stops first without the `NPM_TOKEN` secret, then checks the tag, typecheck, tests, `npm publish --provenance`, the MCPB bundle and a GitHub release. The steps the user must take to publish are under *Package and listings*. |
| Registry report (silo V) | Done. The mod writes `<autosketch home>/games/<hash>.registry.json.gz` at server start (format and measurements above) and serves it as `registry` (protocol 3, `13`). The MCP reads the file for the instance at load (the folder or its `minecraft` subfolder, also in the Windows form of a WSL path) and asks the game on each connection, sending the hash it holds; the report goes on top of the registry in place (`assets/report.ts`): its properties, defaults, block-entity flag and tags win, blocks without a blockstate file are added, blocks only the assets know stay. `instance_info` says where block properties come from. Under WSL with the game on Windows, the file lives in the Windows home, which the MCP doesn't read: it gets the report once linked. E2e on Craftoria: `set_blocks create:cogwheel` is written as `create:cogwheel[axis=y,waterlogged=false]` |
| Upgrades (silo V) | Done. The mod's `upgrade` request runs the game's data fixer (`STRUCTURE` for a whole `.nbt`, `block_state`, `block_entity` and `entity` per element), forward only, on a worker thread (`data/Upgrades.java`). The MCP (`formats/upgrade.ts`, `world/upgrade.ts`) upgrades on `doc_open({path})`, prefab stamps and script prefab loads; defaults for missing versions, the newer-file warning and the unlinked fallback as above; exports stamp the version above (`Session.schematicVersion`). Checked against the real fixer in GameTests and on Craftoria (a 1.19.4 `.schem`: grass to short_grass, the sign's text into `front_text`). `.bp` and `.litematic` go per element like `.schem`; whether Axiom itself upgrades an old `.bp` is still open (below) |
| Resource formats (silo V) | Done: every row of *Resource formats on the MCP side* is read in `src/assets/models.ts` and drawn by `perception/render/bake.ts`. Synthetic fixtures check that each new form bakes the same quads as its old equivalent, and that a z-turned variant, a two-axis element, a 30° element, a direction override and `force_translucent` come out as specified. Not checked against a 1.21.11+ client: the order of blockstate `x` and `y` relative to each other is taken from before, `rescale` with several axes and `uvlock` with `z` are undocumented |
| Version skew, MCP side (`N`/`N−1`, silo Z) | Done (wave 0), against the fake host. Protocol version 2; the bridge (`src/world/bridge.ts`) speaks 2 and 1, saying hello in the pairing file's version when it speaks it and in 2 otherwise, so the mod can name the older side too. Mismatch results name the older side and what to update (`… the Autosketch mod is older; update the Autosketch mod.`); a stale pairing file is retried, not reported. Additions are used only when the mod's hello lists them (`Bridge.supports`); otherwise the request is refused `world_mod_outdated` without being sent. Version-1 golden vectors kept in `test/data/world-protocol/v1/` and round-tripped by the version-2 codec; the fake host speaks both (`test/unit/world/protocol-versions.test.ts`). |

### Companion mod (silo X)

| Item | Status |
|---|---|
| MultiLoader layout | Done. `mod/common` (vanilla types only: protocol, bridge, volumes, commands, feedback, world I/O, prompts, config, the change tracker's mixin, the lang file, JUnit tests) and `mod/neoforge` (entry point, NeoForge events, client config screen, `neoforge.mods.toml`, GameTests). `common` compiles against vanilla 1.21.1 through NeoForm with Mixin and Cloth Config's API compile-only; `neoforge` compiles common's sources and resources into its jar (the template's pattern), so players install one jar and no runtime library. The six loader-specific files were split: vanilla logic stays in common (`AutosketchCore`, `WandControl`, `WorldModule`, `PromptModule`, `api.AutosketchSetup`, `AutosketchConfig`), NeoForge glue in neoforge (`AutosketchMod`, `WandEvents`, `WorldEvents`, `PromptEvents`, `api.AutosketchSetupEvent`, same methods as before plus `setup()`). What common code needs from the loader goes through `platform.Platform`: the running server, the config folder, the loader name and version for `hello`, the player's saved mod data. The `api` package keeps its names. The moves are a commit of pure renames. |
| Build check: common is loader-free | Done. `checkNoLoaderImports` runs before `common` compiles and by `check`; it fails on any `net.neoforged`, `net.minecraftforge` or `net.fabricmc` name in common's sources and lists the lines. Compiling against NeoForm also fails on NeoForge's additions to vanilla classes. |
| Stonecutter | Done, one active target: Minecraft 1.21.1, NeoForge 21.1.249, Java 21. Stonecutter 0.9.8 with `common` and `neoforge` as branches of one tree, so they share the version list and the active version (`mod/stonecutter.gradle`). Projects `:common:1.21.1` and `:neoforge:1.21.1`; the version's dependency versions in `mod/versions/1.21.1/gradle.properties`. No version-conditional lines yet. Jar: `mod/neoforge/versions/1.21.1/build/libs/autosketch-neoforge-1.21.1-0.1.0.jar`. |
| Cloth Config | Done. `AutosketchConfig` is an AutoConfig `ConfigData` in common; `cloth_config` `[15,)` is a required dependency in `neoforge.mods.toml` (Craftoria ships 15.0.140). The file is `config/autosketch.toml`, written by the mod's own serializer in the old file's TOML layout (same sections, keys, comments and ranges), so the mixin plugin can still read `tracker` as text before the game loads. Out-of-range numbers clamp and invalid values reset, as `ModConfigSpec` did. The file is read at construction, on every server start, and within a second of changing while a server runs (NeoForge watched its config files). Clients get Cloth's config screen from the mod list (`client.AutosketchClient`, loaded on the client only). |
| Migration from `ModConfigSpec` | Done. On the first start without `autosketch.toml`, `config/autosketch-common.toml` is read once, every key and value kept, and renamed to `autosketch-common.toml.bak`; until then the mixin plugin reads the old file. JUnit tests cover a file in the old layout with every value changed; on the Craftoria test server the real file migrated with every key and value equal. |
| Tests | 32 GameTests pass (the 31 before plus one for the config reload), 90 JUnit tests including the config tests, and the e2e tier (`test/e2e/world/`, 8 scenarios) on the headless Craftoria server with the new jar and Cloth Config 15.0.140 (2026-11-16). The config screen was not opened in a client (no client run here).  Wave 2 (2026-11-16): 33 GameTests pass (the smoke test included) and the 3 new pointer JUnit tests pass; `GoldenVectorsTest` fails on main until silo Y's protocol-2 codec lands (expected, Y's). |
| Pointer file (wave 2) | Done. `discovery.PointerFile` (common) writes `<user.home>/.autosketch/games/<hash>.toml` on every server start, in the format above (`format`, `gameDir`, `minecraft`, `loader`, `loaderVersion`, `pairing`, `modVersion`, `updated`; no `name` yet), through a temp file and rename, and deletes pointers whose game folder is gone. It leaves alone files of another format, unreadable ones, and drive-letter paths seen from Linux. The hash matches J's reference vectors in JUnit, and files written by a GameTest run parse with `parsePointer` and hash to their file names. Config `discovery.pointer` (default on); off deletes this game's pointer. `AUTOSKETCH_HOME` or `-Dautosketch.home` replaces `~/.autosketch`; dev and GameTest runs use `mod/run/autosketch-home`. Wired with one line in `AutosketchCore.serverStarted`. Not done: removing V's `<hash>.registry.json.gz` beside a stale pointer (V's file). |
| Publishing workflow (wave 2) | Built, not yet run on GitHub. `.github/workflows/mod-release.yml`: a pushed tag `mod-v<version>` builds each target (loader check, jar, smoke GameTest, `releaseInfo`), runs `mod/release/preflight.sh`, then publishes each jar to both sites with `Kira-NT/mc-publish@v3.3.2`: version `<version>+neoforge-<mc>`, loader `neoforge`, game versions from `versions/<mc>/gradle.properties` (`release_game_versions`), Java 21, environment `server \| client?`, Cloth Config as a required dependency (Modrinth `9s6osm5g`, CurseForge `348521`, both checked), changelog from the annotated tag's message. Preflight fails and nothing publishes unless the tag matches `mod_version` and the secrets `CURSEFORGE_TOKEN`, `MODRINTH_TOKEN` and the variables `CURSEFORGE_PROJECT_ID`, `MODRINTH_PROJECT_ID` exist (the user adds them). A manual run is the dry run: jars and metadata as artifacts and in the run summary, problems as warnings. The build half and preflight were run locally (jar `autosketch-neoforge-1.21.1-0.1.0.jar`, metadata written); the workflows were not linted or run on GitHub. Unverified: how mc-publish maps `environment` onto each site. |
| Smoke test per target (wave 2) | Done. `SmokeGameTests` (its own GameTest namespace, `autosketch_smoke`) checks the pairing file, the pointer file, and a real socket pairing with a raw `hello` header; `./gradlew runSmokeTestServer` runs it alone, `runGameTestServer` runs it with the full suite. `.github/workflows/mod.yml` runs the smoke for each target (matrix, today `1.21.1`) without JUnit, so `GoldenVectorsTest` never blocks a target's smoke, and the full suite (JUnit and all GameTests) on the Craftoria profile. |

## Open questions

- The launcher readers above come from source and docs; only CurseForge, Prism and vanilla were seen on a real machine. Check the others on a machine that has them.
- How Axiom treats an older `.bp` (closed source, undocumented). In-game check: write a `.bp` with `DataVersion` 3465 (1.20.1) holding `minecraft:grass` into Axiom's blueprint folder, open it in Axiom on 1.21.1, and see whether it places `short_grass` (upgraded), nothing or an error.
- Which Node Claude Desktop runs an MCPB bundle with. The manifest asks for `>=22.13.0`; on an older Node only Modrinth discovery (`node:sqlite`) would fail, with a warning. Unverified, as is how Desktop passes an optional `user_config` field the user left empty (the server treats an empty value or an unexpanded `${user_config.…}` as unset).
- Whether to submit the plugin to Anthropic's directory, which is how its channel could get onto the `--channels` allowlist instead of needing the development flag.

## Decisions

- **The management UI is the setup wizard, and has priority** (settled 2026-11-16, `15`, replacing "command line keeps priority"). A server with no remembered instance opens the UI at startup; the choice stays in `config.toml` until unlinked. `autosketch instances`, `setup` and `config` edit the same file for scripts. Launch options fill only what `config.toml` leaves unset. Reason: the user wants one place where setup is decided, seen once.
- **`node:sqlite` for Modrinth's instance list; `engines` raised to `>=22.13`** (settled 2026-11-16). Reason: no dependency and no native module.
- **`setup --version` and `--base-jar` are saved as top-level `version` and `baseJar`, applied only with the `instance` they were saved with** (settled 2026-11-16). Reason: they describe one instance's layout, so they must never leak onto another one.
- **Pointer files are TOML named by a 16-hex-digit SHA-256 of the normalized game folder** (settled 2026-11-16, format above). Reason: one file per game folder, computable from either side, readable with the TOML parser the MCP already has.
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
