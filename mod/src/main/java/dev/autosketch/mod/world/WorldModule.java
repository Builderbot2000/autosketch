package dev.autosketch.mod.world;

import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.api.Exchange;
import dev.autosketch.mod.api.Inbound;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import java.util.Locale;
import java.util.function.Function;
import java.util.function.Supplier;
import net.minecraft.Util;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStoppedEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.neoforged.neoforge.server.ServerLifecycleHooks;
import org.jetbrains.annotations.Nullable;

/**
 * Silo O's registration (13, M5–M9): the {@code patch}, {@code hashes} and {@code snapshot}
 * handlers, the patch status for {@code /autosketch status}, and the server-tick hooks that drive the
 * patch budget, the sliced reads and the change tracker. Registers through
 * {@link AutosketchSetupEvent}, so no other package's files change.
 */
@EventBusSubscriber(modid = Autosketch.MOD_ID)
public final class WorldModule {
    private WorldModule() {}

    /** The world services, shared by the handlers, the tick hooks and GameTests. */
    public record Services(PatchApplier patches, WorldReads reads, ChangeTracker tracker) {}

    private static volatile @Nullable Services services;
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

    @SubscribeEvent
    static void setup(AutosketchSetupEvent e) {
        Function<ResourceKey<Level>, @Nullable ServerLevel> levels = key -> {
            MinecraftServer server = ServerLifecycleHooks.getCurrentServer();
            return server == null ? null : server.getLevel(key);
        };
        PatchApplier patches = new PatchApplier(Autosketch.link(), levels,
                () -> budgetOverride > 0 ? budgetOverride : config(AutosketchConfig.TICK_BUDGET::get, 10_000));
        WorldReads reads = new WorldReads(Autosketch.link(), levels, Util.backgroundExecutor());
        ChangeTracker tracker = new ChangeTracker(Autosketch.link(), levels,
                () -> config(AutosketchConfig.DIRTY_CAP::get, Messages.Dirty.CAP),
                () -> modeOverride != null ? modeOverride : ChangeTracker.Mode.valueOf(config(AutosketchConfig.TRACKER::get, "hook").toUpperCase(Locale.ROOT)),
                () -> config(AutosketchConfig.SCAN_PERIOD::get, 20),
                frame -> Autosketch.bridge().send(frame));
        services = new Services(patches, reads, tracker);

        e.messages().register("patch", (msg, ex) -> handlePatch(msg, ex));
        e.messages().register("hashes", (msg, ex) -> reads.hashes(Messages.HashesRequest.decode(msg.frame()), ex, keysOf(msg)));
        e.messages().register("snapshot", (msg, ex) -> reads.snapshot(Messages.SnapshotRequest.decode(msg.frame()), ex));
        e.patchStatus(patches);

        NeoForge.EVENT_BUS.addListener((ServerTickEvent.Pre t) -> {
            Services s = services();
            s.tracker().refresh();
            s.patches().tick();
            s.reads().tick();
        });
        NeoForge.EVENT_BUS.addListener((ServerTickEvent.Post t) -> services().tracker().endTick());
        NeoForge.EVENT_BUS.addListener((ServerStoppedEvent t) -> services().tracker().refresh());
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

    private static <T> T config(Supplier<T> value, T fallback) {
        try {
            return value.get();
        } catch (RuntimeException e) {
            return fallback; // config not loaded yet
        }
    }
}
