package dev.autosketch.mod.world;

import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetup;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.api.Exchange;
import dev.autosketch.mod.api.Inbound;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import java.util.Locale;
import java.util.function.Function;
import net.minecraft.Util;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import org.jetbrains.annotations.Nullable;

/**
 * Silo O's registration (13, M5–M9): the {@code patch}, {@code hashes} and {@code snapshot}
 * handlers, the patch status for {@code /autosketch status}, and the server-tick hooks that drive the
 * patch budget, the sliced reads and the change tracker. Registers through {@link AutosketchSetup},
 * so no other package's files change; each loader's events call {@link #setup} and the tick hooks
 * (on NeoForge, {@code WorldEvents}).
 */
public final class WorldModule {
    private WorldModule() {}

    /** The world services, shared by the handlers, the tick hooks and GameTests. */
    public record Services(PatchApplier patches, WorldReads reads, ChangeTracker tracker) {}

    private static volatile @Nullable Services services;
    private static volatile @Nullable SurfaceReads surface;

    /** Surface snapshots (B4), for GameTests. */
    public static SurfaceReads surface() {
        SurfaceReads s = surface;
        if (s == null) throw new IllegalStateException("the world module isn't set up yet");
        return s;
    }
    private static volatile @Nullable BridgeSession keysSession;
    private static volatile VolatileKeys keys = VolatileKeys.EMPTY;

    /** Test seam: when set, overrides the configured per-tick block budget. */
    public static volatile int budgetOverride;

    /** Test seam: when set, overrides the configured tracker mode. */
    public static volatile @Nullable ChangeTracker.Mode modeOverride;

    public static Services services() {
        Services s = services;
        if (s == null) throw new IllegalStateException("the world module isn't set up yet");
        return s;
    }

    public static void setup(AutosketchSetup e) {
        Function<ResourceKey<Level>, @Nullable ServerLevel> levels = key -> {
            MinecraftServer server = Platform.get().currentServer();
            return server == null ? null : server.getLevel(key);
        };
        PatchApplier patches = new PatchApplier(Autosketch.link(), levels,
                () -> budgetOverride > 0 ? budgetOverride : AutosketchConfig.get().patches.tickBudget);
        WorldReads reads = new WorldReads(Autosketch.link(), levels, Util.backgroundExecutor());
        ChangeTracker tracker = new ChangeTracker(Autosketch.link(), levels,
                () -> AutosketchConfig.get().tracking.dirtyCap,
                () -> modeOverride != null ? modeOverride : ChangeTracker.Mode.valueOf(AutosketchConfig.get().tracking.tracker.toUpperCase(Locale.ROOT)),
                () -> AutosketchConfig.get().tracking.scanPeriod,
                frame -> Autosketch.bridge().send(frame));
        services = new Services(patches, reads, tracker);
        surface = new SurfaceReads(Autosketch.link(), levels, Util.backgroundExecutor());
        // The scan grant lasts until the next scan request, the connection closing or the server stopping (B4).
        Autosketch.bridge().addListener(new dev.autosketch.mod.api.Bridge.Listener() {
            @Override
            public void disconnected(BridgeSession session) {
                ScanGrants.clear();
            }
        });

        e.messages().register("patch", (msg, ex) -> handlePatch(msg, ex));
        e.messages().register("hashes", (msg, ex) -> reads.hashes(Messages.HashesRequest.decode(msg.frame()), ex, keysOf(msg)));
        e.messages().register("snapshot", (msg, ex) -> {
            if (Messages.snapshotKind(msg.frame()).equals("surface")) surface.surface(Messages.SurfaceRequest.decode(msg.frame()), ex);
            else reads.snapshot(Messages.SnapshotRequest.decode(msg.frame()), ex);
        });
        e.patchStatus(patches);
    }

    /** Start of a server tick: the tracker's volumes, then the patch budget and the sliced reads. */
    public static void tickStart() {
        Services s = services();
        s.tracker().refresh();
        s.patches().tick();
        s.reads().tick();
        if (surface != null) surface.tick();
    }

    /** End of a server tick. */
    public static void tickEnd() {
        services().tracker().endTick();
    }

    /** After the server stopped. */
    public static void serverStopped() {
        ScanGrants.clear();
        services().tracker().refresh();
    }

    /** Decodes a patch (an invalid body is {@code bad_request} by id) and queues it. */
    public static void handlePatch(Inbound msg, Exchange ex) throws ProtocolException {
        Messages.Patch patch = Messages.Patch.decode(msg.frame());
        ex.defer();
        services().patches().submit(patch, ex, keysOf(msg));
    }

    /** The parsed volatile-key list of the message's session (parsed once per connection). */
    public static VolatileKeys keysOf(Inbound msg) {
        BridgeSession s = msg.session();
        if (s != keysSession) {
            keys = VolatileKeys.parse(s.volatileKeys());
            keysSession = s;
        }
        return keys;
    }
}
