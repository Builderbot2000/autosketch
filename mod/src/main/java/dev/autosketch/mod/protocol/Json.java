package dev.autosketch.mod.protocol;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.google.gson.TypeAdapter;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import org.jetbrains.annotations.Nullable;

/**
 * JSON header helpers (13, *Wire format*, *Framing*): compact output with nulls kept and no HTML
 * escaping, and typed field accessors that turn a missing or ill-typed field into
 * {@code bad_request} for the request's id.
 */
public final class Json {
    private Json() {}

    static final Gson GSON = new GsonBuilder().disableHtmlEscaping().serializeNulls().create();
    static final TypeAdapter<JsonElement> ELEMENT_ADAPTER = GSON.getAdapter(JsonElement.class);

    public static String write(JsonElement e) {
        return GSON.toJson(e);
    }

    /** Parses JSON text (tests, sidecars); headers on the wire go through {@link FrameCodec}. */
    public static JsonElement parse(String text) {
        return com.google.gson.JsonParser.parseString(text);
    }

    // ── building ──────────────────────────────────────────────────────────────────────────────

    public static JsonObject header(String type) {
        JsonObject o = new JsonObject();
        o.addProperty("type", type);
        return o;
    }

    public static JsonArray vec(int x, int y, int z) {
        JsonArray a = new JsonArray(3);
        a.add(x);
        a.add(y);
        a.add(z);
        return a;
    }

    public static JsonElement nullable(@Nullable Long v) {
        return v == null ? JsonNull.INSTANCE : new JsonPrimitive(v);
    }

    public static JsonElement nullable(@Nullable String v) {
        return v == null ? JsonNull.INSTANCE : new JsonPrimitive(v);
    }

    public static JsonArray strings(List<String> list) {
        JsonArray a = new JsonArray(list.size());
        for (String s : list) a.add(s);
        return a;
    }

    // ── reading ───────────────────────────────────────────────────────────────────────────────

    private static ProtocolException bad(@Nullable Long id, String msg) {
        return ProtocolException.badRequest(id, msg);
    }

    public static JsonElement req(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        JsonElement e = o.get(key);
        if (e == null) throw bad(id, "missing field \"" + key + "\"");
        return e;
    }

    public static String reqString(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        JsonElement e = req(o, key, id);
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) throw bad(id, "\"" + key + "\" must be a string");
        return e.getAsString();
    }

    public static @Nullable String optString(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        JsonElement e = o.get(key);
        if (e == null || e.isJsonNull()) return null;
        return reqString(o, key, id);
    }

    public static boolean reqBool(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        JsonElement e = req(o, key, id);
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isBoolean()) throw bad(id, "\"" + key + "\" must be a boolean");
        return e.getAsBoolean();
    }

    public static boolean optBool(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        return o.has(key) && reqBool(o, key, id);
    }

    public static long asLong(JsonElement e, String what, @Nullable Long id) throws ProtocolException {
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) throw bad(id, what + " must be an integer");
        try {
            BigDecimal d = e.getAsBigDecimal();
            long v = d.longValueExact();
            if (Math.abs(v) > ByteWriter.MAX_VARINT) throw bad(id, what + " is beyond 2^53");
            return v;
        } catch (ArithmeticException | NumberFormatException ex) {
            throw bad(id, what + " must be an integer");
        }
    }

    public static long reqLong(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        return asLong(req(o, key, id), "\"" + key + "\"", id);
    }

    public static int asInt(JsonElement e, String what, @Nullable Long id) throws ProtocolException {
        long v = asLong(e, what, id);
        if (v < Integer.MIN_VALUE || v > Integer.MAX_VALUE) throw bad(id, what + " is out of range");
        return (int) v;
    }

    public static int reqInt(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        return asInt(req(o, key, id), "\"" + key + "\"", id);
    }

    /** A non-negative count that fits an int. */
    public static int reqCount(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        int v = reqInt(o, key, id);
        if (v < 0) throw bad(id, "\"" + key + "\" must not be negative");
        return v;
    }

    public static @Nullable Long reqNullableLong(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        JsonElement e = req(o, key, id);
        return e.isJsonNull() ? null : asLong(e, "\"" + key + "\"", id);
    }

    public static JsonObject reqObject(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        JsonElement e = req(o, key, id);
        if (!e.isJsonObject()) throw bad(id, "\"" + key + "\" must be an object");
        return e.getAsJsonObject();
    }

    public static JsonArray reqArray(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        JsonElement e = req(o, key, id);
        if (!e.isJsonArray()) throw bad(id, "\"" + key + "\" must be an array");
        return e.getAsJsonArray();
    }

    /** An {@code [x,y,z]} integer triple. */
    public static int[] asVec(JsonElement e, String what, @Nullable Long id) throws ProtocolException {
        if (!e.isJsonArray() || e.getAsJsonArray().size() != 3) throw bad(id, what + " must be [x,y,z]");
        JsonArray a = e.getAsJsonArray();
        return new int[] {asInt(a.get(0), what, id), asInt(a.get(1), what, id), asInt(a.get(2), what, id)};
    }

    public static int[] reqVec(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        return asVec(req(o, key, id), "\"" + key + "\"", id);
    }

    public static List<Box> reqBoxes(JsonObject o, String key, @Nullable Long id) throws ProtocolException {
        JsonArray a = reqArray(o, key, id);
        List<Box> out = new ArrayList<>(a.size());
        for (JsonElement e : a) out.add(Box.fromJson(e, key, id));
        return out;
    }

    public static JsonArray boxes(List<Box> boxes) {
        JsonArray a = new JsonArray(boxes.size());
        for (Box b : boxes) a.add(b.toJson());
        return a;
    }
}
