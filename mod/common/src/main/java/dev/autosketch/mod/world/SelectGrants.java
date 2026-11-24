package dev.autosketch.mod.world;

import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.protocol.Area;
import dev.autosketch.mod.protocol.Box;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import org.jetbrains.annotations.Nullable;

/**
 * The select-mode read grant (13, *Where the mod serves reads*, "Read grants in select mode"; 18,
 * *Decisions*): the square of chunks within {@code selectChunks} (Chebyshev) of the chunk of the
 * select prompt's position, in its dimension, full build height, fixed when the prompt goes out. One
 * grant at a time: a select prompt replaces it, and so do the connection closing and the server stopping. It carries the request's search and its
 * fill with it.
 */
public final class SelectGrants {
    private SelectGrants() {}

    /** The square of chunks granted: within {@code radius} of chunk ({@code centreX}, {@code centreZ}). */
    public record Grant(ResourceKey<Level> dimension, int centreX, int centreZ, int radius) {
        public boolean hasChunk(int cx, int cz) {
            return Math.max(Math.abs((long) cx - centreX), Math.abs((long) cz - centreZ)) <= radius;
        }

        /** Whether every chunk column a box touches lies inside (the square is convex: its two corner chunks suffice). */
        public boolean hasBox(Box b) {
            return hasChunk(b.minX() >> 4, b.minZ() >> 4) && hasChunk(b.maxX() >> 4, b.maxZ() >> 4);
        }

        public boolean hasColumns(Area a) {
            return hasChunk(a.minX() >> 4, a.minZ() >> 4) && hasChunk(a.maxX() >> 4, a.maxZ() >> 4);
        }

        /** Whether the grant is in the dimension the wire names. */
        public boolean in(String dimension) {
            return this.dimension.location().toString().equals(dimension);
        }
    }

    /** A grant in force and the request state it carries (the search, resumable with {@code continue}, and the fill {@code expand} grows). */
    public static final class Held {
        private final Grant grant;
        private volatile @Nullable SearchWalk search;
        private volatile WorldFill.@Nullable State fill;

        Held(Grant grant) {
            this.grant = grant;
        }

        public Grant grant() {
            return grant;
        }

        public @Nullable SearchWalk search() {
            return search;
        }

        void search(SearchWalk walk) {
            search = walk;
        }

        public WorldFill.@Nullable State fill() {
            return fill;
        }

        void fill(WorldFill.State state) {
            fill = state;
        }
    }

    private static volatile @Nullable Held current;

    public static @Nullable Held current() {
        return current;
    }

    /** Grants reads within {@code radius} chunks of {@code position}'s chunk, replacing any grant. */
    public static Grant set(ResourceKey<Level> dimension, BlockPos position, int radius) {
        Grant g = new Grant(dimension, position.getX() >> 4, position.getZ() >> 4, radius);
        current = new Held(g);
        return g;
    }

    /** The grant a {@code select} prompt at {@code position} gives: {@code selectChunks} from the config. */
    public static Grant forPrompt(ResourceKey<Level> dimension, BlockPos position) {
        return set(dimension, position, AutosketchConfig.get().select.selectChunks);
    }

    public static void clear() {
        current = null;
    }
}
