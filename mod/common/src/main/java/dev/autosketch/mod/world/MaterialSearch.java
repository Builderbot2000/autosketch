package dev.autosketch.mod.world;

import com.mojang.logging.LogUtils;
import com.mojang.serialization.Codec;
import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Exchange;
import dev.autosketch.mod.protocol.ErrorCodes;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.SelectMessages;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.function.Function;
import java.util.function.Predicate;
import net.minecraft.SharedConstants;
import net.minecraft.core.HolderGetter;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.ListTag;
import net.minecraft.nbt.NbtOps;
import net.minecraft.nbt.NbtUtils;
import net.minecraft.nbt.Tag;
import net.minecraft.resources.ResourceKey;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.tags.TagKey;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.chunk.PalettedContainer;
import net.minecraft.world.level.chunk.status.ChunkType;
import net.minecraft.world.level.chunk.storage.ChunkSerializer;
import net.minecraft.world.level.chunk.storage.ChunkStorage;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * {@code search} (18, piece 2; 13, *Message schemas*, *Select*): the material search, mod side. Walks
 * the select grant's chunks in rings outward from the centre ({@link SearchWalk}), stopping after the
 * ring in which {@code stop} more clusters are closed than at the start, or at the radius; a
 * {@code continue} walks on from the ring reached.
 *
 * <p>Per chunk, per section, the palette is asked first ({@code maybeHas}) and only a "maybe" section
 * is counted. A loaded chunk is read on the server thread; one that isn't loaded is read from disk
 * without loading it: its saved tag is fetched through the chunk storage (asynchronous I/O, which
 * also sees chunks waiting to be written) and its sections' palettes and blocks decoded off-thread,
 * up to {@link #PREFETCH} chunks ahead of the walk. A chunk not fully generated is listed as missing
 * and never generated; one saved by another game version is loaded the vanilla way instead (as
 * {@link SurfaceReads} does), so the data fixers upgrade it. The server thread spends at most
 * {@link #sliceNanos} per tick (at least one chunk) and never waits on the disk. No ticket is taken.
 */
public final class MaterialSearch {
    private static final Logger LOG = LogUtils.getLogger();

    /** Server-thread time one tick may spend on the walk. */
    public static volatile long sliceNanos = 5_000_000L;
    /** Chunks read from disk ahead of the walk. */
    public static final int PREFETCH = 64;

    /** A section's saved block states, as the vanilla reader decodes them (shared with {@link WorldFill}). */
    static final Codec<PalettedContainer<BlockState>> STATES = PalettedContainer.codecRW(
            Block.BLOCK_STATE_REGISTRY, BlockState.CODEC, PalettedContainer.Strategy.SECTION_STATES, Blocks.AIR.defaultBlockState());

    private final Function<ResourceKey<Level>, @Nullable ServerLevel> levels;
    private final Executor background;
    private final Deque<Job> jobs = new ArrayDeque<>();

    public MaterialSearch(Function<ResourceKey<Level>, @Nullable ServerLevel> levels, Executor background) {
        this.levels = levels;
        this.background = background;
    }

    /**
     * Cost of the last finished search request (Z1 reads these, 18 *Measure first*): rings walked,
     * chunks met (read loaded, read from disk, loaded the vanilla way, missing), sections whose palette
     * said "maybe" and those with a match, ticks, server-thread and wall time, body bytes.
     */
    public record Stats(int rings, int chunks, int loaded, int disk, int fallback, int missing, int maybeSections, int matchSections,
            int ticks, long serverNanos, long wallNanos, int bytes) {}

    public static volatile @Nullable Stats lastSearch;

    public boolean busy() {
        return !jobs.isEmpty();
    }

    // ── request ───────────────────────────────────────────────────────────────────────────────

    /** {@code no_grant}, {@code wrong_dimension}, {@code outside_volumes} ({@code around}), {@code bad_request} (nothing to continue). */
    public void search(SelectMessages.SearchRequest req, Exchange ex) throws ProtocolException {
        long id = req.id();
        SelectGrants.Held held = SelectGrants.current();
        if (held == null) throw ProtocolException.refuse(ErrorCodes.NO_GRANT, id, "no select request is open: the player sends /autosketch select first");
        SelectGrants.Grant g = held.grant();
        if (!g.in(req.dimension()))
            throw ProtocolException.refuse(ErrorCodes.WRONG_DIMENSION, id, "the select request is in " + g.dimension().location() + ", not " + req.dimension());
        ServerLevel level = levels.apply(g.dimension());
        if (level == null) throw ProtocolException.refuse(PatchApplier.INTERNAL, id, "the dimension " + req.dimension() + " isn't loaded");
        AutosketchConfig.Select cfg = AutosketchConfig.get().select;
        SearchWalk walk;
        if (req.cont()) {
            walk = held.search();
            if (walk == null) throw ProtocolException.badRequest(id, "no search to continue: send one with materials first");
        } else {
            int cx = g.centreX(), cz = g.centreZ();
            if (req.around() != null) {
                cx = req.around().getX() >> 4;
                cz = req.around().getZ() >> 4;
                if (!g.hasChunk(cx, cz)) throw ProtocolException.refuse(ErrorCodes.OUTSIDE_VOLUMES, id, "around " + req.around().toShortString() + " lies outside the select grant");
            }
            int asked = req.radius() != null ? req.radius() : cfg.selectChunks;
            walk = new SearchWalk(req.materials(), cx, cz, Math.min(asked, cfg.selectChunks), asked > cfg.selectChunks, req.gap() != null ? req.gap() : cfg.searchGap);
            held.search(walk);
        }
        int stop = req.stop() != null ? req.stop() : cfg.searchStop;
        ex.defer();
        jobs.addLast(new Job(level, g, walk, Matcher.of(walk.materials), stop, req, ex));
        tick();
    }

    // ── slicing ───────────────────────────────────────────────────────────────────────────────

    /** Walks the jobs in order within the slice budget. Server thread. */
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
                LOG.error("Autosketch: the material search failed", e);
                j.ex.error(PatchApplier.INTERNAL, "the mod failed searching: " + e);
                continue;
            }
            j.serverNanos += System.nanoTime() - t0;
            if (!done) return;
            jobs.pollFirst();
            j.finish();
        }
    }

    // ── materials ─────────────────────────────────────────────────────────────────────────────

    /**
     * A material list's test (13, *Select*, "Materials"): a block id matches any of its states, a
     * canonical state exactly that state, {@code #ns:path} the block tag. Each state counts under the
     * first entry it matches. Unknown ids, states and tags match nothing. Thread-safe (memoised).
     */
    static final class Matcher {
        private final List<Predicate<BlockState>> tests;
        private final ConcurrentHashMap<BlockState, Integer> memo = new ConcurrentHashMap<>();

        private Matcher(List<Predicate<BlockState>> tests) {
            this.tests = tests;
        }

        static Matcher of(List<String> materials) {
            List<Predicate<BlockState>> tests = new ArrayList<>(materials.size());
            for (String m : materials) tests.add(test(m));
            return new Matcher(tests);
        }

        private static Predicate<BlockState> test(String m) {
            if (m.startsWith("#")) {
                ResourceLocation rl = ResourceLocation.tryParse(m.substring(1));
                if (rl == null) return st -> false;
                TagKey<Block> tag = TagKey.create(Registries.BLOCK, rl);
                return st -> st.is(tag);
            }
            if (m.indexOf('[') >= 0) {
                BlockState exact = States.parse(m);
                return exact == null ? st -> false : st -> st == exact;
            }
            ResourceLocation rl = ResourceLocation.tryParse(m);
            if (rl == null || !BuiltInRegistries.BLOCK.containsKey(rl)) return st -> false;
            Block b = BuiltInRegistries.BLOCK.get(rl);
            return st -> st.is(b);
        }

        /** The index of the first material {@code st} matches, or -1. */
        int which(BlockState st) {
            Integer i = memo.get(st);
            if (i != null) return i;
            int w = -1;
            for (int k = 0; k < tests.size() && w < 0; k++) if (tests.get(k).test(st)) w = k;
            memo.put(st, w);
            return w;
        }
    }

    // ── one chunk ─────────────────────────────────────────────────────────────────────────────

    /** What a chunk held: its kind, per material the matching blocks, the section ys with a match, and the section tallies. */
    record ChunkCount(Kind kind, long[] counts, int[] sections, int maybe) {
        enum Kind { COUNTED, MISSING, LOAD }

        static ChunkCount of(Kind kind) {
            return new ChunkCount(kind, new long[0], new int[0], 0);
        }

        long total() {
            long n = 0;
            for (long c : counts) n += c;
            return n;
        }
    }

    /** Counts a loaded chunk's sections. Server thread. */
    static ChunkCount countLoaded(LevelChunk c, Matcher m, int materials) {
        long[] counts = new long[materials];
        List<Integer> secs = new ArrayList<>();
        int maybe = 0;
        LevelChunkSection[] sections = c.getSections();
        for (int i = 0; i < sections.length; i++) {
            long[] here = new long[materials];
            long n = SearchWalk.countSection(sections[i].getStates(), m::which, here);
            if (n < 0) continue;
            maybe++;
            if (n == 0) continue;
            for (int k = 0; k < materials; k++) counts[k] += here[k];
            secs.add(c.getSectionYFromSectionIndex(i));
        }
        return new ChunkCount(ChunkCount.Kind.COUNTED, counts, secs.stream().mapToInt(Integer::intValue).toArray(), maybe);
    }

    /**
     * Counts a chunk from its saved tag without loading it. Off-thread: only the tag, the block
     * registry and tags are touched. {@code MISSING} when it isn't fully generated, {@code LOAD} when
     * it was saved by another game version (or doesn't decode), so the vanilla load upgrades it.
     */
    static ChunkCount countSaved(Optional<CompoundTag> saved, Matcher m, int materials, int minSection, int maxSection) {
        if (saved.isEmpty()) return ChunkCount.of(ChunkCount.Kind.MISSING);
        CompoundTag tag = saved.get();
        if (ChunkSerializer.getChunkTypeFromTag(tag) != ChunkType.LEVELCHUNK) return ChunkCount.of(ChunkCount.Kind.MISSING);
        if (ChunkStorage.getVersion(tag) != SharedConstants.getCurrentVersion().getDataVersion().getVersion()) return ChunkCount.of(ChunkCount.Kind.LOAD);
        HolderGetter<Block> blocks = BuiltInRegistries.BLOCK.asLookup();
        long[] counts = new long[materials];
        List<Integer> secs = new ArrayList<>();
        int maybe = 0;
        ListTag list = tag.getList(ChunkSerializer.SECTIONS_TAG, Tag.TAG_COMPOUND);
        for (int i = 0; i < list.size(); i++) {
            CompoundTag s = list.getCompound(i);
            int sy = s.getByte("Y");
            if (sy < minSection || sy >= maxSection) continue;
            long[] here = new long[materials];
            long n;
            if (!s.contains("block_states", Tag.TAG_COMPOUND)) {
                // All air, as the vanilla reader takes it.
                int w = m.which(Blocks.AIR.defaultBlockState());
                if (w < 0) continue;
                here[w] = 4096;
                n = 4096;
            } else {
                CompoundTag bs = s.getCompound("block_states");
                // The palette first: a section none of whose entries matches is skipped undecoded.
                ListTag palette = bs.getList("palette", Tag.TAG_COMPOUND);
                boolean any = false;
                for (int p = 0; p < palette.size() && !any; p++) any = m.which(NbtUtils.readBlockState(blocks, palette.getCompound(p))) >= 0;
                if (!any) continue;
                Optional<PalettedContainer<BlockState>> states = STATES.parse(NbtOps.INSTANCE, bs).result();
                if (states.isEmpty()) return ChunkCount.of(ChunkCount.Kind.LOAD);
                n = SearchWalk.countSection(states.get(), m::which, here);
                if (n < 0) continue;
            }
            maybe++;
            if (n == 0) continue;
            for (int k = 0; k < materials; k++) counts[k] += here[k];
            secs.add(sy);
        }
        secs.sort(null);
        return new ChunkCount(ChunkCount.Kind.COUNTED, counts, secs.stream().mapToInt(Integer::intValue).toArray(), maybe);
    }

    // ── one request ───────────────────────────────────────────────────────────────────────────

    /** A chunk queued for the walk, with its disk read when it wasn't loaded. */
    private static final class Pending {
        final int cx, cz, ring;
        @Nullable CompletableFuture<ChunkCount> disk;

        Pending(int cx, int cz, int ring) {
            this.cx = cx;
            this.cz = cz;
            this.ring = ring;
        }
    }

    private final class Job {
        final ServerLevel level;
        final SelectGrants.Grant grant;
        final SearchWalk walk;
        final Matcher matcher;
        final int stop, minSection, maxSection;
        /** Closed clusters when this request's walk began (set on its first tick, after any earlier request on the same walk). */
        int startClosed = -1;
        final SelectMessages.SearchRequest req;
        final Exchange ex;
        final Deque<Pending> queue = new ArrayDeque<>();
        final long started = System.nanoTime();
        /** The cursor: the next ring and position in it to queue. */
        int cursorRing;
        @Nullable List<int[]> cursorList;
        int cursorIndex;
        int ticks, rings, chunks, loaded, disk, fallback, missing, maybe, matched;
        long serverNanos;

        Job(ServerLevel level, SelectGrants.Grant grant, SearchWalk walk, Matcher matcher, int stop, SelectMessages.SearchRequest req, Exchange ex) {
            this.level = level;
            this.grant = grant;
            this.walk = walk;
            this.matcher = matcher;
            this.stop = stop;
            this.req = req;
            this.ex = ex;
            this.minSection = level.getMinSection();
            this.maxSection = level.getMaxSection();
        }

        /** Queues chunks ahead of the walk, starting the disk reads of those not loaded. */
        void prefetch() {
            while (queue.size() < PREFETCH && cursorRing <= walk.radius) {
                if (cursorList == null) {
                    cursorList = walk.ring(cursorRing);
                    cursorIndex = 0;
                }
                if (cursorIndex >= cursorList.size()) {
                    cursorRing++;
                    cursorList = null;
                    continue;
                }
                int[] c = cursorList.get(cursorIndex++);
                if (!grant.hasChunk(c[0], c[1])) continue;
                Pending p = new Pending(c[0], c[1], cursorRing);
                if (level.getChunkSource().getChunkNow(c[0], c[1]) == null) p.disk = read(p);
                queue.addLast(p);
            }
        }

        CompletableFuture<ChunkCount> read(Pending p) {
            int n = walk.materials.size();
            return level.getChunkSource().chunkMap.read(new ChunkPos(p.cx, p.cz))
                    .thenApplyAsync(tag -> countSaved(tag, matcher, n, minSection, maxSection), background)
                    .exceptionally(e -> {
                        LOG.warn("Autosketch: reading chunk {},{} from disk for a search failed; loading it instead", p.cx, p.cz, e);
                        return ChunkCount.of(ChunkCount.Kind.LOAD);
                    });
        }

        /** Walks on until done (true) or the slice ends or the head chunk's disk read is still running (false). */
        boolean run(long deadline) {
            if (startClosed < 0) {
                startClosed = walk.closedCount();
                cursorRing = walk.reached() + 1;
            }
            boolean progressed = false;
            while (true) {
                if (walk.complete()) return true;
                int r = walk.reached() + 1;
                prefetch();
                Pending head = queue.peekFirst();
                if (head == null || head.ring > r) {
                    walk.completed(r);
                    rings++;
                    if (walk.closedCount() - startClosed >= stop) return true;
                    continue;
                }
                if (progressed && System.nanoTime() >= deadline) return false;
                LevelChunk now = level.getChunkSource().getChunkNow(head.cx, head.cz);
                ChunkCount c;
                if (now != null) {
                    c = countLoaded(now, matcher, walk.materials.size());
                    loaded++;
                } else {
                    if (head.disk == null) head.disk = read(head); // unloaded since it was queued
                    if (!head.disk.isDone()) return false;
                    c = head.disk.join();
                    if (c.kind() == ChunkCount.Kind.LOAD) {
                        LevelChunk l = SurfaceReads.existing(level, head.cx, head.cz, new int[1]);
                        c = l == null ? ChunkCount.of(ChunkCount.Kind.MISSING) : countLoaded(l, matcher, walk.materials.size());
                        if (l != null) fallback++;
                    } else if (c.kind() == ChunkCount.Kind.COUNTED) disk++;
                }
                queue.pollFirst();
                progressed = true;
                chunks++;
                if (c.kind() == ChunkCount.Kind.MISSING) {
                    walk.missing(head.cx, head.cz);
                    missing++;
                    continue;
                }
                maybe += c.maybe();
                matched += c.sections().length;
                if (c.total() > 0) walk.hit(head.cx, head.cz, head.ring, c.counts(), c.sections(), minSection);
            }
        }

        /** Builds the answer on the server thread (the walk is server-thread state) and encodes it off-thread. */
        void finish() {
            for (Pending p : queue) if (p.disk != null) p.disk.cancel(false);
            SelectMessages.SearchResult r;
            try {
                r = walk.result(req.id(), req.dimension(), minSection);
            } catch (RuntimeException e) {
                LOG.error("Autosketch: building a search reply failed", e);
                ex.error(PatchApplier.INTERNAL, "the mod failed building the reply: " + e.getMessage());
                return;
            }
            background.execute(() -> {
                try {
                    Frame f = r.encode();
                    lastSearch = new Stats(rings, chunks, loaded, disk, fallback, missing, maybe, matched, ticks, serverNanos, System.nanoTime() - started, f.body().length);
                    ex.reply(f);
                } catch (RuntimeException e) {
                    LOG.error("Autosketch: encoding a search reply failed", e);
                    ex.error(PatchApplier.INTERNAL, "the mod failed building the reply: " + e.getMessage());
                }
            });
        }
    }
}
