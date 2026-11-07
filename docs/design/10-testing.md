# 10 — Testing & Evaluation

Three tiers, all run through `vitest`. Only the eval tier needs network access or a model.

## Tier 1: unit (`test/unit/`, always runs, < 10 s)

- Conventions: region normalisation, inclusive↔half-open conversion, block-state parsing and canonicalisation, rotation/mirror state remapping (exhaustive over vanilla stairs, logs, doors, rails, multipart walls and fences).
- Voxel store: growth, normalisation, palette compaction.
- Ops: each op against small fixtures, with exact block-level assertions. Undo/redo invariants (apply → undo is the identity).
- Material expressions are deterministic for a given seed.
- Script sandbox: limits enforced, atomic rollback on error.

## Tier 2: golden (`test/golden/`, needs fixtures, runs in CI)

- **Format round-trips:** read → write → read is identical for `.schem` v2/v3, `.bp`, `.nbt`, including unknown blocks and block-entity NBT. Fixtures include real files saved from Axiom and Create in Craftoria (`test/fixtures/`, original builds only).
- **Asset pipeline:** a small synthetic instance (hand-made jars with original test textures) covers the VFS layering order, blockstate variants and multipart, parent chains, and the colour index.
- **Render snapshots:** renders of fixtures compared to golden PNGs within a perceptual tolerance.
- **Sheets:** layout determinism (same input → same cell map).
- **Analysis:** fixture buildings with known storeys, openings and roofs → expected `analyze` output.

### Optional local tier: `AUTOSKETCH_INSTANCE` set

Runs the asset pipeline against a real instance (Craftoria). It checks index time, registry size, unknown-model rate, and that palette families and sheets are produced. It is skipped in CI because the instance can't be redistributed.

## Tier 3: agent evaluation (`test/eval/`, opt-in, costs tokens)

This measures whether the perception and palette design actually help the agent. It is the core claim of the project.

- **Benchmark set:** about 15–25 prompts ranging from simple to architectural ("a 2-storey Tudor house with a jettied upper floor, front door facing south", "extend the existing wall with a gatehouse"), with seed documents where needed.
- **Runner:** drives a Claude model (default: latest Sonnet; configurable) against the MCP server through the Agent SDK, records the full transcript, tool calls, tokens and wall time.
- **Scoring:**
  - *Automatic checks* per prompt, written with the analysis API: storey count, door on the specified facade, roof watertight, no floating blocks, palette roles respected, within the bounding box.
  - *Model-graded* rubric over final renders (style match, proportion), with fixed judge prompts.
  - *Cost:* total tokens, image tokens, tool calls.
- **Ablations:** the same suite with features toggled (no `analyze`, no components, text-only, images-only, no palette sheets). This is how we decide which perception features earn their token cost.
- **Scoped sessions (`11`):** large builds done two ways, monolithically by one agent and with delegation to sandboxed subagents allowed. They are compared on cross-part consistency (matching reference lines, palette, repeated elements), defects, total tokens and wall time. This tests the premise that block-coordinate volume is the main cause of attention drift, and whether the delegation overhead pays off. Small and medium prompts in the main suite also record how often agents fork. There it should be almost never, which calibrates the skill's delegation threshold.
- **Results:** written to `test/eval/results/<date>-<git-sha>.json` plus a summary table. Regressions are compared against the last baseline.

## Commands

```
npm test            # tier 1 + 2
npm run test:local  # + real-instance tier (needs AUTOSKETCH_INSTANCE)
npm run eval        # tier 3 (needs ANTHROPIC_API_KEY)
```
