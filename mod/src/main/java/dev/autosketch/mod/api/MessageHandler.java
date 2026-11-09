package dev.autosketch.mod.api;

import dev.autosketch.mod.protocol.ProtocolException;

/**
 * Handles one kind of MCP → mod message ({@code patch}, {@code snapshot}, {@code chat}, ...),
 * registered with {@link MessageRegistry#register}.
 *
 * <p><b>Threading and order</b> (13, *Wire format*, *Framing*, "Ordering"): handlers run on the
 * server thread, one message at a time, in arrival order. The next message isn't handed to any
 * handler until this one's {@link Exchange} completes. An exchange completes when the handler
 * replies ({@link Exchange#reply}, {@link Exchange#error}), calls {@link Exchange#complete}, or
 * returns without calling {@link Exchange#defer}. A patch applied across ticks defers, and replies
 * with its ack when done, so a {@code snapshot} that arrived meanwhile sees the patch.
 *
 * <p><b>Failures:</b> throwing {@link ProtocolException} sends its {@code error} (by the request's
 * id) and completes the exchange; if {@link ProtocolException#closes()} the connection closes too.
 * Any other exception is logged and answered with {@code bad_request}.
 */
@FunctionalInterface
public interface MessageHandler {
    void handle(Inbound message, Exchange exchange) throws ProtocolException;
}
