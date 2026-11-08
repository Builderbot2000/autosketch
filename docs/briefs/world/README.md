# Work briefs: live world link (`13`)

One brief per silo of the live world link and companion mod (`docs/design/13-live-world.md`). Each team reads the main [briefs README](../README.md) first (its rules for branching, file ownership, code style and *Done means* all apply), then this README, then its own brief, then the design docs the brief cites. `13` is the source of truth. A brief only scopes, sequences and assigns files.

Silo letters continue after the earlier sets and skip `M` and `W`, so they never read like the requirement numbers in `13` (M1–M13 for the mod, W1–W11 for the MCP).

| Silo | Brief | Wave | Requirements | Depends on |
|---|---|---|---|---|
| L | [Protocol and fake host](L-protocol.md) | 0 | W9, W10, wire format for M10/W1 | — |
| N | [Mod: skeleton, bridge, volumes, feedback](N-mod-bridge.md) | 1 | M1–M4, M10–M12 | L's protocol doc and golden vectors |
| O | [Mod: world I/O](O-mod-world-io.md) | 1 (after N's skeleton merge) | M5–M9 | N's skeleton, L |
| P | [MCP link core](P-link-core.md) | 1 | W1–W4, W8 | L |
| Q | [Sync and history safety](Q-sync-history.md) | 1 | W5–W7 | L; P's link object for auto-sync |
| S | [In-game requests](S-in-game-requests.md) (mod and MCP) | 2 | M13, W11 | N's skeleton and bridge, P's link object and event fan-out |
| R | [End-to-end and measurement](R-end-to-end.md) (setup: [test-setup.md](test-setup.md)) | 3 | open questions in `13` | everything above |

```
wave 0     wave 1                              wave 2     wave 3
L ──┬──► N: skeleton, bridge ──► N: rest ──┐
    │         └──► O ──────────────────────┼──────────────► R
    ├──► P: link object, fan-out ──► P: rest ┤
    │                                      └──► S ────────► R
    └──► Q: sync primitive ──► Q: rest ───────────────────► R
```

**Why this split.** The mod and the MCP share nothing but the protocol (`ARCHITECTURE.md`, *Dependency rules*), so the protocol is frozen first and both sides build against it: the MCP against L's TypeScript fake host, the mod against L's golden byte vectors. On each side the work splits at the natural seam: the mod into "talking to the MCP and the player" (N) and "reading and writing the world" (O); the MCP into "sending the cache to the world" (P) and "bringing the world into the cache, and keeping history honest" (Q). In-game requests (S) cut across both sides but touch little else, so one team owns the feature end to end and meets the others only at the protocol messages, N's command hook and P's event fan-out.

## Cross-silo contracts

These are the seams between silos. The owner lands the contract in its first merge, and the users code against it.

| Contract | Owner | Users | Shape |
|---|---|---|---|
| Wire protocol: framing, message schemas, binary encodings, protocol version | L | N, O, P, Q, S | `docs/design/13-live-world.md` gains a *Wire format* section; TS codec in `src/world/protocol/`; golden vectors in `test/data/world-protocol/` |
| Hashing: canonical NBT form, NBT hash, section hash, volatile-key list format | L | O (Java), P and Q (TS) | Defined in *Wire format*; TS reference in `src/world/protocol/hash.ts`; golden vectors with expected hashes |
| Fake host | L | P, Q, S | `test/support/fake-host.ts`: an in-memory world plus the mod's side of the protocol, with hooks for "player edits block", "drop connection", "game restarts" |
| Sync primitive | Q | P (ack handling) | `applyWorldState(doc, changes, opts) → EditResult`: writes world states into the cache as one `world_sync` journal entry; the only way world data enters the cache |
| Link object | P | Q (auto-sync, barrier) | `WorldLink` on the session: state, work and context volumes, `isDirty`, `syncNow()`, the bridge connection |
| "Does not push" marker | P | Q | How the patch sender recognises entries it must not send (`world_sync` entries). P defines it; Q's entries carry it |
| Mod skeleton | N | O, S | Gradle subproject, mod entry point, config, the message dispatch interface O and S register handlers on, a command hook S registers subcommands and the wand's focus mode on |
| Saved cameras | T ([camera brief](../T-cameras.md), outside this set) | S | `saveCamera(doc, name, camera)` and `render({ views: [{ camera: "player" }] })` (`06`, *Cameras*). If T hasn't merged, S keeps the player's view on the link and switches later |
| Event fan-out | P | S | A subscription to the base document's journal events and the `tool()` wrapper's `call.*` events, live even with observability off |

## Contested files

| File | Who touches it | Protocol |
|---|---|---|
| `src/document/document.ts` | P (journal subscription, entry marker), Q (guard composition, restore as one patch, sync barrier) | Additive only. P's subscription hook lands first. Rebase often |
| `src/scope/scopes.ts` | P (exports the sandbox write rule for the root scope, if private), Q (merge check relaxed for synced positions; guard composition with locks) | Additive only. P's export lands first. Keep behaviour unchanged when no link exists |
| `src/server/session.ts`, the `tool()` wrapper in `src/server/server.ts` | P (link on the session, `doc_open` argument), Q (auto-sync before a call) | P's change lands first; Q adds one hook |
| `src/server/index.ts` | P (wires `world/` in, like `observe/`) | P only |
| `src/core/events.ts` | P (`world.link`, `world.patch`, `world.sync` kinds) | P only; G's existing kinds unchanged |
| `docs/design/13-live-world.md` | L (*Wire format*), then every silo (*Implementation status*, resolved open questions) | L's section lands first. Others edit only their own rows and questions |

## Rules specific to these silos

- **Branch** from `main` at or after the commit that adds `13` and these briefs (not `5f94416` as the main README says), one branch per silo (`silo/<letter>-<slug>`).
- **The world is authoritative** (`13`, *Principles*). If a design choice could let the cache win a disagreement, or write over a hand edit without `overwriteHandEdits: true`, stop and raise it.
- **No tool imports `world/`**, and no tool result changes when no link is open. A linked document behaves exactly like an unlinked one, except for the `world:` lines `13` specifies.
- **Java code lives only in `mod/`**, and TypeScript code never reaches into it. The golden vectors in `test/data/world-protocol/` are the only shared files. Both sides' tests read them.
- **Refusals** are errors carrying `refusal: "<code>"` (main README, silo F convention). New codes: `sync_barrier`, `world_disconnected`. Writes outside the root's work volume reuse `11`'s `outside_work_volume`. Add them to the kinds table in `12`.

## Decisions

The decisions confirmed with the user on 2026-11-08 are recorded in `13` (*Decisions*, and the sections they cite). In short, with the owning silo:

1. **The player's volumes are the root scope.** The player sets a work and context volume in-game, the same volumes `11` gives a sandbox (N); the linked document reuses `11`'s re-origin, write rule and context ghosting (P); the agent writes only in the work volume, and player edits outside both volumes are ignored (O's tracker).
2. **A new work volume starts a fresh journal**; a context-only change syncs without relinking (P, with Q's sync).
3. **Same machine only.** The game on Windows and the MCP in WSL2 counts, through WSL mirrored networking (N documents the setup; P gives the error that names it).
4. **Expected NBT as a hash, and section hashes for drift** (L defines the canonical form and hash; O and P implement it identically; Q syncs by section).
5. **No `/autosketch undo`.**
6. **`restore` sends one patch** (P coalesces the steps between a restore's start and end).
