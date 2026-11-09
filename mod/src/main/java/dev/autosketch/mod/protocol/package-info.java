/**
 * The bridge wire protocol, version 1 (docs/design/13-live-world.md, *Wire format*): framing, JSON
 * headers, binary bodies, deterministic NBT. Pure codec with no game state, tested byte for byte
 * against the golden vectors in {@code test/data/world-protocol/}. Owned by silo N; silos O and S
 * use it. Hashing (canonical NBT hash, section hash) builds on {@link dev.autosketch.mod.protocol.Nbt}.
 */
@ParametersAreNonnullByDefault
package dev.autosketch.mod.protocol;

import javax.annotation.ParametersAreNonnullByDefault;
