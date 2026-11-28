package dev.autosketch.mod.world;

import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.protocol.Area;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.ErrorCodes;
import dev.autosketch.mod.protocol.ProtocolException;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import org.jetbrains.annotations.Nullable;

/**
 * The read area outside the volumes (13, *Where the mod serves reads*): the select-mode read grant
 * ("Read grants in select mode"; 18, *Decisions*) and the canvas ("Reads inside the canvas"; 19,
 * *Model*). The grant is the square of chunks within {@code selectChunks} (Chebyshev) of the chunk of
 * the select prompt's position, in its dimension, full build height, fixed when the prompt goes out;
 * one at a time, replaced by the next select prompt and dropped when the connection closes or the
 * server stops. The canvas is set by the volume side ({@link #canvas}) and lasts until it changes.
 * Inside either the mod serves the same reads by the same code: {@link #area} is their union in one
 * dimension. The search and the fill state ({@link Held}) is one per connection and is dropped by a
 * new grant or a canvas change.
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

    /** The canvas's chunk columns, {@code minCx..maxCx} by {@code minCz..maxCz} (19; whole columns, full build height). */
    public record Canvas(ResourceKey<Level> dimension, int minCx, int minCz, int maxCx, int maxCz) {
        public static Canvas of(ResourceKey<Level> dimension, Box b) {
            return new Canvas(dimension, b.minX() >> 4, b.minZ() >> 4, b.maxX() >> 4, b.maxZ() >> 4);
        }

        public boolean hasChunk(int cx, int cz) {
            return cx >= minCx && cx <= maxCx && cz >= minCz && cz <= maxCz;
        }

        long chunks() {
            return (long) (maxCx - minCx + 1) * (maxCz - minCz + 1);
        }
    }

    /**
     * What may be read in one dimension: the grant's square, the canvas, or both (their union; 13,
     * *Reads inside the canvas*). At least one is set.
     */
    public record ReadArea(ResourceKey<Level> dimension, @Nullable Grant grant, @Nullable Canvas canvas) {
        public boolean hasChunk(int cx, int cz) {
            return (grant != null && grant.hasChunk(cx, cz)) || (canvas != null && canvas.hasChunk(cx, cz));
        }

        /** Whether every chunk column of {@code minCx..maxCx} by {@code minCz..maxCz} lies inside. */
        boolean hasChunks(int minCx, int minCz, int maxCx, int maxCz) {
            boolean g = grant != null && grant.hasChunk(minCx, minCz) && grant.hasChunk(maxCx, maxCz);
            boolean c = canvas != null && canvas.hasChunk(minCx, minCz) && canvas.hasChunk(maxCx, maxCz);
            if (g || c || grant == null || canvas == null) return g || c;
            // Both set and neither holds it alone: column by column, unless it has more columns than both together.
            long n = (long) (maxCx - minCx + 1) * (maxCz - minCz + 1);
            if (n > (long) (2 * grant.radius() + 1) * (2 * grant.radius() + 1) + canvas.chunks()) return false;
            for (int cx = minCx; cx <= maxCx; cx++)
                for (int cz = minCz; cz <= maxCz; cz++)
                    if (!hasChunk(cx, cz)) return false;
            return true;
        }

        public boolean hasBox(Box b) {
            return hasChunks(b.minX() >> 4, b.minZ() >> 4, b.maxX() >> 4, b.maxZ() >> 4);
        }

        public boolean hasColumns(Area a) {
            return hasChunks(a.minX() >> 4, a.minZ() >> 4, a.maxX() >> 4, a.maxZ() >> 4);
        }

        /** Where a search without {@code around} starts: the grant's centre, else the canvas's middle chunk ({@code (min + max) >> 1}). */
        public int centreX() {
            return grant != null ? grant.centreX() : (canvas.minCx() + canvas.maxCx()) >> 1;
        }

        public int centreZ() {
            return grant != null ? grant.centreZ() : (canvas.minCz() + canvas.maxCz()) >> 1;
        }

        /** "the select grant", "the canvas" or both, for refusals. */
        public String what() {
            return grant != null && canvas != null ? "the select grant and the canvas" : grant != null ? "the select grant" : "the canvas";
        }
    }

    /** The request state the read area carries (the search, resumable with {@code continue}, and the fill {@code expand} grows). */
    public static final class Held {
        private volatile @Nullable SearchWalk search;
        private volatile WorldFill.@Nullable State fill;

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

    private static volatile @Nullable Grant grant;
    private static volatile @Nullable Canvas canvas;
    private static volatile Held held = new Held();

    /** The search and fill state, or null while neither a grant nor a canvas is set. */
    public static @Nullable Held current() {
        return grant == null && canvas == null ? null : held;
    }

    /** The select grant in force, or null. */
    public static @Nullable Grant grant() {
        return grant;
    }

    /** The canvas the read area holds, or null. */
    public static @Nullable Canvas canvas() {
        return canvas;
    }

    /** The read area in {@code dimension} (a wire id), or null when neither the grant nor the canvas is there. */
    public static @Nullable ReadArea area(String dimension) {
        Grant g = grant;
        Canvas c = canvas;
        Grant gi = g != null && g.in(dimension) ? g : null;
        Canvas ci = c != null && c.dimension().location().toString().equals(dimension) ? c : null;
        if (gi == null && ci == null) return null;
        return new ReadArea(gi != null ? gi.dimension() : ci.dimension(), gi, ci);
    }

    /** {@code no_grant} when neither is set, {@code wrong_dimension} when neither is in {@code dimension}; else the read area. */
    public static ReadArea require(long id, String dimension) throws ProtocolException {
        Grant g = grant;
        Canvas c = canvas;
        if (g == null && c == null)
            throw ProtocolException.refuse(ErrorCodes.NO_GRANT, id, "no select request is open and no canvas is set: the player sends /autosketch select or sets a canvas first");
        ReadArea a = area(dimension);
        if (a == null) {
            String where = g != null ? "the select request is in " + g.dimension().location() : "the canvas is in " + c.dimension().location();
            throw ProtocolException.refuse(ErrorCodes.WRONG_DIMENSION, id, where + ", not " + dimension);
        }
        return a;
    }

    /** Grants reads within {@code radius} chunks of {@code position}'s chunk, replacing any grant (and the search and fill). */
    public static Grant set(ResourceKey<Level> dimension, BlockPos position, int radius) {
        Grant g = new Grant(dimension, position.getX() >> 4, position.getZ() >> 4, radius);
        grant = g;
        held = new Held();
        return g;
    }

    /** The grant a {@code select} prompt at {@code position} gives: {@code selectChunks} from the config. */
    public static Grant forPrompt(ResourceKey<Level> dimension, BlockPos position) {
        return set(dimension, position, AutosketchConfig.get().select.selectChunks);
    }

    /** Drops the select grant (and the search and fill); the canvas stays. */
    public static void clear() {
        grant = null;
        held = new Held();
    }

    /** The canvas changed (19): {@code box} in {@code dimension}, or none. A change drops the search and fill. */
    public static void canvas(@Nullable ResourceKey<Level> dimension, @Nullable Box box) {
        Canvas next = dimension == null || box == null ? null : Canvas.of(dimension, box);
        if (java.util.Objects.equals(next, canvas)) return;
        canvas = next;
        held = new Held();
    }
}
