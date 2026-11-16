package dev.autosketch.mod.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.jetbrains.annotations.Nullable;

/**
 * An inclusive area of block columns in world coordinates (13, *Message schemas*, {@code snapshot}
 * kind {@code surface} and the scan grant; protocol 2), {@code min ≤ max} on both axes. JSON form
 * {@code {"min":[x,z],"max":[x,z]}}. Columns are indexed {@code dx + sizeX · dz}, x fastest.
 */
public record Area(int minX, int minZ, int maxX, int maxZ) {
    public Area {
        if (minX > maxX || minZ > maxZ) throw new IllegalArgumentException("unnormalised area " + minX + "," + minZ + ".." + maxX + "," + maxZ);
    }

    public int sizeX() {
        return maxX - minX + 1;
    }

    public int sizeZ() {
        return maxZ - minZ + 1;
    }

    public long columns() {
        return (long) sizeX() * sizeZ();
    }

    public boolean contains(Area a) {
        return a.minX >= minX && a.maxX <= maxX && a.minZ >= minZ && a.maxZ <= maxZ;
    }

    public JsonObject toJson() {
        JsonObject o = new JsonObject();
        JsonArray min = new JsonArray(2), max = new JsonArray(2);
        min.add(minX);
        min.add(minZ);
        max.add(maxX);
        max.add(maxZ);
        o.add("min", min);
        o.add("max", max);
        return o;
    }

    /** Parses a JSON area; a malformed or unnormalised area is {@code bad_request} for {@code id}. */
    public static Area fromJson(JsonElement e, String what, @Nullable Long id) throws ProtocolException {
        if (!e.isJsonObject()) throw ProtocolException.badRequest(id, what + ": an area must be an object");
        JsonObject o = e.getAsJsonObject();
        int[] min = pair(Json.req(o, "min", id), what, id), max = pair(Json.req(o, "max", id), what, id);
        if (min[0] > max[0] || min[1] > max[1]) throw ProtocolException.badRequest(id, what + ": unnormalised area");
        return new Area(min[0], min[1], max[0], max[1]);
    }

    /** An {@code [a,b]} integer pair. */
    static int[] pair(JsonElement e, String what, @Nullable Long id) throws ProtocolException {
        if (!e.isJsonArray() || e.getAsJsonArray().size() != 2) throw ProtocolException.badRequest(id, what + " must be [x,z]");
        JsonArray a = e.getAsJsonArray();
        return new int[] {Json.asInt(a.get(0), what, id), Json.asInt(a.get(1), what, id)};
    }

    @Override
    public String toString() {
        return minX + "," + minZ + ".." + maxX + "," + maxZ;
    }
}
