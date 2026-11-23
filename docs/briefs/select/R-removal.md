# Silo R: Scan removal

**Wave 3**, after P1, C1 and V2 (surface reads must already serve terrain before the scan grant goes).

**Specs:** `18` *Removal*, *Wire*; `13` B4, *Measured*, *Implementation status*.

## Goal

Take `scan` out of both sides in one merge, so the tree never has neither command.

## Deliverables

1. Mod: `ScanGrants`, the scan grant reads in `SurfaceReads` and `WorldReads` (surface reads stay, granted as select mode allows), `InGamePrompts.scan`, the `scan` subcommand, the `[scan]` config section with a migration that drops it cleanly, lang keys, `ScanGrantTest` and scan GameTests.
2. MCP: `src/world/probe.ts`, the `scan` mode and its prompt handling, `Session.adoptTemporary` if nothing else uses it, `test/unit/world/scan.test.ts`, the probe's golden vectors, scan references in `world-volumes.ts`, `fake-host.ts`, `fake-mcp.ts` and the e2e tests.
3. Wire: protocol bump retiring mode `scan` and `prompt.scan`; `protocol-versions` test updated.
4. Docs: `13`'s B4, *Measured* and *Implementation status* rows point to `18`; `README.md` and skills no longer mention scan.

## Files you own

Everything listed above, for deletion; the protocol bump (the one exception to W's ownership).

## Done when

`grep -rniw scan` over `src/`, `mod/*/src/main/` and `library/` finds nothing but unrelated uses; all tiers pass.
