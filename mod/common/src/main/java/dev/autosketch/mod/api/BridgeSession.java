package dev.autosketch.mod.api;

import com.google.gson.JsonObject;
import java.util.List;

/**
 * One paired MCP connection, from its accepted {@code hello} until it closes. {@code serial}
 * increases with every connection since the server started. {@code volatileKeys} is the hello's
 * volatile-key list (13, *Hashing*), which the mod hashes with; the mod keeps no list of its own.
 * {@code modes} are the request modes the MCP's hello lists (protocol 2; {@code ["build"]} when it
 * lists none): the mod sends no other mode (13, B6). {@code features} are the optional capabilities
 * the MCP's hello lists (empty when it lists none): the mod uses an addition only when the MCP lists
 * it, such as {@code prompt.close} for {@code /autosketch done} (13, *Versions and features*).
 */
public record BridgeSession(long serial, String clientName, String clientVersion, JsonObject volatileKeys, List<String> modes, List<String> features) {
    /** A session whose MCP listed no modes ({@code build} only) and no features. */
    public BridgeSession(long serial, String clientName, String clientVersion, JsonObject volatileKeys) {
        this(serial, clientName, clientVersion, volatileKeys, List.of("build"));
    }

    /** A session whose MCP listed these modes and no features. */
    public BridgeSession(long serial, String clientName, String clientVersion, JsonObject volatileKeys, List<String> modes) {
        this(serial, clientName, clientVersion, volatileKeys, modes, List.of());
    }
}
