package dev.autosketch.mod.protocol;

import org.jetbrains.annotations.Nullable;

/**
 * A protocol violation or a refused request, carrying the {@code error} message's code
 * (13, *Wire format*, *Message schemas*, {@code error}). {@code id} is the request it answers, or
 * null for a malformed frame; {@link #closes()} says whether the connection must be closed.
 */
public final class ProtocolException extends Exception {
    private final String code;
    private final @Nullable Long id;
    private final boolean closes;

    public ProtocolException(String code, @Nullable Long id, String message, boolean closes) {
        super(message);
        this.code = code;
        this.id = id;
        this.closes = closes;
    }

    /** A malformed frame: {@code bad_request}, id null, and the connection closes. */
    public static ProtocolException malformed(String message) {
        return new ProtocolException(ErrorCodes.BAD_REQUEST, null, message, true);
    }

    /** A well-formed request with invalid fields: {@code bad_request} by id; the connection stays open. */
    public static ProtocolException badRequest(@Nullable Long id, String message) {
        return new ProtocolException(ErrorCodes.BAD_REQUEST, id, message, id == null);
    }

    /** A refusal by id that leaves the connection open ({@code no_volumes}, {@code outside_volumes}, ...). */
    public static ProtocolException refuse(String code, @Nullable Long id, String message) {
        return new ProtocolException(code, id, message, false);
    }

    /** The same failure, answering request {@code id} (used when a body fails to decode). */
    public ProtocolException withId(@Nullable Long requestId) {
        if (requestId == null || id != null) return this;
        return new ProtocolException(code, requestId, getMessage(), false);
    }

    public String code() {
        return code;
    }

    public @Nullable Long id() {
        return id;
    }

    public boolean closes() {
        return closes;
    }

    /** The {@code error} frame that reports this failure. */
    public Frame toFrame() {
        return new ErrorMessage(id, code, getMessage(), null).encode();
    }
}
