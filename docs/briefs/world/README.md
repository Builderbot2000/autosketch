# Work briefs: live world link (`13`)

One brief per silo of the live world link and companion mod (`docs/design/13-live-world.md`). Each team reads the main [briefs README](../README.md) first (its rules for branching, file ownership, code style and *Done means* all apply), then this README, then its own brief, then the design docs the brief cites. `13` is the source of truth. A brief only scopes, sequences and assigns files.

Silo letters continue after the earlier sets and skip `M` and `W`, so they never read like the requirement numbers in `13` (M1–M12 for the mod, W1–W9 for the MCP).

| Silo | Brief | Wave | Requirements | Depends on |
|---|---|---|---|---|
| L | [Protocol and fake host](L-protocol.md) | 0 | W9, wire format for M10/W1 | — |
| N | [Mod: skeleton, bridge, region, feedback](N-mod-bridge.md) | 1 | M1–M4, M10–M12 | L's protocol doc and golden vectors |
| O | [Mod: world I/O](O-mod-world-io.md) | 1 (after N's skeleton merge) | M5–M9 | N's skeleton, L |
| P | [MCP link core](P-link-core.md) | 1 | W1–W4, W8 | L |
| Q | [Sync and history safety](Q-sync-history.md) | 1 | W5–W7 | L; P's link object for auto-sync |
| R | [End-to-end and measurement](R-end-to-end.md) | 2 | open questions in `13` | everything above |

```
wave 0          wave 1                                   wave 2
  L ──┬──► N (skeleton) ──► N (rest)
      │         └─────────► O ────────────────────┐
      ├──► P (bridge, link, patches, ack) ────────┼──► R
      └──► Q (sync primitive first, then          │
              auto-sync, barrier, merge) ─────────┘
```

**Why this split.** The mod and the MCP share nothing but the protocol (`ARCHITECTURE.md`, *Dependency rules*), so the protocol is frozen first and both sides build against it: the MCP against L's TypeScript fake host, the mod against L's golden byte vectors. On each side the work splits at the natural seam: the mod into "talking to the MCP and the player" (N) and "reading and writing the world" (O); the MCP into "sending the cache to the world" (P) and "bringing the world into the cache, and keeping history honest" (Q).

## Cross-silo contracts

These are the seams between silos. The owner lands the contract in its first merge, and the users code against it.

| Contract | Owner | Users | Shape |
|---|---|---|---|
| Wire protocol: framing, message schemas, binary encodings, protocol version | L | N, O, P, Q | `docs/design/13-live-world.md` gains a *Wire format* section; TS codec in `src/world/protocol/`; golden vectors in `test/data/world-protocol/` |
| Fake host | L | P, Q | `test/support/fake-host.ts`: an in-memory world plus the mod's side of the protocol, with hooks for "player edits block", "drop connection", "game restarts" |
| Sync primitive | Q | P (ack handling) | `applyWorldState(doc, changes, opts) → EditResult`: writes world states into the cache as one `world_sync` journal entry; the only way world data enters the cache |
| Link object | P | Q (auto-sync, barrier) | `WorldLink` on the session: state, region, `isDirty`, `syncNow()`, the bridge connection |
| "Does not push" marker | P | Q | How the patch sender recognises entries it must not send (`world_sync` entries). P defines it; Q's entries carry it |
| Mod skeleton | N | O | Gradle subproject, mod entry point, config, the message dispatch interface O registers handlers on |

## Contested files

| File | Who touches it | Protocol |
|---|---|---|
| `src/document/document.ts` | P (journal subscription, entry marker), Q (guard composition, restore as one patch, sync barrier) | Additive only. P's subscription hook lands first. Rebase often |
| `src/scope/scopes.ts` | Q (merge check relaxed for synced positions; guard composition with locks) | Q only. Keep the lock guard's behaviour unchanged when no link exists |
| `src/server/session.ts`, the `tool()` wrapper in `src/server/server.ts` | P (link on the session, `doc_open` argument), Q (auto-sync before a call) | P's change lands first; Q adds one hook |
| `src/server/index.ts` | P (wires `world/` in, like `observe/`) | P only |
| `src/core/events.ts` | P (`world.link`, `world.patch`, `world.sync` kinds) | P only; G's existing kinds unchanged |
| `docs/design/13-live-world.md` | L (*Wire format*), then every silo (*Implementation status*, resolved open questions) | L's section lands first. Others edit only their own rows and questions |

## Rules specific to these silos

- **Branch** from `feat/assets` at or after the commit that adds `13` and these briefs (not `5f94416` as the main README says), one branch per silo (`silo/<letter>-<slug>`).
- **The world is authoritative** (`13`, *Principles*). If a design choice could let the cache win a disagreement, or write over a hand edit without `overwriteHandEdits: true`, stop and raise it.
- **No tool imports `world/`**, and no tool result changes when no link is open. A linked document behaves exactly like an unlinked one, except for the `world:` lines `13` specifies.
- **Java code lives only in `mod/`**, and TypeScript code never reaches into it. The golden vectors in `test/data/world-protocol/` are the only shared files. Both sides' tests read them.
- **Refusals** are errors carrying `refusal: "<code>"` (main README, silo F convention). New codes: `sync_barrier`, `outside_world_region`, `world_disconnected`. Add them to the kinds table in `12`.

## Decisions taken for these briefs

These were open or unstated in `13`. The briefs assume the answers below. Each silo records the one it implements in `13` with the reason.

Confirmed by the user on 2026-11-08.

1. **Everything is bounded by the work region, both ways.** The agent's writes outside the region are refused (`outside_world_region`), the way a sandbox refuses writes outside its work volume; a linked document's bounds are the region and never grow. Player edits outside the region are ignored: the mod never tracks or reports them, and the read-only context shell is refreshed only by full syncs. (Owners: P for the agent side, O for the tracker.)
2. **Relinking starts a fresh journal.** A new region re-origins the document, and expected states recorded against the old box mean nothing in the new one. Checkpoints and saved selections are kept; checkpoints become unrestorable and say so. (Owner: P, with Q's sync.)
3. **v1 scope cuts:** the MCP and the game on the same machine (no remote servers), block states only in the guard (no expected NBT), no `/autosketch undo`. Each stays an open question in `13`. "Same machine" includes the dev setup of the game on Windows and the MCP in WSL2: the mod binds to loopback, and WSL2 reaches it with mirrored networking (`networkingMode=mirrored` in `%UserProfile%\.wslconfig`). Without mirrored networking, the mod would have to accept connections from the WSL virtual network, which needs a separate decision. N documents the setup; P reports a clear error when the port in the pairing file can't be reached.
4. **`restore` sends one patch** (`13`, *World undo and restore*), even though `Document.restore` steps through undo and redo one entry at a time. P coalesces the steps between a restore's start and end into one patch.
