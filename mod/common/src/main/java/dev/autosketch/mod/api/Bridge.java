package dev.autosketch.mod.api;

import dev.autosketch.mod.protocol.Frame;
import org.jetbrains.annotations.Nullable;

/**
 * The mod's side of the MCP connection, for sending unsolicited messages ({@code dirty},
 * {@code prompt}, {@code volumes}) and watching the connection. Responses to requests go through
 * the request's {@link Exchange} instead, so they reach the connection the request came on.
 */
public interface Bridge {
    /** Whether a paired MCP is connected now. */
    boolean connected();

    /** The current session, or null when no MCP is paired. */
    @Nullable BridgeSession session();

    /**
     * Queues a frame to the current MCP. Thread-safe and non-blocking; frames from one thread go
     * out in call order. Returns false (and drops the frame) when no MCP is paired.
     */
    boolean send(Frame frame);

    /** Adds a listener; its methods run on the server thread. */
    void addListener(Listener listener);

    interface Listener {
        /** After the handshake completed (the mod's {@code hello} and {@code volumes} are already sent). */
        default void connected(BridgeSession session) {}

        /** After the session's connection closed, for whatever reason. */
        default void disconnected(BridgeSession session) {}
    }
}
