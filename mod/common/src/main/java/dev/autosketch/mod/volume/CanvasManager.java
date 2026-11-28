package dev.autosketch.mod.volume;

import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.ErrorCodes;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.RequestMessages;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.IntSupplier;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import org.jetbrains.annotations.Nullable;

/**
 * The canvas (19, *Model*, *Setting the canvas*; 13, *Request control and canvas*): the agent's
 * lasting read area, whole chunk columns over the dimension's full build height, at most
 * {@code canvasChunks} chunks across on either axis. One per server, global like the volumes, not
 * saved: it lasts until the server stops or someone clears or replaces it, across MCP reconnects.
 * Set by the wand's {@code canvas} mode, {@code /autosketch canvas here|grow}, and the MCP's
 * {@code canvas.set}. A work volume the player marks outside it clears it ({@link #workMarked}).
 * Every change notifies the listeners (the world module's read area) and sends {@code canvas} when
 * the MCP's hello lists the feature. Server thread only.
 */
public final class CanvasManager {
    /** A canvas change: the dimension and box, or both null when cleared. */
    public interface Listener {
        void changed(@Nullable ResourceKey<Level> dimension, @Nullable Box box);
    }

    private final Bridge bridge;
    private final IntSupplier canvasChunks;
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
    private @Nullable MinecraftServer server;
    private @Nullable ResourceKey<Level> dimension;
    private @Nullable Box box;

    public CanvasManager(Bridge bridge, IntSupplier canvasChunks) {
        this.bridge = bridge;
        this.canvasChunks = canvasChunks;
    }

    public void addListener(Listener l) {
        listeners.add(l);
    }

    /** Server start: no canvas. */
    public void serverStarted(MinecraftServer server) {
        this.server = server;
        dimension = null;
        box = null;
        notifyListeners();
    }

    public void serverStopping() {
        server = null;
        dimension = null;
        box = null;
        notifyListeners();
    }

    public @Nullable Box box() {
        return box;
    }

    public @Nullable ResourceKey<Level> dimension() {
        return dimension;
    }

    /** Chunks across on x and z, for {@code show} and notices: {@code 64×64 chunks}. */
    public static String chunks(Box b) {
        return ((b.maxX() >> 4) - (b.minX() >> 4) + 1) + "×" + ((b.maxZ() >> 4) - (b.minZ() >> 4) + 1) + " chunks";
    }

    /** {@code box} widened to whole chunk columns and the level's full build height (19, *Setting the canvas*). */
    public static Box widen(ServerLevel level, Box b) {
        return RequestMessages.Canvas.widen(b, level.getMinBuildHeight(), level.getMaxBuildHeight() - 1);
    }

    /** The refusal text over {@code canvasChunks}, naming the key (13, {@code bad_volumes}), or null within it. */
    @Nullable String overCap(Box widened) {
        int across = RequestMessages.Canvas.chunksAcross(widened), cap = canvasChunks.getAsInt();
        if (across <= cap) return null;
        return "the canvas would span " + across + " chunks across; the most is " + cap + " (config canvasChunks)";
    }

    // ── changes ───────────────────────────────────────────────────────────────────────────────

    /** The player's canvas (wand corners, {@code here}, {@code grow}): widened, checked against the cap, replacing any. Returns the widened box. */
    public Box set(ServerLevel level, Box any) throws VolumeManager.Refused {
        Box w = widen(level, any);
        String over = overCap(w);
        if (over != null) throw new VolumeManager.Refused(Character.toUpperCase(over.charAt(0)) + over.substring(1) + ".");
        apply(level.dimension(), w, null);
        return w;
    }

    /** {@code canvas here [radius]}: the square of chunks within {@code radius} of {@code at}'s chunk. */
    public Box here(ServerLevel level, BlockPos at, int radius) throws VolumeManager.Refused {
        int cx = at.getX() >> 4, cz = at.getZ() >> 4;
        return set(level, new Box((cx - radius) << 4, 0, (cz - radius) << 4, ((cx + radius) << 4) + 15, 0, ((cz + radius) << 4) + 15));
    }

    /** {@code canvas grow <chunks>}: the canvas grown by {@code n} chunks on every side. */
    public Box grow(int n) throws VolumeManager.Refused {
        if (box == null || dimension == null || server == null) throw new VolumeManager.Refused("No canvas is set: /autosketch canvas here, or mark one in canvas mode.");
        ServerLevel level = server.getLevel(dimension);
        if (level == null) throw new VolumeManager.Refused("The canvas's dimension " + dimension.location() + " isn't loaded.");
        Box b = box;
        return set(level, new Box(b.minX() - 16 * n, b.minY(), b.minZ() - 16 * n, b.maxX() + 16 * n, b.maxY(), b.maxZ() + 16 * n));
    }

    /** {@code canvas clear}; false when there was none. */
    public boolean clear() {
        if (box == null) return false;
        apply(null, null, null);
        return true;
    }

    /**
     * {@code canvas.set} (13, *Request control and canvas*): as if the player had marked it. Answered
     * by the {@code canvas} carrying {@code requestId}; {@code wrong_dimension}, {@code bad_volumes}.
     */
    public Box setFromAgent(long requestId, String dimensionId, Box any) throws ProtocolException {
        ServerLevel level = levelOf(dimensionId);
        if (level == null) throw ProtocolException.refuse(ErrorCodes.WRONG_DIMENSION, requestId, "the server has no dimension " + dimensionId);
        Box w = widen(level, any);
        String over = overCap(w);
        if (over != null) throw ProtocolException.refuse(ErrorCodes.BAD_VOLUMES, requestId, over);
        apply(level.dimension(), w, requestId);
        return w;
    }

    /**
     * A work volume the player marked (19, *Setting the canvas*): one outside the canvas (not inside
     * it, or in another dimension) clears the canvas. True when it did.
     */
    public boolean workMarked(ResourceKey<Level> workDimension, Box work) {
        if (box == null) return false;
        if (workDimension.equals(dimension) && box.contains(work)) return false;
        apply(null, null, null);
        return true;
    }

    private void apply(@Nullable ResourceKey<Level> dim, @Nullable Box b, @Nullable Long requestId) {
        dimension = dim;
        box = b;
        notifyListeners();
        if (requestId != null) bridge.send(frame(requestId));
        else sendIfListed();
    }

    private void notifyListeners() {
        for (Listener l : listeners) l.changed(dimension, box);
    }

    private @Nullable ServerLevel levelOf(String dimensionId) {
        if (server == null) return null;
        ResourceLocation id = ResourceLocation.tryParse(dimensionId);
        return id == null ? null : server.getLevel(ResourceKey.create(Registries.DIMENSION, id));
    }

    // ── wire ──────────────────────────────────────────────────────────────────────────────────

    /** The {@code canvas} message for the current state; {@code requestId} on the one confirming a {@code canvas.set}. */
    public Frame frame(@Nullable Long requestId) {
        if (box == null || dimension == null) return RequestMessages.Canvas.none().encode();
        return new RequestMessages.Canvas(requestId, dimension.location().toString(), box).encode();
    }

    /** Sends {@code canvas} when an MCP is connected whose hello lists the feature (after {@code volumes} on connect, and on every change). */
    public void sendIfListed() {
        BridgeSession s = bridge.session();
        if (s != null && s.features().contains(RequestMessages.FEATURE_CANVAS)) bridge.send(frame(null));
    }
}
