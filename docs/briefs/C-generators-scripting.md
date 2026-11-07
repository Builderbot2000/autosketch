# Silo C: Generators, anchors and scripting

**Wave 2**, after silo A merges (generators use its transforms, auto-connection and `as:` on every op).

**Specs:** `05` (Generators L3, Anchors & relative placement, Scripting L4, Open questions), `07` (Procedures, for the script format only).

## Goal

Give the agent higher-level building: parametric architectural generators, placement relative to named geometry, and sandboxed scripts for anything repetitive.

## Deliverables

1. **Anchors and relative placement.** Implicit anchors on every component (`min`, `max`, `center`, `top`, `bottom`, face centres resolved through `front`), named anchors, and the `at:` forms in `05` (`"tower_ne.top"`, `{anchor, offset}`, `{face, u, v}`). `storey:n` reads component metadata now and analysis (silo B) when available. Results echo the resolved absolute coordinates.
2. **Generators:** `roof` (gable, hip, pyramid, shed, mansard, dome, flat; pitch, overhang; picks stair and slab shapes from the palette role), `arch`, `staircase`, `wall_run` (path, buttresses, crenellation), `tower` (polygon footprint plus roof), `window`, `door`, `column`. Each registers a component. Parameters stay open: generators are conveniences, not a style system.
3. **QuickJS sandbox** (`quickjs-emscripten`, new dependency): no filesystem, network or Node access; 64 MB and 10 s default limits; a script run is one journal entry that rolls back completely on error; `log()` capped at about 2 KB; returns the script's value plus a diff summary.
4. **Script API:** the same `sel`, ops, generators, `palette()`, `component()`, read-only `query()` and seeded `rand()`. The `sel.*` JS form compiles to the same JSON expression trees the tools use (`05`, *Implementation status*).
5. **Resolve the open question** on the script API surface: generate a `.d.ts` from the op registry and expose it as an MCP resource (use the resource registrar silo D adds).

Plugin actions inside scripts come later from silo E. Leave a registry hook they can add to.

## Files you own

- New: `src/script/**`, `src/ops/generators/**`, `src/ops/anchors.ts`, `src/server/tools/generators.ts`, `src/server/tools/script.ts`, matching tests.
- `package.json` (adding `quickjs-emscripten`).

## Done when

- The crenellation example in `05` runs as a script and undoes in one step.
- A script that throws halfway leaves the document unchanged. A script over the time or memory limit is stopped and reported.
- `roof` on a rectangular footprint with a palette whose roof role has no stairs warns and falls back as `03` describes.
- `05`'s status table covers generators, anchors and scripting.
