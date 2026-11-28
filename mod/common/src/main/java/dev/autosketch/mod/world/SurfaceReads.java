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
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.function.Function;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.Tag;
import net.minecraft.resources.ResourceKey;
import net.minecraft.util.Mth;
import net.minecraft.util.SimpleBitStorage;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.PalettedContainer;
import net.minecraft.world.level.chunk.status.ChunkType;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.chunk.storage.ChunkSerializer;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * {@code snapshot} kind {@code surface} (13, *Message schemas*; 18, piece 10): per column of the
 * area, the topmost non-air block (the {@code WORLD_SURFACE} heightmap, one below its value) and,
 * with {@code ceiling}, the lowest non-air block at or above that y. Served inside the select grant's
 * square (with or without a work volume) or inside the chunks the link keeps loaded. Chunks are read in
 * order under {@link WorldReads#sliceNanos} per tick of server-thread time, never generated: one that
 * wasn't fully generated is listed in {@code missing} and its columns read as none. No ticket is taken.
 * The body is encoded off-thread.
 *
 * <p>Inside the select grant (18, piece 10; M5) a loaded chunk is read on the server thread, one that
 * isn't from its saved tag through the chunk storage's asynchronous I/O ({@link WorldReads#PREFETCH}
 * ahead), its heightmap and the sections holding the tops decoded off-thread ({@link #decodeSurface}),
 * never loaded; one saved by another game version is loaded the vanilla way ({@link #existing}) so the
 * data fixers upgrade it. Volume reads load an unloaded chunk on the server thread, since the link
 * keeps their chunks loaded.
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

    /**
     * Cost of the last finished surface read: columns, chunks (read loaded, decoded from disk, loaded
     * the vanilla way, missing), ticks, server time and the longest tick's, the wall time from request
     * to reply, body bytes.
     */
    public record Stats(long columns, int chunks, int live, int disk, int loaded, int missing, int ticks, long serverNanos, long maxTickNanos, long wallNanos,
            int bytes) {}

    public static volatile @Nullable Stats lastRead;

    public boolean busy() {
        return !jobs.isEmpty();
    }

    public void surface(Messages.SurfaceRequest req, Exchange ex) throws ProtocolException {
        Checked c = check(req);
        if (req.columns().columns() > 64L * 1024 * 1024)
            throw ProtocolException.refuse(ErrorCodes.TOO_LARGE, req.id(), req.columns().columns() + " columns are too many for one frame; ask for a smaller area");
        ex.defer();
        jobs.addLast(new Job(c.level(), req, ex, c.grant()));
        tick();
    }

    /** The level to read, and whether the select grant serves the read (by chunk column from disk) rather than the volumes. */
    private record Checked(ServerLevel level, boolean grant) {}

    /** {@code wrong_dimension}, {@code no_volumes}, {@code outside_volumes}; the select grant ({@code too_large}) first. */
    private Checked check(Messages.SurfaceRequest req) throws ProtocolException {
        long id = req.id();
        Area a = req.columns();
        // Select (18; 13, *Where the mod serves reads*): inside the select grant's square or the canvas (19), capped by contextCap.
        SelectGrants.ReadArea sg = SelectGrants.area(req.dimension());
        if (sg != null && sg.hasColumns(a)) {
            long cap = dev.autosketch.mod.AutosketchConfig.get().volumes.contextCap;
            if (a.columns() > cap) throw ProtocolException.refuse(ErrorCodes.TOO_LARGE, id, a.columns() + " columns are over contextCap (" + cap + "); ask for a smaller area");
            ServerLevel level = levels.apply(sg.dimension());
            if (level == null) throw ProtocolException.refuse(PatchApplier.INTERNAL, id, "the dimension " + req.dimension() + " isn't loaded");
            return new Checked(level, true);
        }
        LinkVolumes v = link.current();
        if (v == null) throw ProtocolException.refuse(ErrorCodes.NO_VOLUMES, id, "no work volume is set and no select grant covers " + a);
        if (!v.dimension().location().toString().equals(req.dimension()))
            throw ProtocolException.refuse(ErrorCodes.WRONG_DIMENSION, id, "the volumes are in " + v.dimension().location() + ", not " + req.dimension());
        List<Box> kept = new ArrayList<>(v.context());
        kept.add(v.work());
        if (v.extended() != null) kept.add(v.extended());
        for (int cz = a.minZ() >> 4; cz <= a.maxZ() >> 4; cz++)
            for (int cx = a.minX() >> 4; cx <= a.maxX() >> 4; cx++) {
                boolean in = false;
                for (Box b : kept) in |= cx >= b.minX() >> 4 && cx <= b.maxX() >> 4 && cz >= b.minZ() >> 4 && cz <= b.maxZ() >> 4;
                if (!in) throw ProtocolException.refuse(ErrorCodes.OUTSIDE_VOLUMES, id, "columns " + a + " reach chunk " + cx + "," + cz + " outside the volumes and the select grant");
            }
        ServerLevel level = levels.apply(v.dimension());
        if (level == null) throw ProtocolException.refuse(PatchApplier.INTERNAL, id, "the dimension " + req.dimension() + " isn't loaded");
        return new Checked(level, false);
    }


    /** Reads chunks for the jobs in order, within the slice budget. Server thread. */
    public void tick() {
        long deadline = System.nanoTime() + WorldReads.sliceNanos;
        boolean first = true;
        while (!jobs.isEmpty()) {
            Job j = jobs.peekFirst();
            long t0 = System.nanoTime();
            j.ticks++;
            boolean done;
            try {
                done = j.step(deadline, first);
            } catch (RuntimeException e) {
                jobs.pollFirst();
                j.cancel();
                LOG.error("Autosketch: reading the surface failed", e);
                j.ex.error(PatchApplier.INTERNAL, "the mod failed reading the surface: " + e);
                continue;
            }
            first = false;
            long spent = System.nanoTime() - t0;
            j.serverNanos += spent;
            j.maxTickNanos = Math.max(j.maxTickNanos, spent);
            if (!done) return;
            jobs.pollFirst();
            background.execute(j::finish);
        }
    }

    /**
     * The chunk if it is loaded, or loaded from disk when it was fully generated; null when it was
     * never generated (or only partly). Never generates anything. Volume reads use it (the link keeps
     * their chunks loaded), and every select read for a chunk saved by another game version, so the
     * data fixers upgrade it.
     */
    static @Nullable LevelChunk existing(ServerLevel level, int cx, int cz, int[] loadedCounter) {
        LevelChunk now = level.getChunkSource().getChunkNow(cx, cz);
        if (now != null) return now;
        Optional<CompoundTag> tag = level.getChunkSource().chunkMap.read(new ChunkPos(cx, cz)).join();
        if (tag.isEmpty() || ChunkSerializer.getChunkTypeFromTag(tag.get()) != ChunkType.LEVELCHUNK) return null;
        loadedCounter[0]++;
        return level.getChunk(cx, cz);
    }

    // ── one chunk's surface ───────────────────────────────────────────────────────────────────

    /** What a chunk's columns hold, whether loaded or decoded from its saved tag. */
    interface ChunkBlocks {
        /** The topmost non-air block's y ({@code WORLD_SURFACE} less one), below the build height when none. */
        int top(int x, int z);

        /** Whether the section at {@code sy} holds nothing but air (a skip, never required). */
        boolean airSection(int sy);

        BlockState state(int x, int y, int z);
    }

    /**
     * The surface of one chunk's columns inside the area, by {@code (x & 15) + 16 * (z & 15)}: the
     * top's y and state, and with a ceiling the lowest non-air block at or above it ({@code MIN_VALUE}
     * when none). {@code MISSING} or {@code LOAD} carry nothing.
     */
    public record ChunkSurface(WorldFill.Column.Kind kind, int @Nullable [] tops, BlockState @Nullable [] topStates, int @Nullable [] ceils,
            BlockState @Nullable [] ceilStates) {}

    /** The columns of chunk {@code (cx, cz)} inside {@code a}, as block x0, x1, z0, z1. */
    static int[] span(Area a, int cx, int cz) {
        return new int[] {Math.max(a.minX(), cx << 4), Math.min(a.maxX(), (cx << 4) + 15), Math.max(a.minZ(), cz << 4), Math.min(a.maxZ(), (cz << 4) + 15)};
    }

    /** Reads a chunk's surface inside the area (server thread for a loaded chunk, off-thread for a decoded one). */
    static ChunkSurface read(ChunkBlocks c, Area a, int cx, int cz, int minY, int maxY, @Nullable Integer ceiling) {
        int[] sp = span(a, cx, cz);
        int[] tops = new int[256], ceils = ceiling == null ? null : new int[256];
        BlockState[] topStates = new BlockState[256], ceilStates = ceiling == null ? null : new BlockState[256];
        for (int z = sp[2]; z <= sp[3]; z++)
            for (int x = sp[0]; x <= sp[1]; x++) {
                int i = (x & 15) + 16 * (z & 15);
                int top = c.top(x, z);
                tops[i] = top;
                if (top >= minY) topStates[i] = c.state(x, top, z);
                if (ceils != null) {
                    int y = firstNonAir(c, x, z, Math.max(minY, ceiling), Math.min(top, maxY));
                    ceils[i] = y;
                    if (y != Integer.MIN_VALUE) ceilStates[i] = c.state(x, y, z);
                }
            }
        return new ChunkSurface(WorldFill.Column.Kind.READ, tops, topStates, ceils, ceilStates);
    }

    /** The lowest y in {@code from..to} whose state isn't air, skipping all-air sections; MIN_VALUE when none. */
    static int firstNonAir(ChunkBlocks c, int x, int z, int from, int to) {
        int y = from;
        while (y <= to) {
            if (c.airSection(y >> 4)) {
                y = ((y >> 4) + 1) << 4;
                continue;
            }
            if (!c.state(x, y, z).isAir()) return y;
            y++;
        }
        return Integer.MIN_VALUE;
    }

    /** A loaded chunk's blocks. Server thread. */
    static ChunkBlocks loaded(LevelChunk c) {
        return new ChunkBlocks() {
            @Override
            public int top(int x, int z) {
                return c.getHeight(Heightmap.Types.WORLD_SURFACE, x & 15, z & 15);
            }

            @Override
            public boolean airSection(int sy) {
                return c.getSection(c.getSectionIndexFromSectionY(sy)).hasOnlyAir();
            }

            @Override
            public BlockState state(int x, int y, int z) {
                return c.getBlockState(new BlockPos(x, y, z));
            }
        };
    }

    /**
     * Reads a chunk's surface inside the area from its saved tag without loading it, off-thread
     * (18, piece 10; M5). The top comes from the saved {@code WORLD_SURFACE} heightmap, as the chunk's
     * load keeps it, or, when the tag has none that fits, from the topmost non-air block, as the load
     * primes it; only the sections holding the tops (and, with a ceiling, those between it and the
     * tops) are decoded ({@link WorldFill#decode}). {@code MISSING} when not fully generated,
     * {@code LOAD} when saved by another game version or undecodable.
     */
    public static ChunkSurface decodeSurface(Optional<CompoundTag> saved, Area a, int cx, int cz, int minY, int height, @Nullable Integer ceiling) {
        int minSection = minY >> 4, maxSection = (minY + height - 1 >> 4) + 1, maxY = minY + height - 1;
        int[] sp = span(a, cx, cz);
        int[] tops = saved.map(t -> savedTops(t, minY, height)).orElse(null);
        boolean[] need = new boolean[maxSection - minSection];
        if (tops == null) java.util.Arrays.fill(need, true);
        else
            for (int z = sp[2]; z <= sp[3]; z++)
                for (int x = sp[0]; x <= sp[1]; x++) {
                    int top = tops[(x & 15) + 16 * (z & 15)];
                    if (top >= minY && top <= maxY) need[(top >> 4) - minSection] = true;
                    if (ceiling != null)
                        for (int sy = Math.max(minY, ceiling) >> 4; sy <= Math.min(top, maxY) >> 4; sy++) need[sy - minSection] = true;
                }
        WorldFill.Column col = WorldFill.decode(saved, minSection, maxSection, sy -> need[sy - minSection]);
        if (col.kind() != WorldFill.Column.Kind.READ) return new ChunkSurface(col.kind(), null, null, null, null);
        PalettedContainer<BlockState>[] secs = col.sections();
        ChunkBlocks blocks = new ChunkBlocks() {
            @Override
            public int top(int x, int z) {
                if (tops != null) return tops[(x & 15) + 16 * (z & 15)];
                for (int y = maxY; y >= minY; y--) {
                    if (airSection(y >> 4)) {
                        y = (y >> 4) << 4;
                        continue;
                    }
                    if (!state(x, y, z).isAir()) return y;
                }
                return minY - 1;
            }

            @Override
            public boolean airSection(int sy) {
                return secs[sy - minSection] == null;
            }

            @Override
            public BlockState state(int x, int y, int z) {
                PalettedContainer<BlockState> s = y < minY || y > maxY ? null : secs[(y >> 4) - minSection];
                return s == null ? Blocks.AIR.defaultBlockState() : s.get(x & 15, y & 15, z & 15);
            }
        };
        return read(blocks, a, cx, cz, minY, maxY, ceiling);
    }

    /** The saved {@code WORLD_SURFACE} heightmap's tops by column, or null when the tag has none of the right size (the load then primes it). */
    static int @Nullable [] savedTops(CompoundTag tag, int minY, int height) {
        CompoundTag maps = tag.getCompound("Heightmaps");
        String key = Heightmap.Types.WORLD_SURFACE.getSerializationKey();
        if (!maps.contains(key, Tag.TAG_LONG_ARRAY)) return null;
        SimpleBitStorage bits;
        try {
            bits = new SimpleBitStorage(Mth.ceillog2(height + 1), 256, maps.getLongArray(key));
        } catch (SimpleBitStorage.InitializationException e) {
            return null;
        }
        int[] out = new int[256];
        for (int i = 0; i < 256; i++) out[i] = bits.get(i) + minY - 1;
        return out;
    }

    private final class Job {
        final ServerLevel level;
        final Messages.SurfaceRequest req;
        final Exchange ex;
        /** A select-grant read: unloaded chunks decoded from their saved tags off-thread, nothing loaded. */
        final boolean grant;
        final List<ChunkPos> chunks = new ArrayList<>();
        final List<Messages.ChunkXZ> missing = new ArrayList<>();
        final List<String> palette = new ArrayList<>();
        final Map<String, Integer> byName = new HashMap<>();
        final Map<BlockState, Integer> byState = new IdentityHashMap<>();
        final Long2ObjectOpenHashMap<CompletableFuture<ChunkSurface>> reading = new Long2ObjectOpenHashMap<>();
        final SurfaceLayer surface;
        final @Nullable SurfaceLayer ceilings;
        final int minY, maxY, height;
        final int[] loaded = {0};
        final long started = System.nanoTime();
        int next, aheadNext, ticks, live, disk;
        long serverNanos, maxTickNanos;

        Job(ServerLevel level, Messages.SurfaceRequest req, Exchange ex, boolean grant) {
            this.level = level;
            this.req = req;
            this.ex = ex;
            this.grant = grant;
            Area a = req.columns();
            for (int cz = a.minZ() >> 4; cz <= a.maxZ() >> 4; cz++)
                for (int cx = a.minX() >> 4; cx <= a.maxX() >> 4; cx++) chunks.add(new ChunkPos(cx, cz));
            int n = Math.toIntExact(a.columns());
            surface = SurfaceLayer.of(n);
            ceilings = req.ceiling() == null ? null : SurfaceLayer.of(n);
            minY = level.getMinBuildHeight();
            maxY = level.getMaxBuildHeight() - 1;
            height = level.getHeight();
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

        /** Reads chunks within the slice (at least one when {@code first}); true when all are read, false while a disk read is pending. Server thread. */
        boolean step(long deadline, boolean first) {
            prefetch();
            while (next < chunks.size() && (first || System.nanoTime() < deadline)) {
                ChunkPos cp = chunks.get(next);
                CompletableFuture<ChunkSurface> f = reading.get(cp.toLong());
                if (f == null) {
                    LevelChunk now = level.getChunkSource().getChunkNow(cp.x, cp.z);
                    if (now != null) live++;
                    else if (grant) {
                        f = fetch(cp.toLong());
                    }
                    if (f == null) {
                        LevelChunk c = now != null ? now : existing(level, cp.x, cp.z, loaded);
                        write(cp, c == null ? null : SurfaceReads.read(loaded(c), req.columns(), cp.x, cp.z, minY, maxY, req.ceiling()));
                        next++;
                        first = false;
                        continue;
                    }
                }
                if (!f.isDone()) {
                    prefetch();
                    return false;
                }
                reading.remove(cp.toLong());
                ChunkSurface s = f.join();
                switch (s.kind()) {
                    case READ -> {
                        disk++;
                        write(cp, s);
                    }
                    case MISSING -> write(cp, null);
                    case LOAD -> {
                        LevelChunk c = existing(level, cp.x, cp.z, loaded);
                        write(cp, c == null ? null : SurfaceReads.read(loaded(c), req.columns(), cp.x, cp.z, minY, maxY, req.ceiling()));
                    }
                }
                next++;
                first = false;
                prefetch();
            }
            return next >= chunks.size();
        }

        /** Starts disk reads of the unloaded chunks ahead of the cursor, up to {@link WorldReads#PREFETCH} in flight (select-grant reads only). */
        private void prefetch() {
            if (!grant) return;
            if (aheadNext < next) aheadNext = next;
            while (reading.size() < WorldReads.PREFETCH && aheadNext < chunks.size()) {
                ChunkPos cp = chunks.get(aheadNext++);
                if (reading.containsKey(cp.toLong()) || level.getChunkSource().getChunkNow(cp.x, cp.z) != null) continue;
                fetch(cp.toLong());
            }
        }

        /** Fetches a chunk's saved tag (asynchronous I/O) and reads its surface off-thread. */
        private CompletableFuture<ChunkSurface> fetch(long k) {
            int cx = ChunkPos.getX(k), cz = ChunkPos.getZ(k);
            Area a = req.columns();
            Integer ceiling = req.ceiling();
            CompletableFuture<ChunkSurface> f = level.getChunkSource().chunkMap.read(new ChunkPos(k))
                    .thenApplyAsync(tag -> decodeSurface(tag, a, cx, cz, minY, height, ceiling), background)
                    .exceptionally(e -> {
                        LOG.warn("Autosketch: reading chunk {},{} from disk for a surface snapshot failed; loading it instead", cx, cz, e);
                        return new ChunkSurface(WorldFill.Column.Kind.LOAD, null, null, null, null);
                    });
            reading.put(k, f);
            return f;
        }

        void cancel() {
            for (CompletableFuture<ChunkSurface> f : reading.values()) f.cancel(false);
            reading.clear();
        }

        /** Writes a chunk's columns into the layers; null: the chunk wasn't generated, listed in {@code missing}. */
        void write(ChunkPos cp, @Nullable ChunkSurface s) {
            if (s == null) {
                missing.add(new Messages.ChunkXZ(cp.x, cp.z));
                return;
            }
            Area a = req.columns();
            int[] sp = span(a, cp.x, cp.z);
            for (int z = sp[2]; z <= sp[3]; z++)
                for (int x = sp[0]; x <= sp[1]; x++) {
                    int i = (x - a.minX()) + a.sizeX() * (z - a.minZ()), c = (x & 15) + 16 * (z & 15);
                    int top = s.tops()[c];
                    if (top >= minY) {
                        surface.heights()[i] = top - minY + 1;
                        surface.states()[i] = index(s.topStates()[c]);
                    }
                    if (ceilings != null && s.ceils()[c] != Integer.MIN_VALUE) {
                        ceilings.heights()[i] = s.ceils()[c] - minY + 1;
                        ceilings.states()[i] = index(s.ceilStates()[c]);
                    }
                }
        }

        void finish() {
            try {
                Messages.SurfaceResult r = new Messages.SurfaceResult(req.id(), req.dimension(), req.columns(), minY, req.ceiling(), missing, palette, surface, ceilings);
                Frame f = r.encode();
                lastRead = new Stats(req.columns().columns(), chunks.size(), live, disk, loaded[0], missing.size(), ticks, serverNanos, maxTickNanos,
                        System.nanoTime() - started, f.body().length);
                ex.reply(f);
            } catch (RuntimeException e) {
                LOG.error("Autosketch: building a surface reply failed", e);
                ex.error(PatchApplier.INTERNAL, "the mod failed building the reply: " + e.getMessage());
            }
        }
    }
}
