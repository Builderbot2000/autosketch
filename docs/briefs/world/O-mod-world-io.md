# Silo O: Mod world I/O

**Wave 1**, starting from silo N's skeleton merge. Codec work can begin from L's golden vectors before that.

**Specs:** `13` (*Agent → world: patches*, *World → agent: sync*, *Companion mod requirements*, *Open questions*: throughput, change tracking, snapshot cost), L's *Wire format* section.

## Goal

Read and write the loaded world exactly as `13` requires: conditional (compare-and-set), side-effect-free patch writes under a tick budget, snapshots of the work and context volumes, and a change tracker that catches every block change the mod didn't make itself.

## Deliverables, in merge order

1. **Conditional patch applier** (M5, M6): for each position, compare the world's current state with the expected one, and when the patch carries an expected NBT hash, hash the world's block entity (canonical form from L, volatile keys from the list in `hello`) and compare that too; write on match, skip and record the actual state and NBT on mismatch; reject states the game can't parse (never write air). Write with no neighbour updates, physics, drops or light glitches left behind (set the block with update flags that suppress neighbour and shape updates, then fix lighting the way WorldEdit and Axiom do). Remove old block entities and load new ones from the patch NBT. Leave entities alone (M12). `overwriteHandEdits` patches skip the precondition and report how many positions differed.
2. **Ordering and budget** (M7): a queue applied on server ticks, strictly in patch id order, at most the configured number of blocks per tick. A patch in progress is visible part-way. `patch.ack` once a patch finishes. Expose pending count and last result to silo N's `/autosketch status`.
3. **Snapshots and section hashes** (M8): the work and context volume boxes, whole or by a list of chunk sections, states and block-entity NBT, encoded as L specifies. Section hashes on `hashes`. Read on the server thread in bounded slices so large volumes don't stall a tick; encode and hash off-thread. Java hashing passes L's hash vectors.
4. **Change tracker** (M9): every block change inside the work or context volume that is not one of the mod's own patch writes, from any source (players, Axiom, pistons, explosions, fluids, other mods). `13` expects this to need a mixin on chunk block-state writes. Mark the mod's own writes so the tracker ignores them. Changes outside both volumes are ignored, never reported (README *Decisions* 1). Batch into `dirty` messages; switch to "everything" past L's cap. Keep the per-write cost on chunks outside the volumes to one cheap check.
5. **Fallback tracker**: periodic comparison of the mod's own section hashes, reporting changed sections as dirty, selected by config, in case the mixin conflicts with something in Craftoria (`13`, *Open questions*). Silo R decides which is default.

## Files you own

- The `…world` package (or whatever N's skeleton names it) in `mod/`, the mixin config, and their tests.

## Notes

- GameTests for each rule: a matching expected state writes; a mismatch skips and reports the actual state; a chest whose items changed (same state) is skipped by its NBT hash; a lit furnace whose burn time ticked is not skipped; an unknown state is rejected; sand placed mid-air doesn't fall; a placed water source doesn't flow; breaking a chest drops nothing; a 100k-block patch spreads across ticks in order; a piston push inside the work volume, and a block broken in the context volume, each produce a `dirty`; a change outside both doesn't; the mod's own writes don't.
- Measure as you go: blocks per tick before a tick exceeds 50 ms on the GameTest server, and snapshot time per million blocks. Record the numbers in `13`; silo R repeats them on Craftoria.

## Done when

- All the GameTests above pass headless.
- The precondition and ack match L's fake host on the same inputs (feed the same patch and starting world to both and compare acks).
- `13`'s rows M5–M9 are marked done, with measured numbers next to the throughput and snapshot open questions.
