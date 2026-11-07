# Autosketch

A local, FOSS MCP server that lets AI agents build Minecraft schematics with high-level build actions, and helps them understand what they are building through renders, slices, structural analysis and palette sheets.

- Reads blocks and textures from **your own** Minecraft instance (vanilla or CurseForge, modded included). No game assets are shipped.
- Exports to **Axiom** (`.bp` / `.schem`) and **Create** (`.nbt`) schematics.

Status: early development. Material palettes work; building tools are next. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Use with Claude Code

```
npm install && npm run build
claude mcp add autosketch -- node /path/to/autosketch/dist/server/index.js --instance "/path/to/your/minecraft/instance"
```

The instance is a CurseForge instance folder (e.g. `.../curseforge/minecraft/Instances/<pack>`), a vanilla `.minecraft` folder (add `--version 1.21.1`), or any folder with `mods/` plus `--base-jar <client.jar>`. Under WSL, Windows paths look like `/mnt/c/Users/<you>/...`.

The first start indexes the instance (tens of seconds for a large modpack); later starts load from `~/.cache/autosketch` in a few seconds.

### Tools (so far)

| Tool | What it does |
|------|--------------|
| `palette_sheet` | Tilemap image of the instance's building materials with chessboard cell ids (one-page overview, categories, families, dye series, zoom) |
| `palette_pick` | Assigns cell ranges to roles (wall, roof, trim…) as a named palette, used later as `palette:<name>.<role>` |
| `palette_show` | Describes saved palettes: blocks, colours, shapes available per role |
| `block_info` | Block properties, defaults, shape, family, variants; or search by name |
| `instance_info` | What instance is loaded, counts, warnings |

## Development

```
npm install
npm test                                        # unit + golden tests
AUTOSKETCH_INSTANCE=/path/to/instance npm run test:local   # against a real instance
```

## License

[GNU AGPL v3.0 or later](LICENSE). You may use, modify and redistribute Autosketch, but any distributed or network-hosted version (including a hosted MCP service) must make its complete source available under the same license.
