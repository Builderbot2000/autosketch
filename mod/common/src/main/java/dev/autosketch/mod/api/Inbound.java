package dev.autosketch.mod.api;

import com.google.gson.JsonObject;
import dev.autosketch.mod.protocol.Frame;
import org.jetbrains.annotations.Nullable;

/**
 * An inbound message as a handler receives it: the decoded frame and the session it arrived on
 * (which carries the hello's volatile-key list for hashing). Decode the typed message with the
 * matching {@code Messages.*.decode(frame)}; a decoding failure is a {@code ProtocolException} the
 * handler may simply let propagate.
 */
public record Inbound(Frame frame, BridgeSession session) {
    public String type() {
        return frame.type();
    }

    public JsonObject header() {
        return frame.header();
    }

    public @Nullable Long id() {
        return frame.id();
    }
}
