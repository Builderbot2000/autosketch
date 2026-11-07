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

Loaded from `~/autosketch/plugins/*.js` (ESM). Plugins run with full trust, like any Node module, so this is documented clearly. A future option is to run them in the QuickJS sandbox with a restricted API.

## Open questions

- Where are FramedBlocks' and Copycats' camo NBT schemas documented? (Verify against blocks saved from Craftoria.)
- Connected textures (CTM, Fusion, Athena): approximate with the base texture in v1?
