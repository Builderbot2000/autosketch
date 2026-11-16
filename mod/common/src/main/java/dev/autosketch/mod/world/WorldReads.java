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
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;
import java.util.function.Function;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
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
 */
public final class WorldReads {
    private static final Logger LOG = LogUtils.getLogger();

    /** Server-thread time one tick may spend copying sections. */
    public static volatile long sliceNanos = 5_000_000L;

    private final LinkState link;
    private final Function<ResourceKey<Level>, @Nullable ServerLevel> levels;
    private final Executor background;
    private final Deque<Job> jobs = new ArrayDeque<>();

    public WorldReads(LinkState link, Function<ResourceKey<Level>, @Nullable ServerLevel> levels, Executor background) {
        this.link = link;
        this.levels = levels;
        this.background = background;
    }

    /** Cost of the last finished read: sections, ticks it was sliced over, server-thread and off-thread time. */
    public record ReadStats(int sections, int ticks, long serverNanos, long offThreadNanos) {}

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

    public void snapshot(Messages.SnapshotRequest req, Exchange ex) throws ProtocolException {
        List<Box> regions = req.regions();
        long total = 0;
        for (Box b : regions) total += b.volume();
        // Every position takes at least one byte of body.
        if (total > FrameCodec.MAX_FRAME) throw ProtocolException.refuse(ErrorCodes.TOO_LARGE, req.id(), total + " positions can't fit in one frame; ask for fewer boxes or sections");
        ServerLevel level = check(req.id(), req.dimension(), regions);
        start(new Job(level, regions, sectionsOf(regions), ex) {
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
                    for (Captured cs : captured.values())
                        for (Map.Entry<Long, CompoundTag> e : cs.bes.entrySet()) {
                            BlockPos bp = BlockPos.of(e.getKey());
                            if (r.contains(bp)) bes.add(new BlockEntityNbt(bp, e.getValue()));
                        }
                    out.add(new SnapshotRegion(r, states, bes));
                }
                send(new Messages.SnapshotResult(req.id(), req.dimension(), palette, out).encode());
            }
        });
    }

    /** {@code no_volumes}, {@code wrong_dimension}, {@code outside_volumes} (chunk columns the link keeps loaded). */
    private ServerLevel check(long id, String dimension, List<Box> boxes) throws ProtocolException {
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
            try {
                while (j.next < j.sections.size() && (first || System.nanoTime() < deadline)) {
                    long[] s = j.sections.get(j.next++);
                    j.captured.put(key(s), capture(j.level, (int) s[0], (int) s[1], (int) s[2], j.boxes));
                    first = false;
                }
            } catch (RuntimeException e) {
                jobs.pollFirst();
                LOG.error("Autosketch: reading the world failed", e);
                j.exchange.error(PatchApplier.INTERNAL, "the mod failed reading the world: " + e);
                continue;
            }
            j.serverNanos += System.nanoTime() - t0;
            if (j.next < j.sections.size()) return;
            jobs.pollFirst();
            background.execute(j::finishSafely);
        }
    }

    /** One section's states (a copy) and the NBT of its block entities inside the boxes. */
    static Captured capture(ServerLevel level, int sx, int sy, int sz, List<Box> boxes) {
        if (sy < level.getMinSection() || sy >= level.getMaxSection()) return new Captured(null, Map.of());
        LevelChunk chunk = level.getChunk(sx, sz);
        PalettedContainer<BlockState> states = chunk.getSection(chunk.getSectionIndexFromSectionY(sy)).getStates().copy();
        Map<Long, CompoundTag> bes = new HashMap<>();
        for (BlockEntity be : chunk.getBlockEntities().values()) {
            BlockPos p = be.getBlockPos();
            if (p.getY() >> 4 != sy || be.isRemoved() || !inAny(boxes, p.getX(), p.getY(), p.getZ())) continue;
            bes.put(p.asLong(), WorldBlocks.nbt(be, level.registryAccess()));
        }
        return new Captured(states, bes);
    }

    record Captured(@Nullable PalettedContainer<BlockState> states, Map<Long, CompoundTag> bes) {
        BlockState state(int x, int y, int z) {
            return states == null ? Blocks.AIR.defaultBlockState() : states.get(x & 15, y & 15, z & 15);
        }
    }

    private abstract static class Job {
        final ServerLevel level;
        final List<Box> boxes;
        final List<long[]> sections;
        final Exchange exchange;
        final Map<SKey, Captured> captured = new LinkedHashMap<>();
        int next, ticks;
        long serverNanos, offThreadStart;

        Job(ServerLevel level, List<Box> boxes, List<long[]> sections, Exchange exchange) {
            this.level = level;
            this.boxes = boxes;
            this.sections = sections;
            this.exchange = exchange;
        }

        /** Off-thread: build and send the reply from the copies. */
        abstract void finish();

        void send(Frame f) {
            lastRead = new ReadStats(sections.size(), ticks, serverNanos, System.nanoTime() - offThreadStart);
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
