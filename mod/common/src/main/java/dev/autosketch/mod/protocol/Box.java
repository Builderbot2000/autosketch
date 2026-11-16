package dev.autosketch.mod.protocol;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import net.minecraft.core.BlockPos;
import org.jetbrains.annotations.Nullable;

/**
 * An inclusive box in world coordinates (01; 13, *Wire format*, *Primitives*), {@code min ≤ max}
 * on every axis. JSON form {@code {"min":[x,y,z],"max":[x,y,z]}}.
 */
public record Box(int minX, int minY, int minZ, int maxX, int maxY, int maxZ) {
    public Box {
        if (minX > maxX || minY > maxY || minZ > maxZ) throw new IllegalArgumentException("unnormalised box " + minX + "," + minY + "," + minZ + ".." + maxX + "," + maxY + "," + maxZ);
    }

    /** The box spanning two corners in any order. */
    public static Box of(BlockPos a, BlockPos b) {
        return new Box(Math.min(a.getX(), b.getX()), Math.min(a.getY(), b.getY()), Math.min(a.getZ(), b.getZ()),
                Math.max(a.getX(), b.getX()), Math.max(a.getY(), b.getY()), Math.max(a.getZ(), b.getZ()));
    }

    /** A chunk section's 16³ box. */
    public static Box section(int sx, int sy, int sz) {
        return new Box(sx << 4, sy << 4, sz << 4, (sx << 4) + 15, (sy << 4) + 15, (sz << 4) + 15);
    }

    public int sizeX() {
        return maxX - minX + 1;
    }

    public int sizeY() {
        return maxY - minY + 1;
    }

    public int sizeZ() {
        return maxZ - minZ + 1;
    }

    public long volume() {
        return (long) sizeX() * sizeY() * sizeZ();
    }

    public boolean contains(int x, int y, int z) {
        return x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ;
    }

    public boolean contains(BlockPos p) {
        return contains(p.getX(), p.getY(), p.getZ());
    }

    public boolean contains(Box b) {
        return b.minX >= minX && b.maxX <= maxX && b.minY >= minY && b.maxY <= maxY && b.minZ >= minZ && b.maxZ <= maxZ;
    }

    public boolean intersects(Box b) {
        return b.minX <= maxX && b.maxX >= minX && b.minY <= maxY && b.maxY >= minY && b.minZ <= maxZ && b.maxZ >= minZ;
    }

    /** Grown by {@code n} on every side (n may be negative only while the box stays normalised). */
    public Box grow(int n) {
        return new Box(minX - n, minY - n, minZ - n, maxX + n, maxY + n, maxZ + n);
    }

    public BlockPos min() {
        return new BlockPos(minX, minY, minZ);
    }

    public BlockPos max() {
        return new BlockPos(maxX, maxY, maxZ);
    }

    /** This box as a body grid (origin = min). */
    public Grid grid() {
        return new Grid(minX, minY, minZ, sizeX(), sizeY(), sizeZ());
    }

    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        o.add("min", Json.vec(minX, minY, minZ));
        o.add("max", Json.vec(maxX, maxY, maxZ));
        return o;
    }

    /** Parses a JSON box; a malformed or unnormalised box is {@code bad_request} for {@code id}. */
    public static Box fromJson(JsonElement e, String what, @Nullable Long id) throws ProtocolException {
        if (!e.isJsonObject()) throw ProtocolException.badRequest(id, what + ": a box must be an object");
        JsonObject o = e.getAsJsonObject();
        int[] min = Json.reqVec(o, "min", id);
        int[] max = Json.reqVec(o, "max", id);
        if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) throw ProtocolException.badRequest(id, what + ": unnormalised box");
        return new Box(min[0], min[1], min[2], max[0], max[1], max[2]);
    }

    @Override
    public String toString() {
        return minX + "," + minY + "," + minZ + ".." + maxX + "," + maxY + "," + maxZ;
    }
}
