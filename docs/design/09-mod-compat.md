# 09 — Mod-Compatibility Plugins

Some mods add blocks whose meaning or appearance is defined by **code**, not by JSON assets: FramedBlocks and Copycats (appearance from a "camo" block stored in block-entity NBT), Chisel, Rechiseled and Chipped (large variant sets converted with a tool), connected-texture mods, and multi-block structures. Reading their composed textures directly gives poor results and huge, meaningless palettes.

Instead, a **plugin** for each such mod exposes:
1. **Knowledge** (grouping, render hints, state rules) to palette ingestion and the renderer.
2. **Code-based actions** that mirror the mod's own in-game logic, so the agent can do what a player would do with that mod. Conversion happens *on demand at action time*, without pre-converting the whole mod's content.

Plugins activate only when their mod's namespace is present in the instance.

**Plugins are never required.** Palette ingestion detects variant mods, camo mods, duplicates and dye series generically (`03`, "Instance-agnostic by design"), so an unknown modpack works with zero configuration. A plugin is only for what data can't express: render hooks for code-drawn blocks, NBT-driven appearance (camo), and agent actions that replicate a mod's own tools.

## Plugin API

```ts
interface AutosketchPlugin {
  id: string;                         // "framedblocks"
  namespaces: string[];               // ["framedblocks"]
  modVersions?: string;               // semver range tested against

  // Knowledge (all optional)
  classify?(block: BlockInfo): Partial<{ category; buildable: boolean }>;
  families?(registry: Registry): FamilyHint[];        // variant groups, shape links (03)
  rotate?(state: BlockState, rot: Rotation): BlockState; // state remapping overrides (01)
  render?(pos, state, nbt, ctx): BakedModel | null;   // e.g. draw framed block with camo texture
  items?(state, nbt): ItemStack[];                    // material list (08)
  validateNbt?(state, nbt): string[];                 // warnings

  // Actions (agent-facing)
  actions?: Record<string, PluginAction>;             // registered as "<id>.<name>" ops (05)
  docs?: string;                                      // markdown: exposed as a knowledge resource (07)
}

interface PluginAction {
  description: string;                // shown in ops_list; includes cost/side-effects
  params: ZodSchema;
  run(ctx: OpContext, args): OpResult; // must use the document API → journaled, undoable
}
```

- Actions go through the normal op pipeline: journaled, undoable, scriptable, and they return the standard result contract.
- `docs` explains the mod's building concepts in the shared vocabulary, so the agent learns *when* to use the mod, not just how.

## Built-in plugins (planned for Craftoria)

| Plugin | Knowledge | Actions |
|--------|-----------|---------|
| `framedblocks` | Framed shapes (slopes, corners, panels, pillars…) as a "shape family" independent of material. Renders with the camo's texture. Item list = frame + camo | `framed.shape(sel, shape, camo, state?)`: place framed shape blocks with a camo material. `framed.camo(sel, camo)`: re-skin existing framed blocks |
| `copycats` | The same idea for Copycats+ shapes | `copycat.shape(sel, shape, material)`, `copycat.camo(sel, material)` |
| `chisel`, `rechiseled`, `chipped` | Variant groups attached to base families (`03`). The chisel-group conversion graph, read from mod data where possible | `chisel.pattern(sel, pattern, { from? })`: convert blocks within their variant group, the same as the in-game chisel. `chisel.randomize(sel, patterns[])` |
| `create`, `createdeco` | Casings, sheet metals, girders, decorative blocks classified properly. Functional machines marked non-buildable | (later) `create.girder(path)` etc. |
| `vanilla` | The baseline rotation/mirror tables, code-drawn models, tint rules | — |

Unrecognised mods get the generic pipeline (`02`, `03`) with no special actions.

## Discovery and data-driven first

Where a mod publishes its logic as data (Chisel and Rechiseled variant groups as tags/JSON, Chipped as recipes), the plugin reads it from the instance. It does not hard-code lists. Hard-coded knowledge is a last resort, versioned against the mod version.

## Third-party plugins

Loaded from `<workspace>/plugins/*.js` and `*.mjs` (ESM; the workspace defaults to `~/autosketch`), in file-name order, when the instance loads.

**Full trust.** A plugin file is imported like any Node module and runs with the server's permissions: it can read and write files, use the network and start processes. Only put files there that you would run yourself. A future option is to run them in the QuickJS sandbox with a restricted API.

- The default export is one plugin, an array of plugins, or a function `({ z }) => plugin | plugin[]`. The factory form hands over the server's `zod`, because a plugin folder has no `node_modules` and action `params` must be zod schemas.
- A file that fails to import, or an export that isn't a valid plugin (id `[a-z0-9_-]`, non-empty `namespaces`, hooks are functions, actions have a description, zod params and `run`), is skipped with a warning in `instance_info`. It never stops the server.
- A plugin whose id matches a built-in one replaces it (with a warning), so a user can override built-in knowledge. A second file with an already-loaded id is skipped.
- The file's content hash becomes the plugin's `cacheKey`, part of the palette cache key, so editing a plugin rebuilds cached palettes.

## Discovering actions

`ops_list({ namespace? })` lists every active plugin's actions as `<plugin>.<op>(params) — description`, filtered by plugin id or mod namespace (05). The parameter signature is derived from the zod schema (`sel, shape: string, camo?: string`).

## Implementation status

| Item | Status |
|------|--------|
| Plugin API (`plugins/types.ts`) | `id`, `namespaces`, `modVersions`, `variantTagNamespaces`, `classify`, `families`, `render`, `items`, `validateNbt`, `actions`, `docs`, plus `cacheKey` (set by the loader). All but `id`/`namespaces` optional |
| `families` | Applied by palette ingestion after generic shape grouping: a hint's base heads a family even when it is a partial block, listed shapes and variants move into it, `category`/`buildable` override. Unknown ids are ignored |
| `render` | `render(pos, state, nbt, ctx)` returns a code model (cuboid elements, optional `overlay`, optional `tintFrom`: the block whose tint applies, e.g. a grass camo) or null. The baker tries hooks before the block's own model: `bake(state)` calls them with `pos`/`nbt` undefined (cached), `bakeAt(pos, state, nbt)` with the block entity (not cached). `ctx` gives the registry and any state's JSON model as parts, for re-skinning. `render.ts` bakes every block that has a block entity with `bakeAt` when a plugin has a render hook |
| `validateNbt` | Hook and `validateNbt(plugins, state, nbt)` helper (warnings prefixed by plugin id; a throwing hook becomes a warning). `documentNbtWarnings` runs it over a document's block entities, condensed to 5 distinct warnings with counts: import (`doc_open` with a path) and export report them. Camo ops don't call it: they write NBT through the same plugin's own layout function |
| `actions` | Typed (`description`, zod `params`, `run(ctx, args)`). Named `<opNamespace>.<name>`; `opNamespace` defaults to the plugin id (`framedblocks` uses `framed`, `copycats` uses `copycat`). `ops/plugin-actions.ts` runs them: `runPluginAction(doc, env, op, args, opts)` checks args against the zod schema and builds the context (`region(sel)` resolves like any op's selection, `edit(summary, body)` is one journal entry named after the op with auto-connection unless `raw`, `matcher(spec)`, `family(id)` from the palette, `variantNamespaces`). The `op_run({op, args, raw?})` tool calls it. Scripts bind to its synchronous twin `runPluginActionSync` (same checks and context; refuses an action that returns a promise and writes after the call returns); `opts.edit` lets a script run substitute its own single journal entry |
| `vanilla` code-drawn models | In `assets/builtin-models/`, not a plugin, so they work with plugins disabled (02). Chests (single and double halves, latch), shulker boxes, beds (head/foot, legs), standing/wall/hanging signs, standing/wall banners (cloth tinted by dye), mob heads (floor and wall) and the bell body (overlaid on its JSON frame). Hand-written geometry over the instance's own entity textures; a missing texture falls back to the particle texture, and UVs follow the real texture's aspect (packs redraw 64×32 skins at 64×64). Used only when a block's JSON model has no geometry, so packs with real models win. Not drawn: banner patterns, sign text, player skins from NBT, the conduit and decorated pot |
| `create` | Casings: buildable `metal` (generic rules put them in `wood`, as they are axe-mined). Full-cube machines with plain faces (chassis, gearshift, chute, packager, clutch, vault, …): non-buildable. `metal_girder`: a buildable partial-block family. Metal bars: panes of their metal block |
| `createdeco` | Each metal set grouped under `<metal>_sheet_metal`: door, trapdoor, bars (pane), mesh fence (fence), hull (variant). Corner, cracked and mossy bricks: variants of their colour's bricks (red: `minecraft:bricks`). Long, short and tiled bricks stay separate families (03). Shipping containers stay buildable despite their front face |
| Measured on Craftoria | `create` + `createdeco` change 98 block assignments (105 before the variant-tag head fix in `03`, which moved `minecraft:bricks` back to the head of its family): 21 Create families reclassified (6 casings to metal, 15 machines excluded), a girder family added, brass bars attached, 6 metal sets and 8 brick colours regrouped. (03's "plugins change ≤5 families" figure predates these two plugins) |
| Third-party loading | `plugins/loader.ts`, wired into instance loading. Full trust, documented above |
| `ops_list` | `server/tools/plugins.ts` |
| `framedblocks`, `copycats` | Classification (non-buildable shapes), plus `framed.shape(sel, shape, camo?, state?)`, `framed.camo(sel, camo)`, `copycat.shape(sel, shape, material?, state?)`, `copycat.camo(sel, material)` (`plugins/framed.ts`, shared machinery in `camo.ts`). Shape names resolve against the registry (`slope` → `framedblocks:framed_slope`; copycats also find Create's `copycat_panel`/`copycat_step`); an unknown shape lists the instance's shapes. `state` is written as given, since these blocks' properties aren't in their blockstate files. `camo` re-skins only owned blocks and keeps other NBT keys. Render hooks draw cube, slab, panel, stairs, slope (four steps), step, layer, pillar and post by `facing`/`half`/`type`/`top`/`axis`/`layers`, re-skinned per face with the camo's JSON-model textures; other shapes draw as a camo cube. Without a camo, framed blocks keep their JSON model or show the frame texture; copycats (no blockstate files) show Create's copycat base texture instead of the magenta fallback. `items`: frame + camo item. **NBT layouts unverified** (see below) |
| `chisel`, `rechiseled`, `chipped` | Variant grouping by tags. `chisel.pattern(sel, pattern, from?)` and `chisel.randomize(sel, patterns[], from?, seed?)` (`plugins/chisel.ts`, on the `chisel` plugin, active with any of the three namespaces). A block's conversion groups are its variant tags (plugin-declared and detected namespaces, `03`), the most specific first; blocks in no tag fall back to their palette family's variants in the same shape (vanilla mossy/cracked). Pattern names are the member's path minus the group name's words (`chipped:angry_bricks` is `angry` in `chipped:bricks`; `base` is the plain block), so one name converts every material that has it; a full id also works. Properties carry over where the target accepts them. A pattern nothing in the selection has fails with the available list; blocks lacking it are left as is with a warning. On Craftoria, andesite has 67 patterns and oak planks 39 |

## Open questions

- Where are FramedBlocks' and Copycats' camo NBT schemas documented? (Verify against blocks saved from Craftoria.) Unverified; no in-game samples are planned. Current best reading of the public source, isolated in `plugins/framed.ts` (`readFramedCamo`/`writeFramedCamo`, `readCopycatCamo`/`writeCopycatCamo`): FramedBlocks 10.x writes `camo: {type: "framedblocks:block", state: {Name, Properties}}` with block-entity id `framedblocks:framed_tile`; Create copycats write `Material: {Name, Properties}` and `Item: {id, count}` (id `create:copycat`; `copycats:copycat` for Copycats+ is a guess). Copycats+ multi-part blocks keep `material_data.<part>.material`, read but not written. Also unverified: FramedBlocks' and Copycats' block-state property names (`facing`, `type`, `top`, `half`), which only affect rendering, since states are written as given.
- Connected textures (CTM, Fusion, Athena): approximate with the base texture in v1?
- Some resource packs redraw entity skins with a different layout, not just a different size (the Craftoria skeleton skull draws transparent). Fall back to the particle texture when the sampled area is fully transparent?
