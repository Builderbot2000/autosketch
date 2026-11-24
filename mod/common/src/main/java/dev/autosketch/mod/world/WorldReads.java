package dev.autosketch.mod.world;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Exchange;
import dev.autosketch.mod.api.LinkState;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.protocol.BodyTypes.BlockEntityNbt;
import dev.autosketch.mod.protocol.BodyTypes.SnapshotRegion;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.ErrorCodes;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.SelectMessages;
import it.unimi.dsi.fastutil.longs.Long2ObjectLinkedOpenHashMap;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.function.Function;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.Tag;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.PalettedContainer;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * {@code snapshot} and {@code hashes} (13, *World → agent*; *Wire format*; M8). Reading happens on
 * the server thread in bounded slices: each tick copies as many chunk sections' state containers
 * (and the NBT of the block entities inside the requested boxes) as fit a time budget, at least one,
 * so a large volume never stalls a tick. Encoding and hashing then run off-thread on the copies, and
 * the reply goes out from there. Positions outside the build height read as air with no block
 * entity. A request waits for any earlier one (the dispatcher's order), so it sees every patch acked
 * before it.
 *
 * <p>A blocks (or mask) snapshot inside the select grant (18, piece 5; M4) is read by chunk column, as
 * the search, the fill and coarse reads read: a loaded chunk's sections copied on the server thread,
 * one that isn't from its saved tag through the chunk storage's asynchronous I/O (which also sees
 * chunks waiting to be written), decoded off-thread with its block entities ({@link #PREFETCH} ahead),
 * another game version's loaded the vanilla way so the data fixers upgrade it; nothing is loaded,
 * ticketed or generated, and an ungenerated chunk reads as air and is listed. Volume reads keep the
 * section loop, since the link keeps their chunks loaded.
 */
public final class WorldReads {
    private static final Logger LOG = LogUtils.getLogger();

    /** Server-thread time one tick may spend copying sections. */
    public static volatile long sliceNanos = 5_000_000L;
    /** Unloaded chunks a select-grant read fetches and decodes ahead of the cursor. */
    public static final int PREFETCH = 64;

    private final LinkState link;
    private final Function<ResourceKey<Level>, @Nullable ServerLevel> levels;
    private final Executor background;
    private final Deque<Job> jobs = new ArrayDeque<>();

    public WorldReads(LinkState link, Function<ResourceKey<Level>, @Nullable ServerLevel> levels, Executor background) {
        this.link = link;
        this.levels = levels;
        this.background = background;
    }

    /**
     * Cost of the last finished read: sections, ticks it was sliced over, server-thread and off-thread
     * (reply building) time, the longest single tick's server time (18, *Measured*), and for a
     * select-grant read its chunk columns (read loaded, decoded from disk, loaded the vanilla way,
     * missing; all 0 for a volume read) and the wall time from request to reply.
     */
    public record ReadStats(int sections, int ticks, long serverNanos, long offThreadNanos, long maxTickNanos, int chunks, int loaded, int disk, int fallback,
            int missing, long wallNanos) {}

    /** The last finished read's cost (measurements, 13 *Open questions*), or null. */
    public static volatile @Nullable ReadStats lastRead;

    /** Whether reads are in progress (for tests and status). */
    public boolean busy() {
        return !jobs.isEmpty();
    }

    // ── requests ──────────────────────────────────────────────────────────────────────────────

    public void hashes(Messages.HashesRequest req, Exchange ex, VolatileKeys keys) throws ProtocolException {
        ServerLevel level = check(req.id(), req.dimension(), req.boxes());
        List<long[]> sections = sectionsOf(req.boxes());
        start(new Job(level, req.boxes(), sections, ex) {
            @Override
            void finish() {
                List<Messages.SectionHash> out = new ArrayList<>(sections.size());
                Hashing.SectionHasher h = new Hashing.SectionHasher();
                for (long[] s : sections) {
                    Captured c = captured.get(key(s));
                    int sx = (int) s[0], sy = (int) s[1], sz = (int) s[2];
                    for (int y = sy << 4; y < (sy << 4) + 16; y++)
                        for (int z = sz << 4; z < (sz << 4) + 16; z++)
                            for (int x = sx << 4; x < (sx << 4) + 16; x++) {
                                if (!inAny(boxes, x, y, z)) continue;
                                CompoundTag nbt = c.bes.get(BlockPos.asLong(x, y, z));
                                h.add(States.print(c.state(x, y, z)), nbt == null ? null : Hashing.nbtHash(nbt, keys));
                            }
                    if (h.any()) out.add(new Messages.SectionHash(sx, sy, sz, h.finish()));
                    else h.reset();
                }
                send(new Messages.HashesResult(req.id(), out).encode());
            }
        });
    }

    /**
     * {@code snapshot} kind {@code mask} (13, *Message schemas*; 18, piece 5): a blocks snapshot of the
     * sections plus the margin around them, its regions laid out by {@link SelectMessages#maskRegions},
     * served as any blocks snapshot is (inside the select grant up to {@code contextCap} positions,
     * else inside the volumes).
     */
    public void mask(SelectMessages.MaskSnapshotRequest req, Exchange ex) throws ProtocolException {
        snapshot(new Messages.SnapshotRequest(req.id(), req.dimension(), req.regions(), null), ex);
    }

    public void snapshot(Messages.SnapshotRequest req, Exchange ex) throws ProtocolException {
        List<Box> regions = req.regions();
        long total = 0;
        for (Box b : regions) total += b.volume();
        // Every position takes at least one byte of body.
        if (total > FrameCodec.MAX_FRAME) throw ProtocolException.refuse(ErrorCodes.TOO_LARGE, req.id(), total + " positions can't fit in one frame; ask for fewer boxes or sections");
        ServerLevel select = selectGranted(req.id(), req.dimension(), regions, total);
        ServerLevel level = select != null ? select : check(req.id(), req.dimension(), regions);
        start(new Job(level, regions, sectionsOf(regions), ex, select != null, select != null) {
            @Override
            void finish() {
                List<String> palette = new ArrayList<>();
                Map<String, Integer> byName = new HashMap<>();
                Map<BlockState, Integer> byState = new IdentityHashMap<>();
                List<SnapshotRegion> out = new ArrayList<>(regions.size());
                for (Box r : regions) {
                    int[] states = new int[Math.toIntExact(r.volume())];
                    List<BlockEntityNbt> bes = new ArrayList<>();
                    int i = 0;
                    SKey lastKey = null;
                    Captured c = null;
                    for (int y = r.minY(); y <= r.maxY(); y++)
                        for (int z = r.minZ(); z <= r.maxZ(); z++)
                            for (int x = r.minX(); x <= r.maxX(); x++) {
                                SKey k = new SKey(x >> 4, y >> 4, z >> 4);
                                if (!k.equals(lastKey)) {
                                    c = captured.get(k);
                                    lastKey = k;
                                }
                                BlockState st = c.state(x, y, z);
                                Integer p = byState.get(st);
                                if (p == null) {
                                    String name = States.print(st);
                                    p = byName.get(name);
                                    if (p == null) {
                                        p = palette.size();
                                        palette.add(name);
                                        byName.put(name, p);
                                    }
                                    byState.put(st, p);
                                }
                                states[i++] = p;
                            }
                    for (long[] s : sections)
                        for (Map.Entry<Long, CompoundTag> e : captured.get(key(s)).bes.entrySet()) {
                            BlockPos bp = BlockPos.of(e.getKey());
                            if (r.contains(bp)) bes.add(new BlockEntityNbt(bp, e.getValue()));
                        }
                    out.add(new SnapshotRegion(r, states, bes));
                }
                send(new Messages.SnapshotResult(req.id(), req.dimension(), palette, out, missingList()).encode());
            }
        });
    }

    /**
     * Select (18; 13, *Where the mod serves reads*): the select grant's level when every box lies
     * inside the grant's square in its dimension, so the snapshot is served without volumes, never
     * generating a chunk and listing the ungenerated ones; {@code too_large} there over
     * {@code contextCap} positions. Else null.
     */
    private @Nullable ServerLevel selectGranted(long id, String dimension, List<Box> boxes, long positions) throws ProtocolException {
        SelectGrants.Held h = SelectGrants.current();
        if (h == null || !h.grant().in(dimension)) return null;
        for (Box b : boxes) if (!h.grant().hasBox(b)) return null;
        long cap = dev.autosketch.mod.AutosketchConfig.get().volumes.contextCap;
        if (positions > cap) throw ProtocolException.refuse(ErrorCodes.TOO_LARGE, id, positions + " positions are over contextCap (" + cap + "); ask for less, or a coarse snapshot");
        return levels.apply(h.grant().dimension());
    }

    /** {@code no_volumes}, {@code wrong_dimension}, {@code outside_volumes} (chunk columns the link keeps loaded). */
    ServerLevel check(long id, String dimension, List<Box> boxes) throws ProtocolException {
        LinkVolumes v = link.current();
        if (v == null) throw ProtocolException.refuse(ErrorCodes.NO_VOLUMES, id, "no work volume is set");
        if (!v.dimension().location().toString().equals(dimension))
            throw ProtocolException.refuse(ErrorCodes.WRONG_DIMENSION, id, "the volumes are in " + v.dimension().location() + ", not " + dimension);
        Set<SKey> columns = new HashSet<>();
        List<Box> kept = new ArrayList<>(v.context());
        kept.add(v.work());
        if (v.extended() != null) kept.add(v.extended());
        for (Box b : kept)
            for (int cx = b.minX() >> 4; cx <= b.maxX() >> 4; cx++)
                for (int cz = b.minZ() >> 4; cz <= b.maxZ() >> 4; cz++) columns.add(key(cx, 0, cz));
        for (Box b : boxes)
            for (int cx = b.minX() >> 4; cx <= b.maxX() >> 4; cx++)
                for (int cz = b.minZ() >> 4; cz <= b.maxZ() >> 4; cz++)
                    if (!columns.contains(key(cx, 0, cz))) throw ProtocolException.refuse(ErrorCodes.OUTSIDE_VOLUMES, id, "box " + b + " reaches chunk " + cx + "," + cz + " outside the volumes");
        ServerLevel level = levels.apply(v.dimension());
        if (level == null) throw ProtocolException.refuse(PatchApplier.INTERNAL, id, "the dimension " + dimension + " isn't loaded");
        return level;
    }

    // ── slicing ───────────────────────────────────────────────────────────────────────────────

    private void start(Job job) {
        job.background = background;
        job.exchange.defer();
        jobs.addLast(job);
        tick();
    }

    /** Copies sections for the jobs in order, within the slice budget. Server thread. */
    public void tick() {
        long deadline = System.nanoTime() + sliceNanos;
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
                LOG.error("Autosketch: reading the world failed", e);
                j.exchange.error(PatchApplier.INTERNAL, "the mod failed reading the world: " + e);
                continue;
            }
            first = false;
            long spent = System.nanoTime() - t0;
            j.serverNanos += spent;
            j.maxTickNanos = Math.max(j.maxTickNanos, spent);
            if (!done) return;
            jobs.pollFirst();
            background.execute(j::finishSafely);
        }
    }

    /** One section's states (a copy) and the NBT of its block entities inside the boxes; the chunk loaded (or generated) as needed. */
    static Captured capture(ServerLevel level, int sx, int sy, int sz, List<Box> boxes) {
        if (sy < level.getMinSection() || sy >= level.getMaxSection()) return new Captured(null, Map.of());
        return capture(level, level.getChunk(sx, sz), sy, boxes);
    }

    /** One section of a chunk in memory (within the build height): its states copied, its block entities inside the boxes. */
    static Captured capture(ServerLevel level, LevelChunk chunk, int sy, List<Box> boxes) {
        PalettedContainer<BlockState> states = chunk.getSection(chunk.getSectionIndexFromSectionY(sy)).getStates().copy();
        Map<Long, CompoundTag> bes = new HashMap<>();
        for (BlockEntity be : chunk.getBlockEntities().values()) {
            BlockPos p = be.getBlockPos();
            if (p.getY() >> 4 != sy || be.isRemoved() || !inAny(boxes, p.getX(), p.getY(), p.getZ())) continue;
            bes.put(p.asLong(), WorldBlocks.nbt(be, level.registryAccess()));
        }
        return new Captured(states, bes);
    }

    /** A chunk column decoded from its saved tag: what it was, and when {@code READ} its wanted sections. */
    record ColumnRead(WorldFill.Column.Kind kind, @Nullable Map<SKey, Captured> sections) {}

    /**
     * Decodes the wanted sections of a saved chunk without loading it, off-thread: each section's
     * states (null when all air) and the block entities inside the boxes, as the chunk's load would
     * keep them (the position's state takes a block entity, not kept packed), their saved NBT without
     * {@code x}, {@code y}, {@code z} and the chunk's {@code keepPacked}, as {@link WorldBlocks#nbt}
     * prints a loaded one. {@code MISSING}
     * when not fully generated, {@code LOAD} when saved by another game version or undecodable.
     */
    static ColumnRead decodeColumn(Optional<CompoundTag> saved, List<long[]> wanted, List<Box> boxes, int minSection, int maxSection) {
        Set<Integer> ys = new HashSet<>();
        for (long[] s : wanted) ys.add((int) s[1]);
        WorldFill.Column c = WorldFill.decode(saved, minSection, maxSection, ys::contains);
        if (c.kind() != WorldFill.Column.Kind.READ) return new ColumnRead(c.kind(), null);
        PalettedContainer<BlockState>[] secs = c.sections();
        Map<SKey, Map<Long, CompoundTag>> bes = new HashMap<>();
        ListTag list = saved.get().getList("block_entities", Tag.TAG_COMPOUND);
        for (int i = 0; i < list.size(); i++) {
            CompoundTag t = list.getCompound(i);
            int x = t.getInt("x"), y = t.getInt("y"), z = t.getInt("z"), sy = y >> 4;
            if (t.getBoolean("keepPacked") || sy < minSection || sy >= maxSection || !ys.contains(sy) || !inAny(boxes, x, y, z)) continue;
            PalettedContainer<BlockState> st = secs[sy - minSection];
            if (st == null || !st.get(x & 15, y & 15, z & 15).hasBlockEntity()) continue;
            CompoundTag nbt = t.copy();
            nbt.remove("x");
            nbt.remove("y");
            nbt.remove("z");
            nbt.remove("keepPacked"); // the chunk's save adds it, the block entity's doesn't
            bes.computeIfAbsent(key(x >> 4, sy, z >> 4), k -> new HashMap<>()).put(BlockPos.asLong(x, y, z), nbt);
        }
        Map<SKey, Captured> out = new HashMap<>();
        for (long[] s : wanted) {
            SKey k = key(s);
            Map<Long, CompoundTag> b = bes.get(k);
            out.put(k, new Captured(secs[(int) s[1] - minSection], b == null ? Map.of() : b));
        }
        return new ColumnRead(WorldFill.Column.Kind.READ, out);
    }

    /** {@code ungenerated}: the chunk was never fully generated (a no-generate read), so it reads as air. */
    record Captured(@Nullable PalettedContainer<BlockState> states, Map<Long, CompoundTag> bes, boolean ungenerated) {
        Captured(@Nullable PalettedContainer<BlockState> states, Map<Long, CompoundTag> bes) {
            this(states, bes, false);
        }

        BlockState state(int x, int y, int z) {
            return states == null ? Blocks.AIR.defaultBlockState() : states.get(x & 15, y & 15, z & 15);
        }
    }

    private abstract static class Job {
        final ServerLevel level;
        final List<Box> boxes;
        final List<long[]> sections;
        final Exchange exchange;
        /** A select-grant read (18): read by chunk column, nothing loaded, ticketed or generated. */
        final boolean noGenerate;
        /** A select-grant read (18): ungenerated chunks are listed in the answer. */
        final boolean listMissing;
        /** Chunk columns (sy 0) found ungenerated, read as air without asking again. */
        final Set<SKey> missing = new HashSet<>();
        final Map<SKey, Captured> captured = new LinkedHashMap<>();
        int next, ticks;
        long serverNanos, maxTickNanos, offThreadStart;
        final long started = System.nanoTime();
        /** Where disk reads are decoded (set by {@link #start}). */
        @Nullable Executor background;
        /**
         * A select-grant read's chunk columns within the build height, ascending by cz, then cx, with
         * their wanted sections; the cursor, the prefetch cursor and the disk reads in flight. Null for
         * a volume read.
         */
        final @Nullable LongArrayList columns;
        final Long2ObjectLinkedOpenHashMap<List<long[]>> wanted = new Long2ObjectLinkedOpenHashMap<>();
        final Long2ObjectOpenHashMap<CompletableFuture<ColumnRead>> reading = new Long2ObjectOpenHashMap<>();
        int nextColumn, aheadNext, loaded, disk, fallback;

        Job(ServerLevel level, List<Box> boxes, List<long[]> sections, Exchange exchange) {
            this(level, boxes, sections, exchange, false);
        }

        Job(ServerLevel level, List<Box> boxes, List<long[]> sections, Exchange exchange, boolean noGenerate) {
            this(level, boxes, sections, exchange, noGenerate, false);
        }

        Job(ServerLevel level, List<Box> boxes, List<long[]> sections, Exchange exchange, boolean noGenerate, boolean listMissing) {
            this.listMissing = listMissing;
            this.level = level;
            this.boxes = boxes;
            this.sections = sections;
            this.exchange = exchange;
            this.noGenerate = noGenerate;
            if (!noGenerate) {
                columns = null;
                return;
            }
            int minSection = level.getMinSection(), maxSection = level.getMaxSection();
            for (long[] s : sections) {
                if (s[1] < minSection || s[1] >= maxSection) captured.put(key(s), new Captured(null, Map.of()));
                else wanted.computeIfAbsent(ChunkPos.asLong((int) s[0], (int) s[2]), k -> new ArrayList<>()).add(s);
            }
            columns = new LongArrayList(wanted.keySet());
            columns.sort((a, c) -> ChunkPos.getZ(a) != ChunkPos.getZ(c) ? Integer.compare(ChunkPos.getZ(a), ChunkPos.getZ(c)) : Integer.compare(ChunkPos.getX(a), ChunkPos.getX(c)));
        }

        /** Reads within the slice (at least one section or column when {@code first}); true when everything is read. Server thread. */
        boolean step(long deadline, boolean first) {
            if (columns != null) return stepColumns(deadline, first);
            while (next < sections.size() && (first || System.nanoTime() < deadline)) {
                long[] s = sections.get(next++);
                captured.put(key(s), capture(level, (int) s[0], (int) s[1], (int) s[2], boxes));
                first = false;
            }
            return next >= sections.size();
        }

        /** A select-grant read: whole columns in order, loaded ones from memory, the others from their decoded saved tags; false while a read is pending. */
        private boolean stepColumns(long deadline, boolean first) {
            LongArrayList cols = columns;
            prefetch();
            while (nextColumn < cols.size() && (first || System.nanoTime() < deadline)) {
                long k = cols.getLong(nextColumn);
                int cx = ChunkPos.getX(k), cz = ChunkPos.getZ(k);
                CompletableFuture<ColumnRead> f = reading.get(k);
                if (f == null) {
                    LevelChunk live = level.getChunkSource().getChunkNow(cx, cz);
                    if (live != null) {
                        for (long[] s : wanted.get(k)) captured.put(key(s), capture(level, live, (int) s[1], boxes));
                        loaded++;
                        nextColumn++;
                        first = false;
                        continue;
                    }
                    f = read(k);
                }
                if (!f.isDone()) {
                    prefetch();
                    return false;
                }
                reading.remove(k);
                ColumnRead r = f.join();
                switch (r.kind()) {
                    case READ -> {
                        disk++;
                        captured.putAll(r.sections());
                    }
                    case MISSING -> missingColumn(k);
                    case LOAD -> {
                        LevelChunk l = SurfaceReads.existing(level, cx, cz, new int[1]);
                        if (l == null) missingColumn(k);
                        else {
                            fallback++;
                            for (long[] s : wanted.get(k)) captured.put(key(s), capture(level, l, (int) s[1], boxes));
                        }
                    }
                }
                nextColumn++;
                first = false;
                prefetch();
            }
            return nextColumn >= cols.size();
        }

        private void missingColumn(long k) {
            missing.add(key(ChunkPos.getX(k), 0, ChunkPos.getZ(k)));
            for (long[] s : wanted.get(k)) captured.put(key(s), new Captured(null, Map.of(), true));
        }

        /** Starts disk reads of the unloaded columns ahead of the cursor, up to {@link #PREFETCH} in flight. */
        private void prefetch() {
            LongArrayList cols = columns;
            if (aheadNext < nextColumn) aheadNext = nextColumn;
            while (reading.size() < PREFETCH && aheadNext < cols.size()) {
                long k = cols.getLong(aheadNext++);
                if (reading.containsKey(k) || level.getChunkSource().getChunkNow(ChunkPos.getX(k), ChunkPos.getZ(k)) != null) continue;
                read(k);
            }
        }

        /** Fetches a column's saved tag (asynchronous I/O) and decodes its wanted sections off-thread. */
        private CompletableFuture<ColumnRead> read(long k) {
            int cx = ChunkPos.getX(k), cz = ChunkPos.getZ(k);
            List<long[]> secs = wanted.get(k);
            int minSection = level.getMinSection(), maxSection = level.getMaxSection();
            CompletableFuture<ColumnRead> f = level.getChunkSource().chunkMap.read(new ChunkPos(k))
                    .thenApplyAsync(tag -> decodeColumn(tag, secs, boxes, minSection, maxSection), background)
                    .exceptionally(e -> {
                        LOG.warn("Autosketch: reading chunk {},{} from disk for a snapshot failed; loading it instead", cx, cz, e);
                        return new ColumnRead(WorldFill.Column.Kind.LOAD, null);
                    });
            reading.put(k, f);
            return f;
        }

        void cancel() {
            for (CompletableFuture<ColumnRead> f : reading.values()) f.cancel(false);
            reading.clear();
        }

        /** The ungenerated chunks, ascending by cz, then cx, for a select-grant read; else null. */
        @Nullable List<Messages.ChunkXZ> missingList() {
            if (!listMissing || missing.isEmpty()) return null;
            List<Messages.ChunkXZ> out = new ArrayList<>();
            for (SKey k : missing) out.add(new Messages.ChunkXZ(k.x(), k.z()));
            out.sort((a, b) -> a.cz() != b.cz() ? Integer.compare(a.cz(), b.cz()) : Integer.compare(a.cx(), b.cx()));
            return out;
        }

        /** Off-thread: build and send the reply from the copies. */
        abstract void finish();

        void send(Frame f) {
            long now = System.nanoTime();
            lastRead = new ReadStats(sections.size(), ticks, serverNanos, now - offThreadStart, maxTickNanos, columns == null ? 0 : columns.size(), loaded, disk, fallback,
                    missing.size(), now - started);
            try {
                FrameCodec.encode(f);
            } catch (IllegalArgumentException e) {
                exchange.error(ErrorCodes.TOO_LARGE, e.getMessage() + "; ask for fewer boxes or sections");
                return;
            }
            exchange.reply(f);
        }

        void finishSafely() {
            try {
                offThreadStart = System.nanoTime();
                finish();
            } catch (RuntimeException e) {
                // A world block entity the wire can't carry (a string over the limit, nesting) or a bug.
                LOG.error("Autosketch: building a {} reply failed", exchange.id(), e);
                exchange.error(PatchApplier.INTERNAL, "the mod failed building the reply: " + e.getMessage());
            }
        }
    }

    // ── geometry ──────────────────────────────────────────────────────────────────────────────

    static boolean inAny(List<Box> boxes, int x, int y, int z) {
        for (Box b : boxes) if (b.contains(x, y, z)) return true;
        return false;
    }

    /** Every section a box touches, ascending by y, then z, then x, each once. */
    static List<long[]> sectionsOf(List<Box> boxes) {
        Set<SKey> seen = new HashSet<>();
        List<long[]> out = new ArrayList<>();
        for (Box b : boxes)
            for (int sy = b.minY() >> 4; sy <= b.maxY() >> 4; sy++)
                for (int sz = b.minZ() >> 4; sz <= b.maxZ() >> 4; sz++)
                    for (int sx = b.minX() >> 4; sx <= b.maxX() >> 4; sx++)
                        if (seen.add(key(sx, sy, sz))) out.add(new long[] {sx, sy, sz});
        out.sort((a, c) -> a[1] != c[1] ? Long.compare(a[1], c[1]) : a[2] != c[2] ? Long.compare(a[2], c[2]) : Long.compare(a[0], c[0]));
        return out;
    }

    /** A section (or, with sy 0, a chunk column), exact for any int coordinates. */
    record SKey(int x, int y, int z) {}

    static SKey key(int sx, int sy, int sz) {
        return new SKey(sx, sy, sz);
    }

    static SKey key(long[] s) {
        return key((int) s[0], (int) s[1], (int) s[2]);
    }
}
