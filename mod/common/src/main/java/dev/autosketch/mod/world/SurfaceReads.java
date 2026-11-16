package dev.autosketch.mod.world;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Exchange;
import dev.autosketch.mod.api.LinkState;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.protocol.Area;
import dev.autosketch.mod.protocol.BodyTypes.SurfaceLayer;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.ErrorCodes;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Executor;
import java.util.function.Function;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.ChunkAccess;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.status.ChunkType;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.chunk.storage.ChunkSerializer;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * {@code snapshot} kind {@code surface} (13, *Message schemas*; B4): per column of the area, the
 * topmost non-air block (the {@code WORLD_SURFACE} heightmap, one below its value) and, with
 * {@code ceiling}, the lowest non-air block at or above that y. Served inside the scan grant's columns
 * (with or without a work volume) or inside the chunks the link keeps loaded. Chunks are read one at a
 * time on the server thread under {@link WorldReads#sliceNanos} per tick; a chunk that isn't loaded is
 * loaded from disk when it was fully generated, and never generated: one that wasn't is listed in
 * {@code missing} and its columns read as none. No ticket is taken. The body is encoded off-thread.
 */
public final class SurfaceReads {
    private static final Logger LOG = LogUtils.getLogger();

    private final LinkState link;
    private final Function<ResourceKey<Level>, @Nullable ServerLevel> levels;
    private final Executor background;
    private final Deque<Job> jobs = new ArrayDeque<>();

    public SurfaceReads(LinkState link, Function<ResourceKey<Level>, @Nullable ServerLevel> levels, Executor background) {
        this.link = link;
        this.levels = levels;
        this.background = background;
    }

    /** Cost of the last finished surface read: columns, chunks (and how many were loaded from disk or missing), ticks, server time, body bytes. */
    public record Stats(long columns, int chunks, int loaded, int missing, int ticks, long serverNanos, int bytes) {}

    public static volatile @Nullable Stats lastRead;

    public boolean busy() {
        return !jobs.isEmpty();
    }

    public void surface(Messages.SurfaceRequest req, Exchange ex) throws ProtocolException {
        ServerLevel level = check(req);
        if (req.columns().columns() > 64L * 1024 * 1024)
            throw ProtocolException.refuse(ErrorCodes.TOO_LARGE, req.id(), req.columns().columns() + " columns are too many for one frame; ask for a smaller area");
        ex.defer();
        jobs.addLast(new Job(level, req, ex));
        tick();
    }

    /** {@code wrong_dimension}, {@code no_volumes}, {@code outside_volumes}; the scan grant first. */
    private ServerLevel check(Messages.SurfaceRequest req) throws ProtocolException {
        long id = req.id();
        Area a = req.columns();
        ScanGrants.Held g = ScanGrants.current();
        if (g != null && g.dimension().location().toString().equals(req.dimension()) && g.grant().columns().contains(a)) {
            ServerLevel level = levels.apply(g.dimension());
            if (level == null) throw ProtocolException.refuse(PatchApplier.INTERNAL, id, "the dimension " + req.dimension() + " isn't loaded");
            return level;
        }
        LinkVolumes v = link.current();
        if (v == null) throw ProtocolException.refuse(ErrorCodes.NO_VOLUMES, id, "no work volume is set and no scan grant covers " + a);
        if (!v.dimension().location().toString().equals(req.dimension()))
            throw ProtocolException.refuse(ErrorCodes.WRONG_DIMENSION, id, "the volumes are in " + v.dimension().location() + ", not " + req.dimension());
        List<Box> kept = new ArrayList<>(v.context());
        kept.add(v.work());
        if (v.extended() != null) kept.add(v.extended());
        for (int cz = a.minZ() >> 4; cz <= a.maxZ() >> 4; cz++)
            for (int cx = a.minX() >> 4; cx <= a.maxX() >> 4; cx++) {
                boolean in = false;
                for (Box b : kept) in |= cx >= b.minX() >> 4 && cx <= b.maxX() >> 4 && cz >= b.minZ() >> 4 && cz <= b.maxZ() >> 4;
                if (!in) throw ProtocolException.refuse(ErrorCodes.OUTSIDE_VOLUMES, id, "columns " + a + " reach chunk " + cx + "," + cz + " outside the volumes and the scan grant");
            }
        ServerLevel level = levels.apply(v.dimension());
        if (level == null) throw ProtocolException.refuse(PatchApplier.INTERNAL, id, "the dimension " + req.dimension() + " isn't loaded");
        return level;
    }

    /** Reads chunks for the jobs in order, within the slice budget. Server thread. */
    public void tick() {
        long deadline = System.nanoTime() + WorldReads.sliceNanos;
        boolean first = true;
        while (!jobs.isEmpty()) {
            Job j = jobs.peekFirst();
            long t0 = System.nanoTime();
            j.ticks++;
            try {
                while (j.next < j.chunks.size() && (first || System.nanoTime() < deadline)) {
                    j.read(j.chunks.get(j.next++));
                    first = false;
                }
            } catch (RuntimeException e) {
                jobs.pollFirst();
                LOG.error("Autosketch: reading the surface failed", e);
                j.ex.error(PatchApplier.INTERNAL, "the mod failed reading the surface: " + e);
                continue;
            }
            j.serverNanos += System.nanoTime() - t0;
            if (j.next < j.chunks.size()) return;
            jobs.pollFirst();
            background.execute(j::finish);
        }
    }

    /**
     * The chunk if it is loaded, or loaded from disk when it was fully generated; null when it was
     * never generated (or only partly). Never generates anything.
     */
    static @Nullable LevelChunk existing(ServerLevel level, int cx, int cz, int[] loadedCounter) {
        LevelChunk now = level.getChunkSource().getChunkNow(cx, cz);
        if (now != null) return now;
        Optional<CompoundTag> tag = level.getChunkSource().chunkMap.read(new ChunkPos(cx, cz)).join();
        if (tag.isEmpty() || ChunkSerializer.getChunkTypeFromTag(tag.get()) != ChunkType.LEVELCHUNK) return null;
        loadedCounter[0]++;
        return level.getChunk(cx, cz);
    }

    private final class Job {
        final ServerLevel level;
        final Messages.SurfaceRequest req;
        final Exchange ex;
        final List<ChunkPos> chunks = new ArrayList<>();
        final List<Messages.ChunkXZ> missing = new ArrayList<>();
        final List<String> palette = new ArrayList<>();
        final Map<String, Integer> byName = new HashMap<>();
        final Map<BlockState, Integer> byState = new IdentityHashMap<>();
        final SurfaceLayer surface;
        final @Nullable SurfaceLayer ceilings;
        final int minY, maxY;
        final int[] loaded = {0};
        int next, ticks;
        long serverNanos;

        Job(ServerLevel level, Messages.SurfaceRequest req, Exchange ex) {
            this.level = level;
            this.req = req;
            this.ex = ex;
            Area a = req.columns();
            for (int cz = a.minZ() >> 4; cz <= a.maxZ() >> 4; cz++)
                for (int cx = a.minX() >> 4; cx <= a.maxX() >> 4; cx++) chunks.add(new ChunkPos(cx, cz));
            int n = Math.toIntExact(a.columns());
            surface = SurfaceLayer.of(n);
            ceilings = req.ceiling() == null ? null : SurfaceLayer.of(n);
            minY = level.getMinBuildHeight();
            maxY = level.getMaxBuildHeight() - 1;
        }

        int index(BlockState st) {
            Integer p = byState.get(st);
            if (p != null) return p;
            String name = States.print(st);
            p = byName.get(name);
            if (p == null) {
                p = palette.size();
                palette.add(name);
                byName.put(name, p);
            }
            byState.put(st, p);
            return p;
        }

        void read(ChunkPos cp) {
            LevelChunk c = existing(level, cp.x, cp.z, loaded);
            if (c == null) {
                missing.add(new Messages.ChunkXZ(cp.x, cp.z));
                return;
            }
            Area a = req.columns();
            int x0 = Math.max(a.minX(), cp.getMinBlockX()), x1 = Math.min(a.maxX(), cp.getMaxBlockX());
            int z0 = Math.max(a.minZ(), cp.getMinBlockZ()), z1 = Math.min(a.maxZ(), cp.getMaxBlockZ());
            BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
            for (int z = z0; z <= z1; z++)
                for (int x = x0; x <= x1; x++) {
                    int i = (x - a.minX()) + a.sizeX() * (z - a.minZ());
                    int top = c.getHeight(Heightmap.Types.WORLD_SURFACE, x & 15, z & 15);
                    if (top >= minY) {
                        surface.heights()[i] = top - minY + 1;
                        surface.states()[i] = index(c.getBlockState(pos.set(x, top, z)));
                    }
                    if (ceilings != null) {
                        int from = Math.max(minY, req.ceiling());
                        int y = firstNonAir(c, x, z, from, Math.min(top, maxY), pos);
                        if (y != Integer.MIN_VALUE) {
                            ceilings.heights()[i] = y - minY + 1;
                            ceilings.states()[i] = index(c.getBlockState(pos.set(x, y, z)));
                        }
                    }
                }
        }

        /** The lowest y in {@code from..to} whose state isn't air, skipping all-air sections; MIN_VALUE when none. */
        int firstNonAir(ChunkAccess c, int x, int z, int from, int to, BlockPos.MutableBlockPos pos) {
            int y = from;
            while (y <= to) {
                LevelChunkSection s = c.getSection(c.getSectionIndex(y));
                if (s.hasOnlyAir()) {
                    y = ((y >> 4) + 1) << 4;
                    continue;
                }
                if (!s.getBlockState(x & 15, y & 15, z & 15).isAir()) return y;
                y++;
            }
            return Integer.MIN_VALUE;
        }

        void finish() {
            try {
                Messages.SurfaceResult r = new Messages.SurfaceResult(req.id(), req.dimension(), req.columns(), minY, req.ceiling(), missing, palette, surface, ceilings);
                Frame f = r.encode();
                lastRead = new Stats(req.columns().columns(), chunks.size(), loaded[0], missing.size(), ticks, serverNanos, f.body().length);
                ex.reply(f);
            } catch (RuntimeException e) {
                LOG.error("Autosketch: building a surface reply failed", e);
                ex.error(PatchApplier.INTERNAL, "the mod failed building the reply: " + e.getMessage());
            }
        }
    }
}
