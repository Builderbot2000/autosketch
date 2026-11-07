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

A binary container (magic header, NBT header with name, author, tags and block count, an embedded PNG thumbnail, and compressed NBT block data in 16³ region sections with paletted states plus block entities). **The exact layout must be verified** against blueprints saved by Axiom 6.1.5 before writing. The test fixtures will be real files saved from Craftoria. Writing `.bp` gives the user a proper thumbnail in Axiom's blueprint browser, rendered by our own renderer (`06`).

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

## Open questions

- Verify the Axiom `.bp` layout and whether Axiom reads `.schem` from `schematics/` or only from its own folder in 6.x.
- Check the Craftoria server's actual `maxTotalSchematicSize` (the server config may differ from the client default).
