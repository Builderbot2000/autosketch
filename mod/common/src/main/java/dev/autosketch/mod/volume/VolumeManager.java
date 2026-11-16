package dev.autosketch.mod.volume;

import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.ErrorCodes;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import java.util.ArrayList;
import java.util.List;
import java.util.function.LongSupplier;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import org.jetbrains.annotations.Nullable;

/**
 * The link's work and context volumes (13, *Work and context volumes in-game*; M3, M4). One set of
 * volumes per server, shared by every op: the MCP links one document to one work volume, so there is
 * one link, whoever marked it. Wand modes and pending corners are per player ({@link WandState}).
 *
 * <p>The context is the work volume grown by {@code grow} (3 by default; always at least 1, so the
 * seam around the work volume is covered) plus any boxes the player added, clipped to the build
 * height, and capped in total volume. The work volume is not persisted: it lasts until the server
 * stops or a player clears it, across MCP reconnects. Every change updates {@link LinkVolumesHolder},
 * the chunk tickets, and sends {@code volumes}. Server thread only.
 */
public final class VolumeManager {
    public static final int DEFAULT_GROW = 3;

    /** A refused change, with the text shown to the player. */
    public static final class Refused extends Exception {
        public Refused(String message) {
            super(message);
        }
    }

    private final LinkVolumesHolder holder;
    private final Bridge bridge;
    private final ChunkTickets tickets;
    private final LongSupplier contextCap;
    private @Nullable MinecraftServer server;

    private long link = 1;
    private @Nullable ResourceKey<Level> dimension;
    private @Nullable Box work;
    private @Nullable Box extended;
    private int grow = DEFAULT_GROW;
    private final List<Box> extra = new ArrayList<>();

    public VolumeManager(LinkVolumesHolder holder, Bridge bridge, ChunkTickets tickets, LongSupplier contextCap) {
        this.holder = holder;
        this.bridge = bridge;
        this.tickets = tickets;
        this.contextCap = contextCap;
    }

    /** Server start: volumes start empty with a fresh link counter. */
    public void serverStarted(MinecraftServer server) {
        this.server = server;
        link = 1;
        dimension = null;
        work = null;
        extended = null;
        grow = DEFAULT_GROW;
        extra.clear();
        holder.set(null);
    }

    public void serverStopping() {
        tickets.releaseAll();
        server = null;
        holder.set(null);
    }

    public long link() {
        return link;
    }

    public @Nullable Box work() {
        return work;
    }

    public @Nullable ResourceKey<Level> dimension() {
        return dimension;
    }

    public int grow() {
        return grow;
    }

    public List<Box> extraContext() {
        return List.copyOf(extra);
    }

    // ── changes ───────────────────────────────────────────────────────────────────────────────

    /** A new work volume: a relink (new link, extension dropped). Added context boxes are kept in the same dimension. */
    public void setWork(ServerLevel level, Box box) throws Refused {
        Box clipped = clip(level, box);
        if (clipped == null) throw new Refused("The work volume lies outside the build height.");
        boolean sameDim = level.dimension().equals(dimension);
        List<Box> keep = sameDim ? extra : List.of();
        checkCap(level, clipped, grow, keep);
        if (!sameDim) extra.clear();
        dimension = level.dimension();
        work = clipped;
        extended = null;
        link++;
        refresh();
    }

    /** Removes the work volume, which unlinks (a new link value, as 13 requires). */
    public void clear() {
        if (work == null) return;
        work = null;
        extended = null;
        dimension = null;
        grow = DEFAULT_GROW;
        extra.clear();
        link++;
        refresh();
    }

    /** {@code context add}: adds a box (in the work volume's dimension). */
    public void contextAdd(ServerLevel level, Box box) throws Refused {
        requireWork(level);
        Box clipped = clip(level, box);
        if (clipped == null) throw new Refused("That box lies outside the build height.");
        List<Box> next = new ArrayList<>(extra);
        next.add(clipped);
        checkCap(level, work, grow, next);
        extra.add(clipped);
        refresh();
    }

    /** {@code context grow <n>}: the work volume grown by {@code n} (≥ 1), replacing the boxes. */
    public void contextGrow(ServerLevel level, int n) throws Refused {
        requireWork(level);
        if (n < 1) throw new Refused("The context must cover at least the one-block seam around the work volume (grow ≥ 1).");
        checkCap(level, work, n, List.of());
        grow = n;
        extra.clear();
        refresh();
    }

    /** {@code context clear}: back to the default (work grown by 3). */
    public void contextClear() {
        if (grow == DEFAULT_GROW && extra.isEmpty()) return;
        grow = DEFAULT_GROW;
        extra.clear();
        refresh();
    }

    /**
     * {@code volumes.extend} (13, *Message schemas*): the MCP's whole-block extension of the work
     * volume. Keeps the link; replaced by a later extension, dropped with a new link.
     */
    public void extend(long requestId, long forLink, Box box) throws ProtocolException {
        if (work == null || forLink != link) throw ProtocolException.refuse(ErrorCodes.STALE_LINK, requestId, "link " + forLink + " isn't the current link " + (work == null ? "(no work volume)" : link));
        if (!box.contains(work)) throw ProtocolException.refuse(ErrorCodes.BAD_EXTENSION, requestId, "box " + box + " doesn't contain the work volume " + work);
        extended = box.equals(work) ? null : box;
        refresh();
    }

    private void requireWork(ServerLevel level) throws Refused {
        if (work == null) throw new Refused("Set a work volume first.");
        if (!level.dimension().equals(dimension)) throw new Refused("The work volume is in " + dimension.location() + "; context boxes must be in the same dimension.");
    }

    private void checkCap(ServerLevel level, Box w, int g, List<Box> boxes) throws Refused {
        long total = 0;
        Box grown = clip(level, w.grow(g));
        if (grown != null) total += grown.volume();
        for (Box b : boxes) total += b.volume();
        long cap = contextCap.getAsLong();
        if (total > cap) throw new Refused(String.format("The context would cover %,d blocks; the cap is %,d (config contextCap).", total, cap));
    }

    /** {@code box} clipped to the level's build height, or null when it lies entirely outside. */
    static @Nullable Box clip(ServerLevel level, Box box) {
        return clipY(box, level.getMinBuildHeight(), level.getMaxBuildHeight() - 1);
    }

    static @Nullable Box clipY(Box box, int minY, int maxY) {
        int lo = Math.max(box.minY(), minY), hi = Math.min(box.maxY(), maxY);
        if (lo > hi) return null;
        return new Box(box.minX(), lo, box.minZ(), box.maxX(), hi, box.maxZ());
    }

    // ── views ─────────────────────────────────────────────────────────────────────────────────

    /** The current volumes, or null when unlinked. */
    public @Nullable LinkVolumes current() {
        if (work == null || server == null) return null;
        ServerLevel level = server.getLevel(dimension);
        List<Box> context = new ArrayList<>();
        Box grown = level == null ? work.grow(grow) : clip(level, work.grow(grow));
        context.add(grown == null ? work : grown);
        context.addAll(extra);
        return new LinkVolumes(link, dimension, work, extended, context);
    }

    /** The {@code volumes} message for the current state. */
    public Frame volumesFrame() {
        LinkVolumes v = current();
        if (v == null) return Messages.Volumes.none(link).encode();
        return new Messages.Volumes(link, v.dimension().location().toString(), v.work(), v.context(), v.extended()).encode();
    }

    /** Re-publishes after a change: holder listeners, chunk tickets, then {@code volumes} to the MCP. */
    public void refresh() {
        LinkVolumes v = current();
        holder.set(v);
        updateTickets();
        bridge.send(volumesFrame());
    }

    /** Tickets are held while linked: a work volume is set and an MCP is connected (M4). */
    public void updateTickets() {
        LinkVolumes v = holder.current();
        if (v == null || server == null || !bridge.connected()) {
            tickets.releaseAll();
            return;
        }
        ServerLevel level = server.getLevel(v.dimension());
        if (level == null) {
            tickets.releaseAll();
            return;
        }
        List<Box> boxes = new ArrayList<>(v.context());
        boxes.add(v.effectiveWork());
        tickets.hold(level, boxes);
    }
}
