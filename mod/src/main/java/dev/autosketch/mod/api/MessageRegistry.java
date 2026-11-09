package dev.autosketch.mod.api;

/**
 * Where silos register the MCP → mod messages they handle, during {@link AutosketchSetupEvent}.
 * Silo O registers {@code hashes}, {@code snapshot} and {@code patch}; silo S {@code prompt.result}
 * and {@code chat}; silo N {@code volumes.extend} and {@code notice}. {@code hello} is the bridge's
 * own. A message type nobody registered is answered with {@code unknown_type} when it has an id.
 */
public interface MessageRegistry {
    /** Registers the handler for one message type. Throws if the type already has one, or after setup. */
    void register(String type, MessageHandler handler);
}
