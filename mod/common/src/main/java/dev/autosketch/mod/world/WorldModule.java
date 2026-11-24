package dev.autosketch.mod.world;

import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetup;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.api.Exchange;
import dev.autosketch.mod.api.Inbound;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.prompt.InGamePrompts;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.SelectMessages;
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
 * handlers (and select's {@code search}, {@code fill}, {@code expand} and the {@code mask} and {@code coarse} snapshots, 18), the patch status for {@code /autosketch status}, and the server-tick hooks that drive the
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
    private static volatile @Nullable MaterialSearch search;
    private static volatile @Nullable WorldFill fills;
    private static volatile @Nullable CoarseReads coarse;

    /** Coarse snapshots (18, piece 5), for GameTests. */
    public static CoarseReads coarse() {
        CoarseReads c = coarse;
        if (c == null) throw new IllegalStateException("the world module isn't set up yet");
        return c;
    }

    /** Fill and expand (18, pieces 3 and 4), for GameTests. */
    public static WorldFill fills() {
        WorldFill f = fills;
        if (f == null) throw new IllegalStateException("the world module isn't set up yet");
        return f;
    }

    /** The material search (18, piece 2), for GameTests. */
    public static MaterialSearch search() {
        MaterialSearch s = search;
        if (s == null) throw new IllegalStateException("the world module isn't set up yet");
        return s;
    }

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
        // A select prompt fixes its read grant as it goes out (18, piece 1; C1's hook).
        InGamePrompts.setSelectGrant(SelectGrants::forPrompt);
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
        MaterialSearch materials = new MaterialSearch(levels, Util.backgroundExecutor());
        search = materials;
        WorldFill fill = new WorldFill(levels, Util.backgroundExecutor());
        fills = fill;
        CoarseReads cells = new CoarseReads(reads, levels, Util.backgroundExecutor());
        coarse = cells;
        // The scan and select grants last until the next request replaces them, the connection closing or the server stopping (B4; 18).
        Autosketch.bridge().addListener(new dev.autosketch.mod.api.Bridge.Listener() {
            @Override
            public void disconnected(BridgeSession session) {
                ScanGrants.clear();
                SelectGrants.clear();
            }
        });

        e.messages().register("patch", (msg, ex) -> handlePatch(msg, ex));
        e.messages().register("hashes", (msg, ex) -> reads.hashes(Messages.HashesRequest.decode(msg.frame()), ex, keysOf(msg)));
        e.messages().register("snapshot", (msg, ex) -> {
            switch (Messages.snapshotKind(msg.frame())) {
                case "surface" -> surface.surface(Messages.SurfaceRequest.decode(msg.frame()), ex);
                case "mask" -> reads.mask(SelectMessages.MaskSnapshotRequest.decode(msg.frame()), ex);
                case "coarse" -> cells.coarse(SelectMessages.CoarseSnapshotRequest.decode(msg.frame()), ex);
                default -> reads.snapshot(Messages.SnapshotRequest.decode(msg.frame()), ex);
            }
        });
        // Select (18): served once a select request's grant is in force. With search, fill, expand and
        // the mask and coarse snapshots all registered, the hello lists the feature `select` (M3;
        // AutosketchCore#features keys it on the `fill` handler).
        e.messages().register("search", (msg, ex) -> materials.search(SelectMessages.SearchRequest.decode(msg.frame()), ex));
        e.messages().register("fill", (msg, ex) -> fill.fill(SelectMessages.FillRequest.decode(msg.frame()), ex));
        e.messages().register("expand", (msg, ex) -> fill.expand(SelectMessages.ExpandRequest.decode(msg.frame()), ex));
        e.patchStatus(patches);
    }

    /** Start of a server tick: the tracker's volumes, then the patch budget and the sliced reads. */
    public static void tickStart() {
        Services s = services();
        s.tracker().refresh();
        s.patches().tick();
        s.reads().tick();
        if (surface != null) surface.tick();
        if (search != null) search.tick();
        if (fills != null) fills.tick();
        if (coarse != null) coarse.tick();
    }

    /** End of a server tick. */
    public static void tickEnd() {
        services().tracker().endTick();
    }

    /** After the server stopped. */
    public static void serverStopped() {
        ScanGrants.clear();
        SelectGrants.clear();
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
