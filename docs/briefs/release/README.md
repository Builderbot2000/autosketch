# Work briefs: distribution, management UI and the live-world backlog

One brief per silo for the work settled on 2026-11-16: distribution (`14`), the management UI (`15`), the backlog from the first in-world test (`13`, *Backlog* B1–B6) and the version data that resolves `13`'s modded-state question. Each team reads the main [briefs README](../README.md) first (its rules for branching, file ownership, code style and *Done means* all apply), then the [world README](../world/README.md)'s rules where it touches `src/world/` or `mod/`, then this README, then its own brief. The design docs are the source of truth. A brief only scopes, sequences and assigns files.

The silo letters continue after the earlier sets. They skip `M` and `W` (requirement numbers in `13`) and `U` (the phases U1–U5 in `15`).

| Silo | Brief | Waves | Specs | Depends on |
|---|---|---|---|---|
| J | [MCP install and config](J-install-config.md) | 0, 1, 2 | `14` (MCP half), `15` *Settings tab* (the layer) | — |
| K | [Management UI](K-management-ui.md) | 1, 2 | `15`, `13` B3 | J's config layer (wave 0); J's discovery for U4 |
| X | [Mod platform](X-mod-platform.md) | 0, 2 | `14` (mod half) | — |
| Z | [MCP side of in-game requests](Z-requests-mcp.md) | 0, 1, 2, 3 | `13` B4–B6, `14` *Version skew* | — |
| Y | [Mod side of in-game requests](Y-requests-mod.md) | 1, 2 | `13` B1, B2, B4, B6 | X's restructure; Z's protocol additions |
| V | [Version data](V-version-data.md) | 3 | `14` *Version-specific data*, *Schematics from other versions*, *Resource formats*; `10` | X's layout; Z's version-skew support |

```
wave 0 (contracts)          wave 1                        wave 2                          wave 3
Z: protocol, N/N−1 ─────┬─► Z: B6, B5 ──────────────────► Z: B4 tool, probe ───────────► Z: e2e scenarios
                        └─► Y: B1, B6, B2 ──────────────► Y: B4 scan ──────────────────┘
X: restructure, Cloth ──┘   (mod/ opens to Y)             X: pointer file, CI, smoke
J: config.toml layer ───┬─► J: discovery, CLI ──────────► J: packaging
                        └─► K: U1, U2, B3 ──────────────► K: U3a, U4, U5, U3b
                                                                                         V: report, upgrades, resources
```

**Why this split.** Each silo owns one surface end to end: the MCP's install path (J), the browser UI (K), the mod's build and release (X), and the two halves of the in-game request work (Z on the MCP side, Y in the mod), which meet only at the protocol, as the world silos did. V crosses both sides because its two halves (the report and the upgrade in the mod, their consumers in the MCP) are one feature and meet at one new message pair.

**Why X goes first in `mod/`** (settled with the user). The restructure moves every Java file into a `common` module and a NeoForge module, and replaces the config system. Doing it before Y means Y's new code (wand, air mode, scan, modes) lands in the final layout and Cloth Config from the start, instead of being moved and migrated right after it is written. While X's restructure is open, nobody else edits `mod/`.

## Cross-silo contracts

The owner lands the contract in its first merge, and the users code against it.

| Contract | Owner | Users | Shape |
|---|---|---|---|
| `config.toml` store | J | K, X (pointer path), V | `src/core/config.ts`: read `~/.autosketch/config.toml` (TOML; `instance`, `workspace`, `[settings]`), write whole-file through a temp file and rename, with a content hash for compare-and-set. `AUTOSKETCH_HOME` overrides `~/.autosketch` for tests |
| Settings layer | J | K | `core/settings.ts` reads `config.toml [settings]` before `--set`, flag alias and env (`15`, *Settings tab*); `resolve()` reports each key's effective value, source and any launch value it overrides. `summary`, `group`, `applies` added as optional fields on `setting(…)` |
| Instance discovery | J | K (Instance tab) | `src/assets/discover/`: `discoverInstances(): Promise<Candidate[]>` with id, name, Minecraft version, loader, launcher, folder, check result and warnings |
| Pointer file format | J (written into `14`) | X (writes it), V (writes the report beside it) | `~/.autosketch/games/<hash of game folder>.toml`: game folder, Minecraft version, loader, pairing-file path. The hash is defined once in `14` (both sides compute it) |
| Protocol additions and `N`/`N−1` | Z | Y, V | `13` *Wire format*: `mode` on `prompt`, `modes` in the MCP's `hello`, `snapshot` kind `surface`, `volumes.set`; golden vectors in `test/data/world-protocol/`; fake host. The TS codec accepts the previous protocol version and gates features on `hello` |
| Mod layout | X | Y, V | `mod/common` (vanilla types only), `mod/neoforge` (the loader-specific files), Stonecutter set up with the one active target (1.21.1). Cloth Config `AutosketchConfig` in `common` |
| Registry report and upgrade messages | V | — | Report file format (measured first), `registry` request and `upgrade` request/response in *Wire format*, as a protocol bump that Z's `N−1` support absorbs |

## Contested files

| File | Who touches it | Protocol |
|---|---|---|
| `src/core/settings.ts` | J (layer, new fields, wave 0), then K (marks settings `live` one by one) | J's change lands first. K's changes are per-setting and small |
| `src/server/index.ts` | J (`instances`, `setup`, `config` subcommands; not-configured start; the wizard opening), K (`ui` subcommand), Z (none expected) | Additive. J's subcommand dispatch lands first, and K adds one case |
| `src/observe/http.ts`, `viewer/**` | K | K only. Z, J and V add nothing here; K's B3 adds the OTLP endpoint |
| `src/library/roots.ts` | K (`library.*` settings, `.trash/` skipped, `library.hidden`) | K only |
| `src/world/protocol/**`, `test/data/world-protocol/**`, `test/support/fake-host.ts` | Z (wave 0), then V (wave 3) | Z's additions land first. V's bump comes after and adds vectors without changing Z's |
| `docs/design/13-live-world.md` | Z (*Wire format*, B4–B6 status), Y (B1, B2, mod rows), V (status of the modded-state answer) | Each edits only its own rows and sections |
| `docs/design/14-distribution.md` | J (pointer format, setup status), X (mod status), V (version data status) | Same |
| `mod/**` | X (wave 0, alone), then Y, then V | X's restructure merges before anyone else branches into `mod/`. Y and V add files; shared files (`AutosketchConfig`, command registration) get additive changes only |
| `package.json` | J (`engines >=22.13`, `mcpName`, `files`, bin), K (none expected) | J only, apart from trivial rebases |

## Release gate

The first public release (`14`: Craftoria's profile, NeoForge 1.21.1) needs J's packaging, X's publishing and smoke test, Z's `N`/`N−1` support, and automatic instance choice (`16`, *Command line*; silo X of the in-game UI set), since that is how players without a `setup` get an instance: the one found is used, or the first tool result lists the candidates with the `setup` command. K's U4 setup wizard, which this gate named until 2026-11-17, was removed with the browser UI. V and the backlog are not gates.

## Checks during the work

- **Site rules** (X, before the first publish): CurseForge's and Modrinth's current rules on mods that open a local socket, work with AI agents, or write outside the game folder (the pointer file). Record the findings in `14`.
- **Claude Code plugin channels** (J): what a plugin can declare for channels, so the plugin listing can carry the in-game prompt setup or says why not.
- **Launcher readers** (J): Modrinth App, ATLauncher and GDLauncher readers are built from source and docs with synthetic fixtures. They stay marked unverified in `14` until someone checks them on a machine that has those launchers. Don't wait on it.
