package dev.autosketch.mod.volume;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import org.jetbrains.annotations.Nullable;

/**
 * Per-player wand and feedback state: the current wand mode, pending corners of the work and context
 * modes, the {@code show} toggle and the notices setting. Kept in memory until the server stops.
 * Server thread only.
 */
public final class PlayerStates {
    public static final class State {
        public int mode;
        public final Corners work = new Corners();
        public final Corners context = new Corners();
        public boolean show;
        public @Nullable Boolean notices;
        /** Game time until which the wand's mode line stays off the action bar (a notice is showing). */
        public long actionBarBusyUntil;
    }

    /** Two corners in one dimension; setting a corner in another dimension forgets the other. */
    public static final class Corners {
        public @Nullable ResourceKey<Level> dimension;
        public @Nullable BlockPos first, second;

        /** Sets corner 1 or 2; true when both corners are now set. */
        public boolean set(ResourceKey<Level> dim, int corner, BlockPos pos) {
            if (!dim.equals(dimension)) {
                first = null;
                second = null;
                dimension = dim;
            }
            if (corner == 1) first = pos.immutable();
            else second = pos.immutable();
            return first != null && second != null;
        }

        public void clear() {
            first = null;
            second = null;
            dimension = null;
        }
    }

    private final Map<UUID, State> states = new HashMap<>();

    public State get(UUID player) {
        return states.computeIfAbsent(player, k -> new State());
    }

    public void clear() {
        states.clear();
    }
}
