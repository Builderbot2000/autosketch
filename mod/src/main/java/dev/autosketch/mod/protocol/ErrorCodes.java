package dev.autosketch.mod.protocol;

/** The {@code error} codes and patch reject reasons (13, *Wire format*, *Message schemas*). */
public final class ErrorCodes {
    private ErrorCodes() {}

    public static final String PROTOCOL_MISMATCH = "protocol_mismatch";
    public static final String BAD_TOKEN = "bad_token";
    public static final String NOT_READY = "not_ready";
    public static final String BAD_REQUEST = "bad_request";
    public static final String UNKNOWN_TYPE = "unknown_type";
    public static final String NO_VOLUMES = "no_volumes";
    public static final String WRONG_DIMENSION = "wrong_dimension";
    public static final String OUTSIDE_VOLUMES = "outside_volumes";
    public static final String TOO_LARGE = "too_large";
    public static final String REPLACED = "replaced";
    public static final String STALE_LINK = "stale_link";
    public static final String BAD_EXTENSION = "bad_extension";

    /** Patch reject reasons ({@code patch.ack}). {@code stale_link} and {@code outside_volumes} double as reasons. */
    public static final String UNKNOWN_STATE = "unknown_state";
    public static final String BAD_NBT = "bad_nbt";

    public static boolean isRejectReason(String s) {
        return s.equals(STALE_LINK) || s.equals(OUTSIDE_VOLUMES) || s.equals(UNKNOWN_STATE) || s.equals(BAD_NBT);
    }
}
