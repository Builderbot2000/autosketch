package dev.autosketch.mod.world;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Exchange;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.ErrorCodes;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.SelectMessages;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import it.unimi.dsi.fastutil.longs.LongLinkedOpenHashSet;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.function.Function;
import java.util.function.IntFunction;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.PalettedContainer;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * {@code snapshot} kind {@code coarse} (13, *Message schemas*; 18, piece 5): each box grown to whole
 * cells of 2³ or 4³ on the world grid, each cell read as its most common non-air state
 * ({@link CoarseCells}; the game's three air blocks count as air). Served inside the select grant
 * without volumes, capped at {@code contextCap} <em>cells</em> (over it {@code too_large}), its
 * ungenerated chunks read as air and listed in {@code missing}; else inside the chunks the link
 * keeps loaded, as a blocks snapshot. Chunks are read as the search and the fill read them: a loaded
 * chunk on the server thread, one that isn't from its saved tag through the chunk storage's
 * asynchronous I/O, decoded and reduced off-thread ({@link #PREFETCH} ahead), another game version's
 * loaded the vanilla way; nothing is ticketed or generated. Only the cells are kept, never the
 * sections, so a read of millions of cells holds a reference per cell. The server thread spends at
 * most {@link #sliceNanos} per tick (at least one chunk), requests in arrival order; the body is
 * encoded off-thread.
 */
public final class CoarseReads {
    private static final Logger LOG = LogUtils.getLogger();

    /** Server-thread time one tick may spend on coarse reads. */
    public static volatile long sliceNanos = 5_000_000L;
    /** Unloaded chunks read and reduced ahead of the cursor. */
    public static final int PREFETCH = 64;

    private final WorldReads reads;
    private final Function<ResourceKey<Level>, @Nullable ServerLevel> levels;
    private final Executor background;
    private final Deque<Job> jobs = new ArrayDeque<>();

    public CoarseReads(WorldReads reads, Function<ResourceKey<Level>, @Nullable ServerLevel> levels, Executor background) {
        this.reads = reads;
        this.levels = levels;
        this.background = background;
    }

    /**
     * Cost of the last answered coarse read (Z1 reads these, 18 *Measure first*): cells, blocks read
     * (cells × cell³), chunks (read loaded, decoded from disk, loaded the vanilla way, missing), ticks,
     * server-thread and wall time, body bytes.
     */
    public record Stats(long cells, long blocks, int chunks, int loaded, int disk, int fallback, int missing, int ticks, long serverNanos, long wallNanos,
            int bytes) {}

    public static volatile @Nullable Stats lastCoarse;

    public boolean busy() {
        return !jobs.isEmpty();
    }

    public void coarse(SelectMessages.CoarseSnapshotRequest req, Exchange ex) throws ProtocolException {
        long id = req.id();
        int cell = req.cell();
        List<Box> regions = new ArrayList<>(req.boxes().size());
        long cells = 0;
        for (Box b : req.boxes()) {
            Box a = SelectMessages.align(b, cell);
            regions.add(a);
            cells += a.volume() / ((long) cell * cell * cell);
        }
        // Every cell takes at least one byte of body.
        if (cells > FrameCodec.MAX_FRAME) throw ProtocolException.refuse(ErrorCodes.TOO_LARGE, id, cells + " cells can't fit in one frame; ask for fewer or smaller boxes");
        ServerLevel level = selectGranted(id, req.dimension(), regions, cells);
        boolean select = level != null;
        if (level == null) level = reads.check(id, req.dimension(), regions);
        ex.defer();
        jobs.addLast(new Job(level, req, regions, cells, select, ex));
        tick();
    }

    /** The select grant's level when every region lies inside it; {@code too_large} there over {@code contextCap} cells. Else null. */
    private @Nullable ServerLevel selectGranted(long id, String dimension, List<Box> regions, long cells) throws ProtocolException {
        SelectGrants.Held h = SelectGrants.current();
        if (h == null || !h.grant().in(dimension)) return null;
        for (Box b : regions) if (!h.grant().hasBox(b)) return null;
        long cap = AutosketchConfig.get().volumes.contextCap;
        if (cells > cap) throw ProtocolException.refuse(ErrorCodes.TOO_LARGE, id, cells + " cells are over contextCap (" + cap + "); ask for less, or larger cells");
        ServerLevel level = levels.apply(h.grant().dimension());
        if (level == null) throw ProtocolException.refuse(PatchApplier.INTERNAL, id, "the dimension " + dimension + " isn't loaded");
        return level;
    }

    /** Runs the jobs in order within the slice budget. Server thread. */
    public void tick() {
        long deadline = System.nanoTime() + sliceNanos;
        boolean first = true;
        while (!jobs.isEmpty()) {
            Job j = jobs.peekFirst();
            long t0 = System.nanoTime();
            j.ticks++;
            boolean done;
            try {
                done = j.run(deadline, first);
            } catch (RuntimeException e) {
                jobs.pollFirst();
                j.cancel();
                LOG.error("Autosketch: the coarse read failed", e);
                j.ex.error(PatchApplier.INTERNAL, "the mod failed reading the world: " + e);
                continue;
            }
            first = false;
            j.serverNanos += System.nanoTime() - t0;
            if (!done) return;
            jobs.pollFirst();
            background.execute(j::finish);
        }
    }

    private static boolean air(BlockState s) {
        return s.isAir();
    }

    private final class Job {
        final ServerLevel level;
        final SelectMessages.CoarseSnapshotRequest req;
        final List<Box> regions;
        final long cells;
        final boolean select;
        final Exchange ex;
        final int cell, minSection, maxSection;
        /** Per region, the state of each cell (air until reduced). */
        final Object[][] out;
        /** The chunk columns the regions touch, ascending by cz, then cx, and the cursor. */
        final LongArrayList columns;
        int next, aheadNext;
        final Long2ObjectOpenHashMap<CompletableFuture<WorldFill.Column.Kind>> reading = new Long2ObjectOpenHashMap<>();
        final LongLinkedOpenHashSet missing = new LongLinkedOpenHashSet();
        int ticks, loaded, disk, fallback;
        long serverNanos;
        final long started = System.nanoTime();

        Job(ServerLevel level, SelectMessages.CoarseSnapshotRequest req, List<Box> regions, long cells, boolean select, Exchange ex) {
            this.level = level;
            this.req = req;
            this.regions = regions;
            this.cells = cells;
            this.select = select;
            this.ex = ex;
            this.cell = req.cell();
            this.minSection = level.getMinSection();
            this.maxSection = level.getMaxSection();
            BlockState airState = Blocks.AIR.defaultBlockState();
            out = new Object[regions.size()][];
            for (int i = 0; i < regions.size(); i++) {
                int[] g = CoarseCells.grid(regions.get(i), cell);
                out[i] = new Object[Math.toIntExact((long) g[0] * g[1] * g[2])];
                Arrays.fill(out[i], airState);
            }
            LongLinkedOpenHashSet seen = new LongLinkedOpenHashSet();
            for (Box b : regions)
                for (int cz = b.minZ() >> 4; cz <= b.maxZ() >> 4; cz++)
                    for (int cx = b.minX() >> 4; cx <= b.maxX() >> 4; cx++) seen.add(ChunkPos.asLong(cx, cz));
            columns = new LongArrayList(seen);
            columns.sort((a, c) -> ChunkPos.getZ(a) != ChunkPos.getZ(c) ? Integer.compare(ChunkPos.getZ(a), ChunkPos.getZ(c)) : Integer.compare(ChunkPos.getX(a), ChunkPos.getX(c)));
        }

        /** Takes chunks in order until all are reduced (true), or the slice ends or a read is pending (false). */
        boolean run(long deadline, boolean first) {
            prefetch();
            while (next < columns.size() && (first || System.nanoTime() < deadline)) {
                long k = columns.getLong(next);
                int cx = ChunkPos.getX(k), cz = ChunkPos.getZ(k);
                CompletableFuture<WorldFill.Column.Kind> f = reading.get(k);
                if (f == null) {
                    LevelChunk live = level.getChunkSource().getChunkNow(cx, cz);
                    if (live != null) {
                        reduce(cx, cz, sy -> live.getSection(live.getSectionIndexFromSectionY(sy)).getStates());
                        loaded++;
                        next++;
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
                switch (f.join()) {
                    case READ -> disk++;
                    case MISSING -> missing.add(k);
                    case LOAD -> {
                        LevelChunk l = SurfaceReads.existing(level, cx, cz, new int[1]);
                        if (l == null) missing.add(k);
                        else {
                            fallback++;
                            reduce(cx, cz, sy -> l.getSection(l.getSectionIndexFromSectionY(sy)).getStates());
                        }
                    }
                }
                next++;
                first = false;
                prefetch();
            }
            return next >= columns.size();
        }

        /** Starts disk reads of the unloaded chunks ahead of the cursor, up to {@link #PREFETCH} in flight. */
        void prefetch() {
            if (aheadNext < next) aheadNext = next;
            while (reading.size() < PREFETCH && aheadNext < columns.size()) {
                long k = columns.getLong(aheadNext++);
                if (reading.containsKey(k) || level.getChunkSource().getChunkNow(ChunkPos.getX(k), ChunkPos.getZ(k)) != null) continue;
                read(k);
            }
        }

        /** Reads a chunk's saved tag and, decoded, reduces its cells off-thread; the result says what it was. */
        CompletableFuture<WorldFill.Column.Kind> read(long k) {
            int cx = ChunkPos.getX(k), cz = ChunkPos.getZ(k);
            CompletableFuture<WorldFill.Column.Kind> f = level.getChunkSource().chunkMap.read(new ChunkPos(k))
                    .thenApplyAsync(tag -> {
                        WorldFill.Column c = WorldFill.decode(tag, minSection, maxSection);
                        if (c.kind() == WorldFill.Column.Kind.READ) {
                            PalettedContainer<BlockState>[] secs = c.sections();
                            reduce(cx, cz, sy -> secs[sy - minSection]);
                        }
                        return c.kind();
                    }, background)
                    .exceptionally(e -> {
                        LOG.warn("Autosketch: reading chunk {},{} from disk for a coarse read failed; loading it instead", cx, cz, e);
                        return WorldFill.Column.Kind.LOAD;
                    });
            reading.put(k, f);
            return f;
        }

        /** Reduces every region's cells in the chunk's sections within the build height; a null section is all air (already so). */
        void reduce(int cx, int cz, IntFunction<@Nullable PalettedContainer<BlockState>> section) {
            BlockState airState = Blocks.AIR.defaultBlockState();
            Box column = new Box(cx << 4, Integer.MIN_VALUE, cz << 4, (cx << 4) + 15, Integer.MAX_VALUE, (cz << 4) + 15);
            for (int i = 0; i < regions.size(); i++) {
                Box r = regions.get(i);
                if (!r.intersects(column)) continue;
                int s0 = Math.max(r.minY() >> 4, minSection), s1 = Math.min(r.maxY() >> 4, maxSection - 1);
                for (int sy = s0; sy <= s1; sy++) {
                    PalettedContainer<BlockState> states = section.apply(sy);
                    if (states == null) continue;
                    CoarseCells.reduce(r, cell, cx, sy, cz, (x, y, z) -> states.get(x & 15, y & 15, z & 15), CoarseReads::air, airState, out[i]);
                }
            }
        }

        void cancel() {
            for (CompletableFuture<WorldFill.Column.Kind> f : reading.values()) f.cancel(false);
            reading.clear();
        }

        /** Off-thread: the palette in cell order, the body, the reply. */
        void finish() {
            try {
                CoarseCells.Indexed ix = CoarseCells.index(out, o -> States.print((BlockState) o));
                List<SelectMessages.CoarseRegion> rs = new ArrayList<>(regions.size());
                for (int i = 0; i < regions.size(); i++) rs.add(new SelectMessages.CoarseRegion(regions.get(i), ix.states()[i]));
                List<Messages.ChunkXZ> miss = null;
                if (select && !missing.isEmpty()) {
                    miss = new ArrayList<>();
                    for (long k : missing) miss.add(new Messages.ChunkXZ(ChunkPos.getX(k), ChunkPos.getZ(k)));
                    miss.sort((a, b) -> a.cz() != b.cz() ? Integer.compare(a.cz(), b.cz()) : Integer.compare(a.cx(), b.cx()));
                }
                Frame f = new SelectMessages.CoarseResult(req.id(), req.dimension(), cell, ix.palette(), rs, miss).encode();
                try {
                    FrameCodec.encode(f);
                } catch (IllegalArgumentException e) {
                    ex.error(ErrorCodes.TOO_LARGE, e.getMessage() + "; ask for fewer or smaller boxes");
                    return;
                }
                lastCoarse = new Stats(cells, cells * cell * cell * cell, columns.size(), loaded, disk, fallback, missing.size(), ticks, serverNanos,
                        System.nanoTime() - started, f.body().length);
                ex.reply(f);
            } catch (RuntimeException e) {
                LOG.error("Autosketch: building a coarse reply failed", e);
                ex.error(PatchApplier.INTERNAL, "the mod failed building the reply: " + e.getMessage());
            }
        }
    }
}
