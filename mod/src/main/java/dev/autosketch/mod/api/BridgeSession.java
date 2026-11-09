package dev.autosketch.mod.api;

import com.google.gson.JsonObject;

/**
 * One paired MCP connection, from its accepted {@code hello} until it closes. {@code serial}
 * increases with every connection since the server started. {@code volatileKeys} is the hello's
 * volatile-key list (13, *Hashing*), which the mod hashes with; the mod keeps no list of its own.
 */
public record BridgeSession(long serial, String clientName, String clientVersion, JsonObject volatileKeys) {}
