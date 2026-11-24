package dev.autosketch.mod.world;

import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Messages.ChunkXZ;
import dev.autosketch.mod.protocol.SelectMessages.ExpandBy;
import dev.autosketch.mod.protocol.SelectMessages.FillResult;
import dev.autosketch.mod.protocol.SelectMessages.FrontierSection;
import dev.autosketch.mod.protocol.SelectMessages.MaskSection;
import it.unimi.dsi.fastutil.longs.Long2IntLinkedOpenHashMap;
import it.unimi.dsi.fastutil.longs.Long2ObjectOpenHashMap;
import it.unimi.dsi.fastutil.longs.LongArrayList;
import it.unimi.dsi.fastutil.longs.LongLinkedOpenHashSet;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.function.BooleanSupplier;
import java.util.function.LongPredicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.SectionPos;
import net.minecraft.world.level.ChunkPos;

/**
 * One fill's resumable state (18, pieces 3 and 4; 13, *Select*, {@code fill} and {@code expand}): the
 * shape, the read area (whole chunk columns, clipped to the select grant) and where exploration
 * stopped. The algorithm is the fake host's ({@code test/support/fake-select.ts}, {@code WorldFill}),
 * which is {@code {connected}}'s ({@code src/ops/selection.ts}): depth-first from a stack, neighbours
 * in {@code {connected}}'s order, so the same blocks give the same shape, cut and frontier; the
 * fixture {@code test/data/select/fill-parity.json} holds the fake host's answers both sides replay.
 *
 * <p>A run is sliced: {@link #step} returns false when time is up or a chunk isn't read yet, and
 * picks up at the same neighbour of the same position. The shape is kept as 4096-bit sets per section,
 * so a shape of tens of millions of blocks costs about a bit per block. Server thread only.
 */
public final class FillWalk {
    /** What a run reads. Answers {@link #WAIT} when a chunk isn't read yet (ask again next tick). */
    public interface Blocks {
        /** {@link #READY} (generated), {@link #MISSING} (never fully generated) or {@link #WAIT}. */
        int column(int cx, int cz);

        /** 1 when the block matches, 0 when not, {@link #WAIT}. Only asked in a READY column. */
        int matches(int x, int y, int z);
    }

    public static final int READY = 0, MISSING = 1, WAIT = -1;
    private static final long NONE = Long.MIN_VALUE;

    public final BlockPos seed;
    private final int[][] nbrs;
    private final int minY, maxY;
    private final LongPredicate grant;
    private final LongOpenHashSet area = new LongOpenHashSet();
    /** Section key → 64 words: bit {@code x + 16·(z + 16·y)} local. */
    private final Long2ObjectOpenHashMap<long[]> shape = new Long2ObjectOpenHashMap<>();
    private long count;
    private int bx0, by0, bz0, bx1, by1, bz1;
    /** Shape positions whose neighbours weren't all explored because the budget ran out. */
    private LongArrayList pending = new LongArrayList();
    /** Shape positions with a neighbour outside the read area, in the order first met. */
    private final LongLinkedOpenHashSet blocked = new LongLinkedOpenHashSet();
    private String lastStop = "complete";

    // The run in progress.
    private boolean running, started;
    private long budget, added;
    private final LongArrayList stack = new LongArrayList();
    private long cur = NONE;
    private int ni;
    private final LongOpenHashSet changed = new LongOpenHashSet();

    /**
     * @param area  the read area starts as the chunks within this many of the seed's chunk
     * @param grant whether a chunk ({@link ChunkPos#asLong}) lies inside the select grant
     */
    public FillWalk(BlockPos seed, int connectivity, int area, LongPredicate grant, int minY, int maxY) {
        this.seed = seed.immutable();
        this.nbrs = neighbours(connectivity);
        this.grant = grant;
        this.minY = minY;
        this.maxY = maxY;
        int sx = seed.getX() >> 4, sz = seed.getZ() >> 4;
        for (int dz = -area; dz <= area; dz++) for (int dx = -area; dx <= area; dx++) addChunk(sx + dx, sz + dz);
    }

    /** {@code {connected}}'s neighbour offsets, in its order (x, then y, then z, each −1 to 1). */
    static int[][] neighbours(int connectivity) {
        List<int[]> out = new ArrayList<>();
        for (int dx = -1; dx <= 1; dx++)
            for (int dy = -1; dy <= 1; dy++)
                for (int dz = -1; dz <= 1; dz++) {
                    int n = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
                    if (n == 0 || (connectivity == 6 && n > 1) || (connectivity == 18 && n > 2)) continue;
                    out.add(new int[] {dx, dy, dz});
                }
        return out.toArray(new int[0][]);
    }

    /** The face bits (down 1, up 2, north 4, south 8, west 16, east 32) an offset lies toward. */
    static int faceBits(int dx, int dy, int dz) {
        return (dy < 0 ? 1 : 0) | (dy > 0 ? 2 : 0) | (dz < 0 ? 4 : 0) | (dz > 0 ? 8 : 0) | (dx < 0 ? 16 : 0) | (dx > 0 ? 32 : 0);
    }

    private void addChunk(int cx, int cz) {
        long k = ChunkPos.asLong(cx, cz);
        if (grant.test(k)) area.add(k);
    }

    private boolean inArea(int x, int z) {
        return area.contains(ChunkPos.asLong(x >> 4, z >> 4));
    }

    /** The read area's chunks ({@link ChunkPos#asLong}). */
    public LongOpenHashSet area() {
        return area;
    }

    public long count() {
        return count;
    }

    public int sections() {
        return shape.size();
    }

    public String stopped() {
        return lastStop;
    }

    public boolean running() {
        return running;
    }

    /** Blocks the current (or last) run added. */
    public long added() {
        return added;
    }

    // ── shape ─────────────────────────────────────────────────────────────────────────────────

    private static int local(int x, int y, int z) {
        return (x & 15) + 16 * ((z & 15) + 16 * (y & 15));
    }

    public boolean has(int x, int y, int z) {
        long[] w = shape.get(SectionPos.asLong(x >> 4, y >> 4, z >> 4));
        if (w == null) return false;
        int i = local(x, y, z);
        return (w[i >> 6] & (1L << (i & 63))) != 0;
    }

    private void add(int x, int y, int z) {
        long sk = SectionPos.asLong(x >> 4, y >> 4, z >> 4);
        long[] w = shape.computeIfAbsent(sk, k -> new long[64]);
        int i = local(x, y, z);
        w[i >> 6] |= 1L << (i & 63);
        changed.add(sk);
        if (count++ == 0) {
            bx0 = bx1 = x;
            by0 = by1 = y;
            bz0 = bz1 = z;
        } else {
            bx0 = Math.min(bx0, x);
            by0 = Math.min(by0, y);
            bz0 = Math.min(bz0, z);
            bx1 = Math.max(bx1, x);
            by1 = Math.max(by1, y);
            bz1 = Math.max(bz1, z);
        }
    }

    // ── a run ─────────────────────────────────────────────────────────────────────────────────

    /** Starts a run adding at most {@code budget} blocks (the seed included): the first, or a resumption after {@link #expand}. */
    public void begin(long budget) {
        this.budget = budget;
        added = 0;
        changed.clear();
        stack.clear();
        cur = NONE;
        ni = 0;
        started = false;
        running = true;
    }

    /**
     * Runs on until the run ends (true) or {@code timeUp} says so or a chunk isn't read yet (false).
     * {@code timeUp} is asked every few hundred neighbours.
     */
    public boolean step(Blocks b, BooleanSupplier timeUp) {
        if (!running) return true;
        if (!started) {
            if (count == 0) {
                int x = seed.getX(), y = seed.getY(), z = seed.getZ();
                if (y < minY || y > maxY || !inArea(x, z)) return finish("complete");
                int st = b.column(x >> 4, z >> 4);
                if (st == WAIT) return false;
                if (st == MISSING) return finish("complete");
                int m = b.matches(x, y, z);
                if (m == WAIT) return false;
                if (m == 0) return finish("complete");
                add(x, y, z);
                added++;
                stack.add(seed.asLong());
            } else {
                // Resume: the positions left pending, then those cut by the area's edge, in a stable order.
                LongOpenHashSet inPending = new LongOpenHashSet(pending);
                stack.addAll(pending);
                for (long k : blocked) if (!inPending.contains(k)) stack.add(k);
                blocked.clear();
            }
            pending = new LongArrayList();
            started = true;
        }
        int sinceCheck = 0;
        while (true) {
            if (cur == NONE) {
                if (stack.isEmpty()) return finish(blocked.isEmpty() ? "complete" : "edge");
                cur = stack.popLong();
                ni = 0;
            }
            int x = BlockPos.getX(cur), y = BlockPos.getY(cur), z = BlockPos.getZ(cur);
            while (ni < nbrs.length) {
                if (++sinceCheck >= 256) {
                    sinceCheck = 0;
                    if (timeUp.getAsBoolean()) return false;
                }
                int[] d = nbrs[ni];
                int qx = x + d[0], qy = y + d[1], qz = z + d[2];
                if (has(qx, qy, qz) || qy < minY || qy > maxY) {
                    ni++;
                    continue;
                }
                int st = b.column(qx >> 4, qz >> 4);
                if (st == WAIT) return false;
                if (st == MISSING) {
                    ni++;
                    continue;
                }
                if (!inArea(qx, qz)) {
                    blocked.add(cur);
                    ni++;
                    continue;
                }
                if (added >= budget) {
                    pending = new LongArrayList(stack);
                    pending.add(cur);
                    stack.clear();
                    cur = NONE;
                    return finish("budget");
                }
                int m = b.matches(qx, qy, qz);
                if (m == WAIT) return false;
                ni++;
                if (m == 0) continue;
                add(qx, qy, qz);
                added++;
                stack.add(BlockPos.asLong(qx, qy, qz));
            }
            cur = NONE;
        }
    }

    private boolean finish(String stop) {
        lastStop = stop;
        running = false;
        return true;
    }

    // ── expand ────────────────────────────────────────────────────────────────────────────────

    /** Grows the read area (clipped to the grant), 13's {@code expand.by}. Call between runs. */
    public void expand(ExpandBy by) {
        if (by.frontier()) {
            // The chunks one step across any combination of a frontier position's horizontal faces.
            Long2IntLinkedOpenHashMap f = frontierFaces();
            for (var e : f.long2IntEntrySet()) {
                long p = e.getLongKey();
                int faces = e.getIntValue(), x = BlockPos.getX(p), z = BlockPos.getZ(p);
                int[] dxs = steps((faces & 16) != 0, (faces & 32) != 0), dzs = steps((faces & 4) != 0, (faces & 8) != 0);
                for (int dx : dxs) for (int dz : dzs) addChunk((x + dx) >> 4, (z + dz) >> 4);
            }
            return;
        }
        if (by.box() != null) {
            Box bx = by.box();
            for (int cz = bx.minZ() >> 4; cz <= bx.maxZ() >> 4; cz++) for (int cx = bx.minX() >> 4; cx <= bx.maxX() >> 4; cx++) addChunk(cx, cz);
            return;
        }
        int ex = switch (by.direction()) {
            case "west" -> -1;
            case "east" -> 1;
            default -> 0;
        };
        int ez = switch (by.direction()) {
            case "north" -> -1;
            case "south" -> 1;
            default -> 0;
        };
        for (long k : area.toLongArray()) {
            int cx = ChunkPos.getX(k), cz = ChunkPos.getZ(k);
            for (int i = 1; i <= by.chunks(); i++) addChunk(cx + ex * i, cz + ez * i);
        }
    }

    private static int[] steps(boolean minus, boolean plus) {
        return minus && plus ? new int[] {0, -1, 1} : minus ? new int[] {0, -1} : plus ? new int[] {0, 1} : new int[] {0};
    }

    /**
     * Every frontier position ({@link BlockPos#asLong}) with its faces: the sides each unexplored
     * neighbour lies toward (both sides for a diagonal one). At the area's edge only the horizontal
     * sides count (the area is whole chunk columns); for the budget, every neighbour not in the shape.
     */
    Long2IntLinkedOpenHashMap frontierFaces() {
        Long2IntLinkedOpenHashMap out = new Long2IntLinkedOpenHashMap();
        for (long k : blocked) {
            int x = BlockPos.getX(k), z = BlockPos.getZ(k), m = 0;
            for (int[] d : nbrs) if (!inArea(x + d[0], z + d[2])) m |= faceBits(d[0], 0, d[2]);
            if (m != 0) out.put(k, out.get(k) | m);
        }
        for (long k : pending) {
            int x = BlockPos.getX(k), y = BlockPos.getY(k), z = BlockPos.getZ(k), m = 0;
            for (int[] d : nbrs) if (!has(x + d[0], y + d[1], z + d[2])) m |= faceBits(d[0], d[1], d[2]);
            if (m != 0) out.put(k, out.get(k) | m);
        }
        return out;
    }

    // ── the answer ────────────────────────────────────────────────────────────────────────────

    private static final Comparator<long[]> SECTION_ORDER = Comparator.<long[]>comparingLong(s -> s[1]).thenComparingLong(s -> s[2]).thenComparingLong(s -> s[0]);

    /**
     * The answer: the whole shape, or with {@code delta} only the sections the last run added to (an
     * expand's). {@code missing} lists the area's ungenerated chunks: every area chunk's status must be
     * known by then.
     */
    public FillResult result(long id, String dimension, boolean delta, LongPredicate missingChunk) {
        List<long[]> keys = new ArrayList<>();
        for (long sk : shape.keySet()) if (!delta || changed.contains(sk)) keys.add(new long[] {SectionPos.x(sk), SectionPos.y(sk), SectionPos.z(sk), sk});
        keys.sort(SECTION_ORDER);
        List<MaskSection> sections = new ArrayList<>(keys.size());
        for (long[] s : keys) {
            long[] w = shape.get(s[3]);
            int bits = 0;
            for (long v : w) bits += Long.bitCount(v);
            if (bits == 4096) {
                sections.add(new MaskSection((int) s[0], (int) s[1], (int) s[2], null));
                continue;
            }
            byte[] mask = new byte[512];
            for (int i = 0; i < 512; i++) mask[i] = (byte) (w[i >> 3] >>> ((i & 7) * 8));
            sections.add(new MaskSection((int) s[0], (int) s[1], (int) s[2], mask));
        }
        // Frontier positions per section, indices ascending.
        Long2ObjectOpenHashMap<List<int[]>> fr = new Long2ObjectOpenHashMap<>();
        for (var e : frontierFaces().long2IntEntrySet()) {
            long p = e.getLongKey();
            int x = BlockPos.getX(p), y = BlockPos.getY(p), z = BlockPos.getZ(p);
            fr.computeIfAbsent(SectionPos.asLong(x >> 4, y >> 4, z >> 4), k -> new ArrayList<>()).add(new int[] {local(x, y, z), e.getIntValue()});
        }
        List<long[]> fkeys = new ArrayList<>();
        for (long sk : fr.keySet()) fkeys.add(new long[] {SectionPos.x(sk), SectionPos.y(sk), SectionPos.z(sk), sk});
        fkeys.sort(SECTION_ORDER);
        List<FrontierSection> frontier = new ArrayList<>(fkeys.size());
        for (long[] s : fkeys) {
            List<int[]> l = fr.get(s[3]);
            l.sort(Comparator.comparingInt(a -> a[0]));
            int[] index = new int[l.size()], faces = new int[l.size()];
            for (int i = 0; i < index.length; i++) {
                index[i] = l.get(i)[0];
                faces[i] = l.get(i)[1];
            }
            frontier.add(new FrontierSection((int) s[0], (int) s[1], (int) s[2], index, faces));
        }
        List<long[]> miss = new ArrayList<>();
        for (long k : area) if (missingChunk.test(k)) miss.add(new long[] {ChunkPos.getX(k), ChunkPos.getZ(k)});
        miss.sort(Comparator.<long[]>comparingLong(c -> c[1]).thenComparingLong(c -> c[0]));
        List<ChunkXZ> missing = new ArrayList<>(miss.size());
        for (long[] c : miss) missing.add(new ChunkXZ((int) c[0], (int) c[1]));
        Box box = count == 0 ? null : new Box(bx0, by0, bz0, bx1, by1, bz1);
        return new FillResult(id, dimension, seed, count, box, lastStop, delta, missing, sections, frontier);
    }

    /** An upper bound of the answer's body in bytes (13's {@code fill.result} layout), to refuse one over a frame. */
    public long bodyBound(boolean delta) {
        long n = 16;
        for (long sk : shape.keySet()) if (!delta || changed.contains(sk)) n += 10 + 512;
        long frontier = blocked.size() + pending.size();
        return n + frontier * 12;
    }
}
