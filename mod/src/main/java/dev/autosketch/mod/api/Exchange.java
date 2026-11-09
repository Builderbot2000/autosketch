package dev.autosketch.mod.api;

import dev.autosketch.mod.protocol.Frame;
import org.jetbrains.annotations.Nullable;

/**
 * The open handling of one inbound message (see {@link MessageHandler}). Methods may be called from
 * any thread. Exactly one completion counts; later calls are ignored. If the connection the message
 * came on has closed (the MCP disconnected or was replaced), replies are dropped silently, but the
 * exchange must still complete so the next message runs: the mod finishes a patch in progress and
 * its ack is lost (13, *Connection and handshake*, step 7).
 */
public interface Exchange {
    /** The request's id, or null for messages without one ({@code notice}, {@code chat}, {@code prompt.result}). */
    @Nullable Long id();

    /** Sends the response ({@code patch.ack}, {@code snapshot.result}, ...) and completes. */
    void reply(Frame response);

    /** Sends {@code error} with this request's id and the given code, and completes. The connection stays open. */
    void error(String code, String message);

    /** Completes without a reply (one-way messages, or a deferred exchange whose response was sent elsewhere). */
    void complete();

    /**
     * Keeps the exchange open after {@link MessageHandler#handle} returns; the handler must later
     * reply, error or complete. Holds back every later message until then.
     */
    void defer();

    /** Whether the connection this message came on is still the live one; false means replies are dropped. */
    boolean live();
}
