# 08 — Formats & Export

Builds reach the server through either **Axiom** (instant paste, needs creative/op) or **Create** (survival, printed by a Schematicannon). Both are first-class export targets, selectable per export, with no round-trip through Axiom needed to produce a Create schematic.

## Supported formats

| Format | Ext | Read | Write | Used by |
|--------|-----|------|-------|---------|
| Sponge Schematic v2/v3 | `.schem` | ✅ | ✅ (v3 default, v2 option) | Axiom, WorldEdit, FAWE |
| Axiom Blueprint | `.bp` | ✅ | ✅ | Axiom blueprint browser |
| Vanilla structure NBT | `.nbt` | ✅ | ✅ | Create schematics, structure blocks |
| Litematica | `.litematic` | later | later | Litematica |
| MCEdit legacy | `.schematic` | later (needs a legacy ID map) | ✗ | old builds |
| Native | `.autosketch` | ✅ | ✅ | Autosketch (`04`) |

### Sponge `.schem` (v3)

gzip NBT. `Schematic { Version: 3, DataVersion, Width, Height, Length, Offset, Blocks { Palette, Data (varint), BlockEntities }, Entities?, Metadata }`. `Metadata` carries the autosketch name, author and front.

### Axiom `.bp`

Verified on 2026-11-07 against a real blueprint in Craftoria's `config/axiom/blueprints/`. Decoded block for block, it matched the same build's `.schem` (20.9M positions), and every section repacked to Axiom's exact bits.

```
int32 magic 0x0AE5BB36
int32 n + n bytes   header: uncompressed NBT {Name, Author, Tags[], BlockCount, ContainsAir (byte),
                    LockedThumbnail (byte), ThumbnailYaw 135f, ThumbnailPitch 30f, Version 2}
int32 n + n bytes   thumbnail: PNG, 96×96, transparent background
int32 n + n bytes   block data: gzip NBT {DataVersion, BlockRegion[], BlockEntities[], Entities[]}
```

- `BlockRegion` entries are 16³ sections `{X, Y, Z (section coords), BlockStates {palette, data}}`, packed like vanilla chunk sections: at least 4 bits per index, `floor(64/bits)` indices per long with none split across two longs, low bits first, index order x, then z, then y.
- `minecraft:void_air` marks positions the blueprint leaves untouched. `minecraft:air` (only with `ContainsAir`) clears them.
- Axiom saves blueprints centred on their own origin, so the reader finds the extent from the decoded blocks. The writer puts the minimum corner at (0,0,0) (`01`).
- **Not verified yet:** how block entities and entities are stored, because the fixture had none. The writer leaves them out and warns, pointing to `.schem`. The reader accepts block entities carrying `x/y/z` and otherwise warns.
- Writing `.bp` gives the blueprint browser a real thumbnail, rendered by our own renderer (`06`) from the south-east, matching Axiom's default yaw and pitch.

### Structure `.nbt` (Create)

gzip NBT. `{ DataVersion, size:[x,y,z], palette:[{Name, Properties}], blocks:[{pos, state, nbt?}], entities:[] }`. Create reads these from the client's `schematics/` folder and uploads them via the Schematic Table.

- **Size limit:** Create's server config `maxTotalSchematicSize` (Craftoria default **256 KB**, compressed file size). The exporter reports the compressed size and fails clearly when it is over the limit, offering to **split** into tiled sub-schematics with a placement guide (a list of offsets).
- Air handling: structure NBT omits air by default. With `creativePrintIncludesAir = false`, air is never printed anyway. Optionally, explicit `minecraft:air` entries can be written for clearing.
- **Material list:** a Create export also returns the item requirements (blocks → items, using the registry plus plugin hints, e.g. a FramedBlocks camo needs the framed block and the camo item). This is useful for survival planning.

## Export targets

```ts
export({
  format: "schem" | "bp" | "nbt" | "native",
  target?: "axiom" | "create" | "path",   // where to put it
  path?: string,
  name?: string,
  region?: sel,                           // export a part
  options?: { schemVersion?: 2|3, includeAir?: boolean, split?: boolean }
})
```

| Target | Writes to (Craftoria) | Default format |
|--------|------------------------|----------------|
| `axiom` | `<instance>/config/axiom/blueprints/` (`.bp`) or `<instance>/schematics/` (`.schem`) | `bp` |
| `create` | `<instance>/schematics/` | `nbt` |
| `path` | any path | from extension |

- Writing into the instance is the **only** place Autosketch writes into instance folders. It never overwrites a file without `overwrite: true`, and it reports the full path.
- After export, the result includes a one-line in-game hint ("Open Axiom → Blueprints → <name>", or "Schematic Table → select <name>").

## Import

`doc_open` and `prefab` loading accept every readable format. Imports keep unknown blocks, block entities and entities verbatim (`01`). A DataVersion mismatch produces a warning. Block upgrade (DFU-style renames between versions) is out of scope for v1 beyond a small rename table.

## Implementation status

| Piece | Status |
|-------|--------|
| Sponge `.schem` | Writes v3 (default) and v2. Reads v1–v3. Palette states are canonicalised on import. States the registry rejects or doesn't know are kept verbatim, with a warning. Checked against an independent NBT reader (nbtlib). |
| Structure `.nbt` | Reads and writes. Air is omitted unless `include_air` is set. A file with several `palettes` imports its first palette, with a warning. |
| Axiom `.bp` | Reads and writes, with a rendered thumbnail. Block entities and entities are left out on write, with a warning. `test/local/blueprints.test.ts` checks every blueprint in a real instance: decode, bit-exact repacking, round-trip, and equality with a `.schem` twin when one is present. |
| Create size limit | Read from `<instance>/config/create-server.toml` (then `defaultconfigs/`), defaulting to 256 KB. Over the limit, the export fails unless `split` is set. Split pieces come from halving the longest axis, are named `<name>_1…n`, and come with a `<name>_placement.txt` guide. |
| Material list | Covers vanilla's systematic block → item cases: wall variants, crops, doors, beds and tall plants counted once, double slabs, candles, pickles, eggs, petals, snow layers, potted plants. Fluids, portals and technical blocks are listed as not printable. Plugins can answer for their own blocks through `items(state, nbt)` (`09`). |
| Targets | `axiom` writes `.bp` to `<instance>/config/axiom/blueprints/`, or `.schem` to `schematics/` with `format:"schem"`. `create` writes to `<instance>/schematics/`. `path` writes to any file or folder. With no target, the export goes to `<workspace>/<doc>/exports/`, the only place exports may overwrite without `overwrite:true`. |
| Import | `doc_open({path})` creates a new workspace document named after the file. Block entities and entities are kept. A DataVersion mismatch produces a warning. |
| Entities | Stored in the document with `Pos` in document coordinates. Exports translate them with the blocks and drop those outside the exported region. |

## Open questions

- How does `.bp` store block entities and entities? This needs a blueprint containing a chest or sign and an armor stand or item frame.
- Does Axiom read `.schem` from `schematics/`, or from `config/axiom/blueprints/` next to `.bp` files?
- Does Axiom accept a blueprint Autosketch wrote? Confirm by opening one in the blueprint browser.
- Check the Craftoria server's actual `maxTotalSchematicSize`. The local `config/create-server.toml` says 256, but a server sets its own value per world (`serverconfig/`).
