package dev.autosketch.mod.protocol;

import com.google.gson.JsonObject;
import java.util.Collection;
import net.minecraft.core.BlockPos;
import org.jetbrains.annotations.Nullable;

/**
 * A body's position grid (13, *Wire format*, *Binary bodies*): an origin and a size, and the linear
 * index {@code dx + sx·(dz + sz·dy)} (x fastest, then z, then y). All zero when a message lists no
 * positions.
 */
public record Grid(int ox, int oy, int oz, int sx, int sy, int sz) {
    public static final Grid EMPTY = new Grid(0, 0, 0, 0, 0, 0);

    /** The tight bounding grid of every position in {@code lists} (EMPTY when there are none). */
    @SafeVarargs
    public static Grid around(Collection<? extends BlockPos>... lists) {
        int minX = Integer.MAX_VALUE, minY = Integer.MAX_VALUE, minZ = Integer.MAX_VALUE;
        int maxX = Integer.MIN_VALUE, maxY = Integer.MIN_VALUE, maxZ = Integer.MIN_VALUE;
        boolean any = false;
        for (Collection<? extends BlockPos> list : lists)
            for (BlockPos p : list) {
                any = true;
                minX = Math.min(minX, p.getX());
                minY = Math.min(minY, p.getY());
                minZ = Math.min(minZ, p.getZ());
                maxX = Math.max(maxX, p.getX());
                maxY = Math.max(maxY, p.getY());
                maxZ = Math.max(maxZ, p.getZ());
            }
        if (!any) return EMPTY;
        return new Grid(minX, minY, minZ, maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1);
    }

    public long volume() {
        return (long) sx * sy * sz;
    }

    public long indexOf(int x, int y, int z) {
        int dx = x - ox, dy = y - oy, dz = z - oz;
        if (dx < 0 || dy < 0 || dz < 0 || dx >= sx || dy >= sy || dz >= sz) throw new IllegalArgumentException("position " + x + "," + y + "," + z + " outside the message grid");
        return dx + (long) sx * (dz + (long) sz * dy);
    }

    public long indexOf(BlockPos p) {
        return indexOf(p.getX(), p.getY(), p.getZ());
    }

    public BlockPos posAt(long index) {
        int dx = (int) (index % sx);
        long t = index / sx;
        int dz = (int) (t % sz);
        int dy = (int) (t / sz);
        return new BlockPos(ox + dx, oy + dy, oz + dz);
    }

    /** Writes {@code origin} and {@code size} into a header. */
    public void writeTo(JsonObject header) {
        header.add("origin", Json.vec(ox, oy, oz));
        header.add("size", Json.vec(sx, sy, sz));
    }

    /** Reads {@code origin} and {@code size} from a header. A size of zero on any axis must be all zero. */
    public static Grid readFrom(JsonObject header, @Nullable Long id) throws ProtocolException {
        int[] o = Json.reqVec(header, "origin", id);
        int[] s = Json.reqVec(header, "size", id);
        if (s[0] < 0 || s[1] < 0 || s[2] < 0) throw ProtocolException.badRequest(id, "negative grid size");
        if ((long) s[0] * s[1] * s[2] > ByteWriter.MAX_VARINT) throw ProtocolException.badRequest(id, "grid too large");
        return new Grid(o[0], o[1], o[2], s[0], s[1], s[2]);
    }
}
