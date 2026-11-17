package dev.autosketch.mod.link;

import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import org.jetbrains.annotations.Nullable;

/**
 * The link state every part of the mod reads (16, *Mod side*): {@link #OFFLINE} with no MCP
 * connected (the whole mod is locked), {@link #TOO_OLD} with an MCP whose hello lacks the {@code ui}
 * feature (today's features work, {@code 16}'s in-game UI is locked), {@link #CONNECTED} otherwise.
 * {@link #wire()} is the name sent to the client half. Plain Java, so both halves load it.
 */
public enum LinkStatus {
    OFFLINE("offline"),
    TOO_OLD("too_old"),
    CONNECTED("connected");

    /** The MCP feature {@code 16}'s in-game UI needs (13, *Versions and features*). */
    public static final String FEATURE_UI = "ui";

    private final String wire;

    LinkStatus(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    /** The status with this wire name; {@link #OFFLINE} for an unknown one (a newer server's name). */
    public static LinkStatus fromWire(@Nullable String wire) {
        for (LinkStatus s : values()) if (s.wire.equals(wire)) return s;
        return OFFLINE;
    }

    /** The status of a bridge now. */
    public static LinkStatus of(Bridge bridge) {
        BridgeSession s = bridge.connected() ? bridge.session() : null;
        if (s == null) return OFFLINE;
        return s.features().contains(FEATURE_UI) ? CONNECTED : TOO_OLD;
    }
}
