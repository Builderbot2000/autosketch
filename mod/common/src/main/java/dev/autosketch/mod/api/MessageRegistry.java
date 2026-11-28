package dev.autosketch.mod.api;

/**
 * Where silos register the MCP → mod messages they handle, during {@link AutosketchSetup}.
 * Silo O registers {@code hashes}, {@code snapshot} and {@code patch}; silo S {@code prompt.result}
 * and {@code chat}; silo N {@code volumes.extend} and {@code notice}. {@code hello} is the bridge's
 * own. A message type nobody registered is answered with {@code unknown_type} when it has an id.
 */
public interface MessageRegistry {
    /** Registers the handler for one message type. Throws if the type already has one, or after setup. */
    void register(String type, MessageHandler handler);

    /**
     * Drops the queued requests of one type not yet handed to their handler, answering each with
     * {@code error} {@code code}, and returns how many. Requests run one at a time, so while one
     * defers (a patch applying over many ticks) the ones behind it wait here, not in the handler
     * (19, *Stop*, step 2: {@code patch.drop}). Server thread.
     */
    default int dropQueued(String type, String code, String message) {
        return 0;
    }
}
