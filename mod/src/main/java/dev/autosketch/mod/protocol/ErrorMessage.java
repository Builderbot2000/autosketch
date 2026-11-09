package dev.autosketch.mod.protocol;

import com.google.gson.JsonObject;
import org.jetbrains.annotations.Nullable;

/** {@code error}, either direction (13, *Wire format*, *Message schemas*). {@code protocol} only with {@code protocol_mismatch}. */
public record ErrorMessage(@Nullable Long id, String code, String message, @Nullable Integer protocol) {
    public Frame encode() {
        JsonObject h = Json.header("error");
        h.add("id", Json.nullable(id));
        h.addProperty("code", code);
        h.addProperty("message", message);
        if (protocol != null) h.addProperty("protocol", protocol);
        return new Frame(h);
    }

    public static ErrorMessage decode(Frame f) throws ProtocolException {
        JsonObject h = f.header();
        Long id = Json.reqNullableLong(h, "id", null);
        Integer protocol = h.has("protocol") ? Json.reqInt(h, "protocol", null) : null;
        return new ErrorMessage(id, Json.reqString(h, "code", null), Json.reqString(h, "message", null), protocol);
    }
}
