package dev.autosketch.mod.api;

import java.util.List;
import java.util.Objects;

/**
 * Runtime services the mod's packages share. Installed by the mod entry point before
 * {@link AutosketchSetupEvent} is posted; read from then on.
 */
public final class Autosketch {
    private Autosketch() {}

    public static final String MOD_ID = "autosketch";

    private static volatile Services services;

    /** The MCP connection. */
    public static Bridge bridge() {
        return get().bridge;
    }

    /** The link's volumes. */
    public static LinkState link() {
        return get().link;
    }

    /** Patch progress (silo O's, or {@link PatchStatus#NONE}). */
    public static PatchStatus patchStatus() {
        return get().patchStatus;
    }

    /** The wand modes in cycle order. */
    public static List<WandMode> wandModes() {
        return get().wandModes;
    }

    private static Services get() {
        Services s = services;
        if (s == null) throw new IllegalStateException("Autosketch services are not installed yet");
        return s;
    }

    /** Mod-internal: installs the services. Called by the entry point, then again after setup with the registered pieces. */
    public static void install(Bridge bridge, LinkState link, PatchStatus patchStatus, List<WandMode> wandModes) {
        services = new Services(Objects.requireNonNull(bridge), Objects.requireNonNull(link), Objects.requireNonNull(patchStatus), List.copyOf(wandModes));
    }

    private record Services(Bridge bridge, LinkState link, PatchStatus patchStatus, List<WandMode> wandModes) {}
}
