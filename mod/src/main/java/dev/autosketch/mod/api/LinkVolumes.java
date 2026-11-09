package dev.autosketch.mod.api;

import dev.autosketch.mod.protocol.Box;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import org.jetbrains.annotations.Nullable;

/**
 * The current link's volumes, as last sent in {@code volumes} (13, *Model*; *Wire format*,
 * {@code volumes}). {@code work} is the player's own box; {@code extended} the whole-block extension
 * the MCP declared with {@code volumes.extend}, while in force; {@code context} the effective
 * context boxes (default: work grown by 3), always non-empty. Immutable.
 */
public record LinkVolumes(long link, ResourceKey<Level> dimension, Box work, @Nullable Box extended, List<Box> context) {
    public LinkVolumes {
        context = List.copyOf(context);
    }

    /** The box patches may write and the tracker watches as work: the extension when declared, else the player's box. */
    public Box effectiveWork() {
        return extended != null ? extended : work;
    }

    /** Inside the effective work volume or any context box: the positions the link cares about. */
    public boolean contains(BlockPos p) {
        if (effectiveWork().contains(p)) return true;
        for (Box b : context) if (b.contains(p)) return true;
        return false;
    }
}
