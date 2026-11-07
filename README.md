# Autosketch

A local, FOSS MCP server that lets AI agents build Minecraft schematics with high-level build actions, and helps them understand what they are building through renders, slices, structural analysis and palette sheets.

- Reads blocks and textures from **your own** Minecraft instance (vanilla or CurseForge, modded included). No game assets are shipped.
- Exports to **Axiom** (`.bp` / `.schem`) and **Create** (`.nbt`) schematics.

Status: early development. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

```
npm install
npm test                                        # unit + golden tests
AUTOSKETCH_INSTANCE=/path/to/instance npm run test:local   # against a real instance
```
