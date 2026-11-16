# Silo X: Mod platform

**Wave 0** (restructure and config, alone in `mod/`), then **wave 2** (pointer file, publishing, smoke test).

**Specs:** `14` (*Companion mod: CurseForge and Modrinth*: *Publishing*, *What has to change across versions, loaders and modpacks*, *Release naming and support rules*, the pointer file under *Instance discovery*), `13` (*Mod requirements*, for what must keep working), `10` (smoke tier).

## Goal

The mod is built the way it will be published: a `common` module of vanilla-only code and a thin NeoForge module, Stonecutter ready for more versions, Cloth Config on every loader, and one tagged release that publishes the jar to both sites. Behaviour is unchanged.

## Deliverables, in merge order

1. **Restructure** (wave 0). The MultiLoader template's layout: `mod/common` and `mod/neoforge`, Stonecutter with one active target (Minecraft 1.21.1, Java 21). The six loader-specific files named in `14` (`AutosketchMod`, `AutosketchConfig`, `AutosketchSetupEvent`, `WandEvents`, `WorldModule`, `PromptModule`) move to `neoforge` or are split so their vanilla-only parts stay in `common`. The mixin stays in `common`. The public API package (`api/`) keeps its names. Pure moves in their own commit, so the history stays readable.
2. **Cloth Config** (wave 0). Rewrite `AutosketchConfig` with Cloth Config's AutoConfig; a required dependency in the mod metadata. Read an existing `ModConfigSpec` file once and migrate it, keeping every key and value. Client config screen through Cloth.
3. **Pointer file** (wave 2). On server start, write `<user.home>/.autosketch/games/<hash>.toml` in J's format (`14`); delete stale ones whose game folder is gone; config `discovery.pointer` (default on).
4. **Publishing** (wave 2). A tagged-release workflow publishing the same jar to CurseForge and Modrinth (`mc-publish`, or Minotaur plus a CurseForge plugin), named `autosketch-<loader>-<mc>-<version>.jar`, side metadata server-required and client-optional, changelog from the tag. Tokens come from repository secrets the user adds. Check and record both sites' rules (README, *Checks during the work*) before the first publish.
5. **Smoke test** (wave 2). Per target: it builds, the GameTest server starts with the mod, and the bridge pairs. Run in CI. The full GameTest suite and the end-to-end tier keep running on the Craftoria profile.

## Files you own

- `mod/**` during wave 0, alone. After the restructure merges: the build files (`settings.gradle`, `build.gradle`s, Stonecutter config, `gradle.properties`), `AutosketchConfig`, the pointer file module, `.github/workflows/` for the mod.

## Done when

- Every existing GameTest passes after the restructure, and `mod/common` compiles with no NeoForge imports (a build check, not a convention).
- A config file written by the previous build is migrated with all values kept, and the old file is left as a backup.
- The test server (`~/servers/craftoria`, which has Cloth Config 15.0.140) starts with the new jar, and the e2e tier (`test/e2e/world/`) passes against it.
- A dry-run of the release workflow produces a correctly named jar with both sites' metadata.
- The pointer file appears on server start and is removed when its game folder is gone.
- `14`'s mod rows have an *Implementation status* table, with the site-rule findings.
