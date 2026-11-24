package dev.autosketch.mod.world;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Exchange;
import dev.autosketch.mod.protocol.ErrorCodes;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.SelectMessages;
import it.unimi.dsi.fastutil.longs.Long2ByteOpenHashMap;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executor;
import java.util.function.Function;
import java.util.function.Predicate;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtOps;
import net.minecraft.nbt.Tag;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.PalettedContainer;
import net.minecraft.world.level.chunk.status.ChunkType;
import net.minecraft.world.level.chunk.storage.ChunkSerializer;
import net.minecraft.world.level.chunk.storage.ChunkStorage;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * {@code fill} and {@code expand} (18, pieces 3 and 4; 13, *Message schemas*, *Select*): the select
 * candidate's shape grown in the world. The walk itself is {@link FillWalk} (the fake host's
 * algorithm, {@code {connected}}'s); this class serves the requests, reads the chunks and slices the
 * work over ticks.
 *
 * <p>Chunks are read as the material search reads them ({@link MaterialSearch}): a loaded chunk on the
 * server thread, one that isn't loaded from its saved tag through the chunk storage's asynchronous I/O,
 * decoded off-thread, never loading, ticketing or generating it; one saved by another game version is
 * loaded the vanilla way ({@link SurfaceReads#existing}) so the data fixers upgrade it. The walk pauses
 * (until a later tick) when it needs a chunk whose read hasn't finished, the read area's chunks are
 * fetched ahead of it, nearest the seed first, and the server thread spends at most {@link #sliceNanos}
 * per tick. Requests are served in arrival order. The fill lives with the select grant
 * ({@link SelectGrants.Held#fill}): a new fill replaces it, an {@code expand} grows and resumes it.
 */
public final class WorldFill {
    private static final Logger LOG = LogUtils.getLogger();

    /** Server-thread time one tick may spend on fills. */
    public static volatile long sliceNanos = 5_000_000L;
    /** Chunk reads in flight ahead of the walk. */
    public static final int PREFETCH = 64;
    /** Decoded unloaded chunks kept per request (about 50 KB each). */
    static final int CACHE = 512;

    private final Function<ResourceKey<Level>, @Nullable ServerLevel> levels;
    private final Executor background;
    private final Deque<Job> jobs = new ArrayDeque<>();

    public WorldFill(Function<ResourceKey<Level>, @Nullable ServerLevel> levels, Executor background) {
        this.levels = levels;
        this.background = background;
    }

    /**
     * Cost of the last answered request (Z1 reads these, 18 *Measure first*): blocks added and the
     * whole shape's count and sections, frontier positions, chunks met (read loaded, decoded from disk,
     * loaded the vanilla way, missing), ticks, server-thread and wall time, body bytes.
     */
    public record Stats(long added, long count, int sections, int frontier, int loaded, int disk, int fallback, int missing, int ticks, long serverNanos,
            long wallNanos, int bytes) {}

    public static volatile @Nullable Stats lastFill;

    public boolean busy() {
        return !jobs.isEmpty();
    }

    /** A fill the select grant holds: its walk, what it matches, and each chunk's generation as found. */
    public static final class State {
        final FillWalk walk;
        final Predicate<BlockState> match;
        final ResourceKey<Level> dimension;
        /** Chunk → {@link FillWalk#READY} or {@link FillWalk#MISSING}; absent while unknown. */
        final Long2ByteOpenHashMap status = new Long2ByteOpenHashMap();

        State(FillWalk walk, Predicate<BlockState> match, ResourceKey<Level> dimension) {
            this.walk = walk;
            this.match = match;
            this.dimension = dimension;
            status.defaultReturnValue((byte) -2);
        }

        public FillWalk walk() {
            return walk;
        }
    }

    // ── requests ──────────────────────────────────────────────────────────────────────────────

    /** {@code no_grant}, {@code wrong_dimension}; the grant's level. */
    private ServerLevel granted(long id, String dimension, SelectGrants.@Nullable Held held) throws ProtocolException {
        if (held == null) throw ProtocolException.refuse(ErrorCodes.NO_GRANT, id, "no select request is open: the player sends /autosketch select first");
        SelectGrants.Grant g = held.grant();
        if (!g.in(dimension)) throw ProtocolException.refuse(ErrorCodes.WRONG_DIMENSION, id, "the select request is in " + g.dimension().location() + ", not " + dimension);
        ServerLevel level = levels.apply(g.dimension());
        if (level == null) throw ProtocolException.refuse(PatchApplier.INTERNAL, id, "the dimension " + dimension + " isn't loaded");
        return level;
    }

    /** {@code fill}: replaces the grant's fill. Also {@code outside_volumes} for a seed outside the grant. */
    public void fill(SelectMessages.FillRequest req, Exchange ex) throws ProtocolException {
        long id = req.id();
        SelectGrants.Held held = SelectGrants.current();
        ServerLevel level = granted(id, req.dimension(), held);
        SelectGrants.Grant g = held.grant();
        BlockPos seed = req.seed();
        if (!g.hasChunk(seed.getX() >> 4, seed.getZ() >> 4)) throw ProtocolException.refuse(ErrorCodes.OUTSIDE_VOLUMES, id, "the seed " + seed.toShortString() + " lies outside the select grant");
        int connectivity = req.connectivity() != null ? req.connectivity() : SelectMessages.FILL_CONNECTIVITY;
        int area = req.area() != null ? req.area() : SelectMessages.FILL_AREA;
        FillWalk walk = new FillWalk(seed, connectivity, area, k -> g.hasChunk(ChunkPos.getX(k), ChunkPos.getZ(k)), level.getMinBuildHeight(), level.getMaxBuildHeight() - 1);
        State state = new State(walk, matcher(req.match()), g.dimension());
        held.fill(state);
        start(new Job(level, state, null, budget(req.budget()), req.id(), req.dimension(), ex));
    }

    /** {@code expand}: grows the grant's fill's read area and resumes it; {@code bad_request} without one. */
    public void expand(SelectMessages.ExpandRequest req, Exchange ex) throws ProtocolException {
        long id = req.id();
        SelectGrants.Held held = SelectGrants.current();
        ServerLevel level = granted(id, req.dimension(), held);
        State state = held.fill();
        if (state == null) throw ProtocolException.badRequest(id, "no fill to expand: send a fill first");
        start(new Job(level, state, req.by(), budget(req.budget()), req.id(), req.dimension(), ex));
    }

    private static long budget(@Nullable Long asked) {
        return asked != null ? asked : AutosketchConfig.get().volumes.contextCap;
    }

    private void start(Job j) {
        j.ex.defer();
        jobs.addLast(j);
        tick();
    }

    /**
     * A match list's test (13, *Select*, "Materials"): ids, canonical states and {@code #tags} as the
     * material search reads them, and {@code solid} for every block that isn't air (the game's air
     * blocks: air, cave air, void air).
     */
    static Predicate<BlockState> matcher(List<String> match) {
        List<String> rest = new ArrayList<>(match);
        boolean solid = rest.remove(SelectMessages.MATCH_SOLID);
        MaterialSearch.Matcher m = MaterialSearch.Matcher.of(rest);
        return st -> (solid && !st.isAir()) || m.which(st) >= 0;
    }

    // ── slicing ───────────────────────────────────────────────────────────────────────────────

    /** Runs the jobs in order within the slice budget. Server thread. */
    public void tick() {
        long deadline = System.nanoTime() + sliceNanos;
        while (!jobs.isEmpty()) {
            Job j = jobs.peekFirst();
            long t0 = System.nanoTime();
            j.ticks++;
            boolean done;
            try {
                done = j.run(deadline);
            } catch (RuntimeException e) {
                jobs.pollFirst();
                j.cancel();
                LOG.error("Autosketch: the fill failed", e);
                j.ex.error(PatchApplier.INTERNAL, "the mod failed filling: " + e);
                continue;
            }
            j.serverNanos += System.nanoTime() - t0;
            if (!done) return;
            jobs.pollFirst();
            j.finish();
        }
    }

    // ── chunk reads ───────────────────────────────────────────────────────────────────────────

    /** An unloaded chunk read from its saved tag: its sections' states by index, or why it can't be. */
    record Column(Kind kind, @Nullable PalettedContainer<BlockState> @Nullable [] sections) {
        enum Kind { READ, MISSING, LOAD }
    }

    /**
     * Decodes a saved chunk without loading it. Off-thread. {@code MISSING} when it isn't fully
     * generated, {@code LOAD} when it was saved by another game version (or doesn't decode).
     */
    @SuppressWarnings("unchecked")
    static Column decode(Optional<CompoundTag> saved, int minSection, int maxSection) {
        if (saved.isEmpty()) return new Column(Column.Kind.MISSING, null);
        CompoundTag tag = saved.get();
        if (ChunkSerializer.getChunkTypeFromTag(tag) != ChunkType.LEVELCHUNK) return new Column(Column.Kind.MISSING, null);
        if (ChunkStorage.getVersion(tag) != SharedConstants.getCurrentVersion().getDataVersion().getVersion()) return new Column(Column.Kind.LOAD, null);
        PalettedContainer<BlockState>[] out = new PalettedContainer[maxSection - minSection];
        ListTag list = tag.getList(ChunkSerializer.SECTIONS_TAG, Tag.TAG_COMPOUND);
        for (int i = 0; i < list.size(); i++) {
            CompoundTag s = list.getCompound(i);
            int sy = s.getByte("Y");
            if (sy < minSection || sy >= maxSection || !s.contains("block_states", Tag.TAG_COMPOUND)) continue; // absent: all air
            Optional<PalettedContainer<BlockState>> states = MaterialSearch.STATES.parse(NbtOps.INSTANCE, s.getCompound("block_states")).result();
            if (states.isEmpty()) return new Column(Column.Kind.LOAD, null);
            out[sy - minSection] = states.get();
        }
        return new Column(Column.Kind.READ, out);
    }

    private final class Job implements FillWalk.Blocks {
        final ServerLevel level;
        final State state;
        final FillWalk walk;
        final SelectMessages.@Nullable ExpandBy by;
        final long budget, id;
        final String dimension;
        final Exchange ex;
        final int minSection, maxSection;
        final long started = System.nanoTime();
        final Long2ObjectOpenHashMap<CompletableFuture<Column>> reading = new Long2ObjectOpenHashMap<>();
        /** Decoded unloaded chunks, least recently used first. */
        final Map<Long, Column> cache = new LinkedHashMap<>(16, 0.75f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<Long, Column> e) {
                return size() > CACHE;
            }
        };
        /** The area's chunks of unknown generation, nearest the seed first, and the next to fetch. */
        @Nullable LongArrayList ahead;
        int aheadNext;
        boolean begun;
        int ticks, disk, fallback, missing;
        /** Loaded chunks the walk read. */
        final LongOpenHashSet liveSeen = new LongOpenHashSet();
        long serverNanos;
        // The last live chunk asked, within one tick.
        long liveKey = Long.MIN_VALUE;
        @Nullable LevelChunk live;

        Job(ServerLevel level, State state, SelectMessages.@Nullable ExpandBy by, long budget, long id, String dimension, Exchange ex) {
            this.level = level;
            this.state = state;
            this.walk = state.walk;
            this.by = by;
            this.budget = budget;
            this.id = id;
            this.dimension = dimension;
            this.ex = ex;
            this.minSection = level.getMinSection();
            this.maxSection = level.getMaxSection();
        }

        /** Runs on until the answer can be built (true), or the slice ends or a read is pending (false). */
        boolean run(long deadline) {
            liveKey = Long.MIN_VALUE;
            live = null;
            if (!begun) {
                // An expand acts on the fill as the requests before it left it.
                if (by != null) walk.expand(by);
                walk.begin(budget);
                begun = true;
                int scx = walk.seed.getX() >> 4, scz = walk.seed.getZ() >> 4;
                LongArrayList l = new LongArrayList();
                for (long k : walk.area()) if (state.status.get(k) < 0) l.add(k);
                l.sort((a, b) -> Integer.compare(ring(a, scx, scz), ring(b, scx, scz)));
                ahead = l;
            }
            prefetch();
            if (walk.running() && !walk.step(this, () -> System.nanoTime() >= deadline)) return false;
            // The answer lists the area's ungenerated chunks: every one's generation must be known
            // (the reads prefetch started; nothing new is started here).
            boolean known = true;
            for (long k : walk.area()) {
                if (state.status.get(k) >= 0) continue;
                CompletableFuture<Column> f = reading.get(k);
                if (f != null && f.isDone()) take(k);
                else if (f == null && live(ChunkPos.getX(k), ChunkPos.getZ(k)) != null) state.status.put(k, (byte) FillWalk.READY);
                else known = false;
            }
            if (!known) prefetch();
            return known;
        }

        static int ring(long k, int cx, int cz) {
            return Math.max(Math.abs(ChunkPos.getX(k) - cx), Math.abs(ChunkPos.getZ(k) - cz));
        }

        /** Starts reads of the area's unknown chunks, up to {@link #PREFETCH} in flight. */
        void prefetch() {
            LongArrayList l = ahead;
            if (l == null) return;
            while (reading.size() < PREFETCH && aheadNext < l.size()) {
                long k = l.getLong(aheadNext++);
                if (state.status.get(k) >= 0 || reading.containsKey(k)) continue;
                if (level.getChunkSource().getChunkNow(ChunkPos.getX(k), ChunkPos.getZ(k)) != null) state.status.put(k, (byte) FillWalk.READY);
                else read(k);
            }
        }

        CompletableFuture<Column> read(long k) {
            CompletableFuture<Column> f = level.getChunkSource().chunkMap.read(new ChunkPos(k))
                    .thenApplyAsync(tag -> decode(tag, minSection, maxSection), background)
                    .exceptionally(e -> {
                        LOG.warn("Autosketch: reading chunk {},{} from disk for a fill failed; loading it instead", ChunkPos.getX(k), ChunkPos.getZ(k), e);
                        return new Column(Column.Kind.LOAD, null);
                    });
            reading.put(k, f);
            return f;
        }

        @Nullable LevelChunk live(int cx, int cz) {
            long k = ChunkPos.asLong(cx, cz);
            if (k != liveKey) {
                liveKey = k;
                live = level.getChunkSource().getChunkNow(cx, cz);
                if (live != null) liveSeen.add(k);
            }
            return live;
        }

        /** A finished read of an unloaded chunk taken in: its generation recorded and, read, cached. Null while pending. */
        @Nullable Column take(long k) {
            CompletableFuture<Column> f = reading.get(k);
            if (f == null) f = read(k);
            if (!f.isDone()) return null;
            reading.remove(k);
            Column c = f.join();
            if (c.kind() == Column.Kind.MISSING) {
                state.status.put(k, (byte) FillWalk.MISSING);
                missing++;
            } else {
                state.status.put(k, (byte) FillWalk.READY);
                cache.put(k, c);
                if (c.kind() == Column.Kind.READ) disk++;
            }
            return c;
        }

        @Override
        public int column(int cx, int cz) {
            long k = ChunkPos.asLong(cx, cz);
            byte s = state.status.get(k);
            if (s >= 0) return s;
            if (live(cx, cz) != null) {
                state.status.put(k, (byte) FillWalk.READY);
                return FillWalk.READY;
            }
            Column c = take(k);
            if (c == null) return FillWalk.WAIT;
            return c.kind() == Column.Kind.MISSING ? FillWalk.MISSING : FillWalk.READY;
        }

        @Override
        public int matches(int x, int y, int z) {
            int cx = x >> 4, cz = z >> 4, sy = y >> 4;
            LevelChunk c = live(cx, cz);
            BlockState st;
            if (c != null) {
                st = c.getSection(c.getSectionIndexFromSectionY(sy)).getStates().get(x & 15, y & 15, z & 15);
            } else {
                long k = ChunkPos.asLong(cx, cz);
                Column col = cache.get(k);
                if (col == null) {
                    col = take(k);
                    if (col == null) return FillWalk.WAIT;
                }
                if (col.kind() == Column.Kind.MISSING) return 0; // generated once, gone now: read as nothing
                if (col.kind() == Column.Kind.LOAD) {
                    LevelChunk l = SurfaceReads.existing(level, cx, cz, new int[1]);
                    cache.remove(k);
                    if (l == null) return 0;
                    fallback++;
                    liveKey = Long.MIN_VALUE;
                    return state.match.test(l.getSection(l.getSectionIndexFromSectionY(sy)).getStates().get(x & 15, y & 15, z & 15)) ? 1 : 0;
                }
                PalettedContainer<BlockState> sec = col.sections()[sy - minSection];
                if (sec == null) return state.match.test(net.minecraft.world.level.block.Blocks.AIR.defaultBlockState()) ? 1 : 0;
                st = sec.get(x & 15, y & 15, z & 15);
            }
            return state.match.test(st) ? 1 : 0;
        }

        void cancel() {
            for (CompletableFuture<Column> f : reading.values()) f.cancel(false);
            reading.clear();
            cache.clear();
        }

        /** Builds the answer on the server thread (the walk is server-thread state) and encodes it off-thread. */
        void finish() {
            cancel();
            boolean delta = by != null;
            if (walk.bodyBound(delta) > FrameCodec.MAX_FRAME - 64 * 1024) {
                ex.error(ErrorCodes.TOO_LARGE, "the shape's " + walk.sections() + " sections can't fit in one frame; expand with a smaller budget");
                return;
            }
            SelectMessages.FillResult r;
            try {
                r = walk.result(id, dimension, delta, k -> state.status.get(k) == FillWalk.MISSING);
            } catch (RuntimeException e) {
                LOG.error("Autosketch: building a fill reply failed", e);
                ex.error(PatchApplier.INTERNAL, "the mod failed building the reply: " + e.getMessage());
                return;
            }
            long added = walk.added();
            int sections = walk.sections(), loaded = liveSeen.size();
            background.execute(() -> {
                try {
                    Frame f = r.encode();
                    int frontier = 0;
                    for (SelectMessages.FrontierSection s : r.frontier()) frontier += s.index().length;
                    lastFill = new Stats(added, r.count(), sections, frontier, loaded, disk, fallback, missing, ticks, serverNanos, System.nanoTime() - started, f.body().length);
                    ex.reply(f);
                } catch (RuntimeException e) {
                    LOG.error("Autosketch: encoding a fill reply failed", e);
                    ex.error(PatchApplier.INTERNAL, "the mod failed building the reply: " + e.getMessage());
                }
            });
        }
    }
}
