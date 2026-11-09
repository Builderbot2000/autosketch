package dev.autosketch.mod.protocol;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import org.jetbrains.annotations.Nullable;

/**
 * One message on the wire: a JSON header with a {@code type} field and a binary body, empty unless
 * the message kind has one (13, *Wire format*, *Framing*). Typed message classes encode to and
 * decode from frames; {@link FrameCodec} turns frames into bytes.
 */
public record Frame(JsonObject header, byte[] body) {
    private static final byte[] EMPTY = new byte[0];

    public Frame(JsonObject header) {
        this(header, EMPTY);
    }

    /** The header's {@code type}, or the empty string when missing or not a string. */
    public String type() {
        JsonElement t = header.get("type");
        return t != null && t.isJsonPrimitive() && t.getAsJsonPrimitive().isString() ? t.getAsString() : "";
    }

    /** The header's {@code id} when it is an integer, else null (absent, {@code null}, or malformed). */
    public @Nullable Long id() {
        JsonElement e = header.get("id");
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) return null;
        try {
            return e.getAsBigDecimal().longValueExact();
        } catch (ArithmeticException ex) {
            return null;
        }
    }

    public boolean hasBody() {
        return body.length > 0;
    }
}
