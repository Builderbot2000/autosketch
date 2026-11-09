package dev.autosketch.mod.world;

import dev.autosketch.mod.api.LinkState;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.protocol.BodyTypes.WorldBlock;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import java.util.function.Function;
import java.util.function.IntSupplier;
import java.util.function.Supplier;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.PalettedContainer;
import org.jetbrains.annotations.Nullable;

/**
 * The change tracker (13, *World → agent*; M9): every block change inside the effective work volume
 * or a context box that isn't one of the mod's own patch writes, batched into at most one
 * {@code dirty} per server tick, sent at the end of the tick with the state and NBT the world holds
 * then. More changed positions than the cap (config {@code dirtyCap}, at most 4,096) send
 * {@code everything}. Changes outside both volumes are ignored, never reported.
 *
 * <p>Two detectors feed it, selected by config {@code tracker} ({@link Mode}):
 * <ul>
 *   <li><b>hook</b>: a mixin on {@code LevelChunk.setBlockState}, the path of every
 *       {@code Level.setBlock} (players, pistons, explosions, fluids, most mods). Its per-write cost
 *       outside the volumes is a null check, a level identity check and one bounding-box test. The
 *       mod's own writes go straight to the chunk section ({@link WorldBlocks#write}), so the hook
 *       never sees them.
 *   <li><b>scan</b> (the fallback, 13 *Open questions*): every {@code fallbackPeriod} ticks each
 *       section under the volumes is compared position by position with a baseline copy of its
 *       states, spread evenly over the period; differences are reported as changed positions. The
 *       mod's own writes update the baseline as they happen, so they're never reported. It also
 *       catches writers that bypass {@code setBlockState} (direct section writes, as Axiom's are
 *       believed to be: unverified).
 * </ul>
 */
public final class ChangeTracker {
    public enum Mode {
        HOOK, SCAN, BOTH;

        public boolean hook() {
            return this != SCAN;
        }

        public boolean scan() {
            return this != HOOK;
        }
    }

    /** What the hook checks against: the level, the bounding box of every volume, and the volumes. */
    private record Watch(Level level, Box bounds, LinkVolumes volumes) {}

    private static volatile @Nullable Watch watch;
    private static volatile @Nullable ChangeTracker instance;

    private final LinkState link;
    private final Function<ResourceKey<Level>, @Nullable ServerLevel> levels;
    private final IntSupplier cap;
    private final Supplier<Mode> mode;
    private final IntSupplier period;
    private Consumer<Frame> sink;

    private final Set<Long> changed = ConcurrentHashMap.newKeySet();
    private volatile boolean overflow;
    private @Nullable LinkVolumes watched;
    private @Nullable ServerLevel level;
    private Mode currentMode = Mode.HOOK;

    /** Scan baselines by section (state ids in x, z, y order); cleared on every volume change. */
    private final Map<WorldReads.SKey, int[]> baselines = new HashMap<>();
    private List<long[]> scanSections = List.of();
    private int scanNext;

    public ChangeTracker(LinkState link, Function<ResourceKey<Level>, @Nullable ServerLevel> levels, IntSupplier cap, Supplier<Mode> mode, IntSupplier period, Consumer<Frame> sink) {
        this.link = link;
        this.levels = levels;
        this.cap = cap;
        this.mode = mode;
        this.period = period;
        this.sink = sink;
        instance = this;
        WorldBlocks.listener = this::ownWrite;
    }

    /** Replaces where {@code dirty} frames go (tests capture them). Returns the previous sink. */
    public Consumer<Frame> sink(Consumer<Frame> next) {
        Consumer<Frame> prev = sink;
        sink = next;
        return prev;
    }

    // ── the hook (any thread) ─────────────────────────────────────────────────────────────────

    /** Called by the mixin after {@code LevelChunk.setBlockState} changed a block. Must stay cheap. */
    public static void onSetBlock(LevelChunk chunk, BlockPos pos) {
        Watch w = watch;
        if (w == null || chunk.getLevel() != w.level || !w.bounds.contains(pos) || !w.volumes.contains(pos)) return;
        ChangeTracker t = instance;
        if (t != null) t.record(pos);
    }

    private void record(BlockPos pos) {
        if (overflow) return;
        changed.add(pos.asLong());
        if (changed.size() > cap()) overflow = true;
    }

    private int cap() {
        return Math.max(1, Math.min(Messages.Dirty.CAP, cap.getAsInt()));
    }

    // ── per tick (server thread) ──────────────────────────────────────────────────────────────

    /** Start of a tick: follows volume and mode changes. */
    public void refresh() {
        LinkVolumes v = link.current();
        Mode m = mode.get();
        if (v == watched && m == currentMode) return;
        watched = v;
        currentMode = m;
        level = v == null ? null : levels.apply(v.dimension());
        changed.clear();
        overflow = false;
        baselines.clear();
        scanNext = 0;
        if (v == null || level == null) {
            watch = null;
            scanSections = List.of();
            return;
        }
        Box bounds = v.effectiveWork();
        for (Box b : v.context()) bounds = union(bounds, b);
        watch = m.hook() ? new Watch(level, bounds, v) : null;
        List<Box> all = new ArrayList<>(v.context());
        all.add(v.effectiveWork());
        scanSections = m.scan() ? WorldReads.sectionsOf(all) : List.of();
    }

    /** End of a tick: runs the scan's share, then sends at most one {@code dirty}. */
    public void endTick() {
        refresh();
        if (!scanSections.isEmpty() && level != null) scanSlice();
        flush();
    }

    private void flush() {
        if (!overflow && changed.isEmpty()) return;
        boolean all = overflow;
        List<Long> positions = new ArrayList<>(changed);
        changed.clear();
        overflow = false;
        ServerLevel lv = level;
        LinkVolumes v = watched;
        if (lv == null || v == null) return;
        if (all) {
            sink.accept(Messages.Dirty.all().encode());
            return;
        }
        List<WorldBlock> blocks = new ArrayList<>(positions.size());
        for (long p : positions) {
            BlockPos pos = BlockPos.of(p);
            if (!v.contains(pos)) continue;
            blocks.add(new WorldBlock(pos, States.print(WorldBlocks.state(lv, pos)), WorldBlocks.nbtAt(lv, pos)));
        }
        if (blocks.isEmpty()) return;
        Frame f;
        try {
            f = new Messages.Dirty(false, blocks).encode();
        } catch (RuntimeException e) {
            // A block entity the wire can't carry: let the MCP compare section hashes instead.
            f = Messages.Dirty.all().encode();
        }
        sink.accept(f);
    }

    // ── the scan ──────────────────────────────────────────────────────────────────────────────

    private void scanSlice() {
        int n = scanSections.size();
        int per = Math.max(1, (n + Math.max(1, period.getAsInt()) - 1) / Math.max(1, period.getAsInt()));
        for (int i = 0; i < per && i < n; i++) {
            if (scanNext >= n) scanNext = 0;
            long[] s = scanSections.get(scanNext++);
            scanSection((int) s[0], (int) s[1], (int) s[2]);
        }
    }

    private void scanSection(int sx, int sy, int sz) {
        ServerLevel lv = level;
        LinkVolumes v = watched;
        if (lv == null || v == null || sy < lv.getMinSection() || sy >= lv.getMaxSection()) return;
        LevelChunk chunk = lv.getChunkSource().getChunkNow(sx, sz);
        if (chunk == null) return;
        PalettedContainer<BlockState> now = chunk.getSection(chunk.getSectionIndexFromSectionY(sy)).getStates();
        WorldReads.SKey key = WorldReads.key(sx, sy, sz);
        int[] base = baselines.get(key);
        boolean fresh = base == null;
        if (fresh) baselines.put(key, base = new int[4096]);
        BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos();
        int i = 0;
        for (int y = 0; y < 16; y++)
            for (int z = 0; z < 16; z++)
                for (int x = 0; x < 16; x++, i++) {
                    int id = Block.BLOCK_STATE_REGISTRY.getId(now.get(x, y, z));
                    if (id == base[i]) continue;
                    base[i] = id;
                    if (fresh) continue;
                    pos.set((sx << 4) + x, (sy << 4) + y, (sz << 4) + z);
                    if (v.contains(pos)) record(pos);
                }
    }

    /** The mod's own write: keep the scan baseline in step so it isn't reported. */
    private void ownWrite(ServerLevel lv, BlockPos pos, BlockState state) {
        if (lv != level) return;
        int[] base = baselines.get(WorldReads.key(pos.getX() >> 4, pos.getY() >> 4, pos.getZ() >> 4));
        if (base != null) base[(pos.getX() & 15) + 16 * ((pos.getZ() & 15) + 16 * (pos.getY() & 15))] = Block.BLOCK_STATE_REGISTRY.getId(state);
    }

    private static Box union(Box a, Box b) {
        return new Box(Math.min(a.minX(), b.minX()), Math.min(a.minY(), b.minY()), Math.min(a.minZ(), b.minZ()),
                Math.max(a.maxX(), b.maxX()), Math.max(a.maxY(), b.maxY()), Math.max(a.maxZ(), b.maxZ()));
    }

    /** Positions waiting for the end of the tick (tests). */
    int queued() {
        return changed.size();
    }
}
