# Autosketch

A local, FOSS MCP server that lets AI agents build Minecraft schematics with high-level build actions, and helps them understand what they are building through renders, slices, structural analysis and palette sheets.

- Reads blocks and textures from **your own** Minecraft instance (vanilla or CurseForge, modded included). No game assets are shipped.
- Exports to **Axiom** (`.bp` / `.schem`) and **Create** (`.nbt`) schematics.

Status: early development. Material palettes, documents, basic editing (fill, replace, undo, checkpoints, text slices), renders, and export/import of Axiom blueprints (`.bp`), Sponge `.schem` (Axiom, WorldEdit) and structure `.nbt` (Create) work. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Install

Needs Node.js 22.13 or newer. (Not published yet: these are the routes the first release will use.)

**Claude Code**, as a plugin (the MCP server plus its building skills):

```
/plugin install autosketch --marketplace Builderbot2000/autosketch
```

or as a plain MCP server, choosing the instance once:

```
npx -y autosketch instances                       # what was found in your launchers' folders
npx -y autosketch setup --instance <id> --client claude
```

Without a `setup`, the server uses the instance it finds when there is exactly one (preferring games that have run with the companion mod) and says so; with several, the agent's first tool call lists them with the `setup` command to run. A `setup` choice is saved in `~/.autosketch/config.toml` (`npx -y autosketch config unset instance` forgets it), and `npx -y autosketch config set <key> <value>` changes any setting. There is no browser page: with the companion mod, settings, the library, job volumes and replay are in the game (`docs/design/16-in-game-ui.md`).

**Claude Desktop**: open `autosketch-<version>.mcpb` from the GitHub release and choose your instance folder (or leave it empty to let the server choose, as above).

**From a checkout:**

```
npm install && npm run build
claude mcp add autosketch -- node /path/to/autosketch/dist/server/index.js --instance "/path/to/your/minecraft/instance"
```

Documents are saved to `~/autosketch/<name>/doc.autosketch` (change with `--workspace` or `AUTOSKETCH_WORKSPACE`).

The instance is a CurseForge instance folder (e.g. `.../curseforge/minecraft/Instances/<pack>`), a vanilla `.minecraft` folder (add `--version 1.21.1`), or any folder with `mods/` plus `--base-jar <client.jar>`. Under WSL, Windows paths look like `/mnt/c/Users/<you>/...`.

The first start indexes the instance (tens of seconds for a large modpack); later starts load from `~/.cache/autosketch` in a few seconds.

### Requests from inside the game

With the companion mod (`mod/`) and the live world link (`docs/design/13-live-world.md`), a player can type `/autosketch ask <request>` in the game while pointing at what they mean. The request reaches your running Claude Code session as a **channel** event, and the agent's activity and its `world_reply` answers appear in the game chat. Channels are a Claude Code research preview, so the session has to load the server as a channel. During the preview, a server that isn't on Claude Code's approved channel list loads with the development flag, which names the server as it is configured in `claude mcp` / `.mcp.json`:

```
claude --dangerously-load-development-channels server:autosketch
```

Installed as the plugin, the server is named by the plugin instead: `claude --dangerously-load-development-channels plugin:autosketch@autosketch`.

The server connects to the game on its own once it is running, and links as soon as you mark a work volume with the wand (hold a blaze rod, left-click one corner and right-click the other) (turn this off with `--set world.autoLink=false`, then the agent links with `doc_open({world: true})`). (`--channels server:autosketch` is the form for an approved channel.) This works only in interactive sessions. Without it, in-game requests would be dropped silently by Claude Code, so a session started without the flag doesn't link to the game on its own (it would take the link from the session that has it); `doc_open({world: true})` still links it on purpose.

**Who may ask.** A request turns into a prompt to an agent that can run commands on your machine, so the MCP checks every request against an allowlist before anything reaches the session. In singleplayer the host is always allowed. Anyone else, and everyone on a dedicated server, has to be listed by UUID (safer) or name: `--set world.promptPlayers=<uuid>,<name>`. Op level 2 is required in the game as well. Other settings: `world.promptIdleMs` (a request's chat stream closes after this long with no tool calls, default 5 minutes) and `world.activityMs` (at most one activity chat message per interval, default 2 s). In the game, `/autosketch log off|mine|all` picks what each player sees.

### Tools (so far)

| Tool | What it does |
|------|--------------|
| `palette_sheet` | Tilemap image of the instance's building materials with chessboard cell ids (one-page overview, categories, families, dye series, zoom) |
| `palette_pick` | Assigns cell ranges to roles (wall, roof, trim…) as a named palette, used later as `palette:<name>.<role>` |
| `palette_show` | Describes saved palettes: blocks, colours, shapes available per role |
| `block_info` | Block properties, defaults, shape, family, variants; or search by name |
| `instance_info` | What instance is loaded, counts, warnings |
| `doc_new` / `doc_open` / `doc_list` / `doc_info` | Start, reopen, list and summarise documents (one open at a time, autosaved) |
| `fill` | Fill a box with a material; modes fill, hollow, outline, walls; `as` registers a component |
| `set_blocks` | Place individual blocks (details: doors, lanterns, single stairs) |
| `replace` / `clear` | Swap blocks by id, state, tag or `*` (optionally keeping facing/half/axis); empty a box |
| `undo` / `redo` / `checkpoint` / `restore` / `history` | Every op is one undo step; named checkpoints for risky work |
| `view_slice` | One layer as a character grid with legend: plan (y) or elevation (x/z) |
| `render` | Textured views from your instance's own models: iso corners, elevations, top, custom cameras; 2×2 contact sheet, region zoom, cutaway |

Materials work anywhere a block does: `"stone_bricks"`, `"oak_stairs[facing=east]"`, `"a 70%, b 30%"`, `"palette:<name>.<role>"`, gradients, noise and patterns.

## Development

```
npm install
npm test                                        # unit + golden tests
AUTOSKETCH_INSTANCE=/path/to/instance npm run test:local   # against a real instance
```

### In-game test (internal, dev only)

`scripts/ingame-setup.sh` sets up a hands-on test in the real game client. Run it from the repo root in the VS Code integrated terminal (WSL):

```
bash scripts/ingame-setup.sh            # all three steps below, in order
bash scripts/ingame-setup.sh prep       # check WSL mirrored networking, build the MCP and the mod jar,
                                        #   replace autosketch-*.jar in the instance's mods/ folder
bash scripts/ingame-setup.sh wait       # wait until a world is open and the mod's bridge is up
bash scripts/ingame-setup.sh launch     # start Claude Code on the autosketch development channel
```

- The instance defaults to the Craftoria CurseForge instance. Set `AUTOSKETCH_INSTANCE` to use a different one.
- Close Minecraft before `prep` when the jar has changed: Windows locks loaded jars, and the script stops instead of half-installing. During `wait`, start the game and open a world (Creative, cheats on).
- Inside a Claude Code session, the `/ingame-setup` skill runs `prep` and `wait`. Launch the channel session from the terminal yourself.
- The in-client checklists are in `docs/briefs/world/test-setup.md` (section 3) and `docs/briefs/components/HANDOFF.md` (*Checks still to run*).

## License

[GNU AGPL v3.0 or later](LICENSE). You may use, modify and redistribute Autosketch, but any distributed or network-hosted version (including a hosted MCP service) must make its complete source available under the same license.
