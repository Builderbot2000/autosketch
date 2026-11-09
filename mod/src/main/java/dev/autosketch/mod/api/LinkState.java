package dev.autosketch.mod.api;

import org.jetbrains.annotations.Nullable;

/**
 * The link's volumes as the mod holds them (13, *Work and context volumes in-game*). Read on the
 * server thread. A new {@link LinkVolumes#link()} means the work volume or dimension changed
 * (a relink): patches built for the old link are rejected {@code stale_link}.
 */
public interface LinkState {
    /** The current volumes, or null when no work volume is set (unlinked). */
    @Nullable LinkVolumes current();

    /** Adds a listener, called on the server thread after every change (including to null), before {@code volumes} is sent. */
    void addListener(Listener listener);

    @FunctionalInterface
    interface Listener {
        void changed(@Nullable LinkVolumes previous, @Nullable LinkVolumes current);
    }
}
