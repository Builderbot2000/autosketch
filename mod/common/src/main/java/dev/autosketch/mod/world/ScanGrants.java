package dev.autosketch.mod.world;

import dev.autosketch.mod.protocol.Area;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Messages;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.Level;
import org.jetbrains.annotations.Nullable;

/**
 * The scan grant (13, *Message schemas*, {@code prompt} {@code scan} and "Where the mod serves
 * reads"; B4): what the latest {@code scan} request lets the MCP read, sized here from the config, and
 * held until the next scan request replaces it, the connection closes or the server stops. While it
 * lasts, surface snapshots inside its columns and blocks snapshots inside its box are served in its
 * dimension even with no work volume set.
 */
public final class ScanGrants {
    private ScanGrants() {}

    /** A grant in force: its dimension and the wire grant. */
    public record Held(ResourceKey<Level> dimension, Messages.ScanGrant grant) {}

    private static volatile @Nullable Held current;

    public static @Nullable Held current() {
        return current;
    }

    /** Sets the grant; a scan grant ends a select grant (one grant at a time, 13). */
    public static void set(ResourceKey<Level> dimension, Messages.ScanGrant grant) {
        SelectGrants.clear();
        current = new Held(dimension, grant);
    }

    public static void clear() {
        current = null;
    }

    /**
     * Sizes a grant for a player whose feet are in block {@code (x, y, z)}: the radius (requested, or
     * {@code defaultChunks} when {@code requested} is negative) clipped to {@code maxChunks}; the columns
     * of the chunks within it; and the full-block box from {@code below} under the feet to {@code above}
     * over them, clipped to the build height {@code minY..maxY}, centred on the player and as wide as
     * {@code cap} blocks allow, inside the columns.
     */
    public static Messages.ScanGrant size(int requested, int defaultChunks, int maxChunks, int x, int y, int z,
            int minY, int maxY, int below, int above, long cap) {
        int want = requested < 0 ? defaultChunks : requested;
        int r = Math.min(want, maxChunks);
        boolean clipped = want > maxChunks;
        int cx = x >> 4, cz = z >> 4;
        Area columns = new Area(16 * (cx - r), 16 * (cz - r), 16 * (cx + r) + 15, 16 * (cz + r) + 15);
        int lo = Math.max(minY, Math.min(maxY, y - below)), hi = Math.max(lo, Math.min(maxY, y + above));
        long height = hi - lo + 1;
        long side = (long) Math.floor(Math.sqrt((double) cap / height));
        side = Math.max(1, Math.min(side, columns.sizeX()));
        int half = (int) (side / 2);
        int minX = x - half, minZ = z - half;
        int maxX = (int) (minX + side - 1), maxZ = (int) (minZ + side - 1);
        // Keep the box inside the columns (the player's chunk is in the middle, so a shift never empties it).
        if (minX < columns.minX()) { maxX += columns.minX() - minX; minX = columns.minX(); }
        if (maxX > columns.maxX()) { minX -= maxX - columns.maxX(); maxX = columns.maxX(); }
        if (minZ < columns.minZ()) { maxZ += columns.minZ() - minZ; minZ = columns.minZ(); }
        if (maxZ > columns.maxZ()) { minZ -= maxZ - columns.maxZ(); maxZ = columns.maxZ(); }
        return new Messages.ScanGrant(r, clipped, columns, new Box(minX, lo, minZ, maxX, hi, maxZ));
    }
}
