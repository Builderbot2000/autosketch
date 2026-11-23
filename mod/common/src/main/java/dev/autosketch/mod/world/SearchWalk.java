package dev.autosketch.mod.world;

import dev.autosketch.mod.protocol.Messages.ChunkXZ;
import dev.autosketch.mod.protocol.SelectMessages.SearchChunk;
import dev.autosketch.mod.protocol.SelectMessages.SearchCluster;
import dev.autosketch.mod.protocol.SelectMessages.SearchResult;
import java.util.ArrayList;
import java.util.BitSet;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.ToIntFunction;
import net.minecraft.world.level.chunk.PalettedContainer;

/**
 * One material search's resumable state (18, piece 2; 13, *Select*, {@code search}): the rings walked
 * so far, the matching chunks with their counts and sections, the clusters they form and the
 * ungenerated chunks met. Pure bookkeeping, no world access: {@link MaterialSearch} reads the chunks
 * and reports them here in walk order. Server thread only.
 *
 * <p>Rings are Chebyshev distances from the centre chunk, each walked in index order (ascending cz,
 * then cx). Matching chunks that touch by an edge or a corner form a cluster, whose index in the
 * answer follows the walk order of its first chunk. A cluster is closed once the walk has completed
 * {@code gap} rings past its farthest ring: no later ring can touch it.
 */
public final class SearchWalk {
    final List<String> materials;
    final int centreX, centreZ, radius, gap;
    final boolean clipped;
    /** The last ring walked completely; -1 before the first. */
    int reached = -1;

    private final Map<Long, Hit> hits = new HashMap<>();
    private final List<ChunkXZ> missing = new ArrayList<>();
    private int order;

    private static final class Hit {
        final int cx, cz, ring, order;
        final long[] counts;
        final BitSet sections;
        Hit parent = this;

        Hit(int cx, int cz, int ring, int order, long[] counts, BitSet sections) {
            this.cx = cx;
            this.cz = cz;
            this.ring = ring;
            this.order = order;
            this.counts = counts;
            this.sections = sections;
        }
    }

    public SearchWalk(List<String> materials, int centreX, int centreZ, int radius, boolean clipped, int gap) {
        this.materials = List.copyOf(materials);
        this.centreX = centreX;
        this.centreZ = centreZ;
        this.radius = radius;
        this.clipped = clipped;
        this.gap = gap;
    }

    public int reached() {
        return reached;
    }

    public boolean complete() {
        return reached >= radius;
    }

    // ── rings ─────────────────────────────────────────────────────────────────────────────────

    /** The chunks of ring {@code r} in walk order, as {@code [cx, cz]} pairs. */
    public List<int[]> ring(int r) {
        List<int[]> out = new ArrayList<>(r == 0 ? 1 : 8 * r);
        for (int dz = -r; dz <= r; dz++) {
            if (dz == -r || dz == r) for (int dx = -r; dx <= r; dx++) out.add(new int[] {centreX + dx, centreZ + dz});
            else {
                out.add(new int[] {centreX - r, centreZ + dz});
                out.add(new int[] {centreX + r, centreZ + dz});
            }
        }
        return out;
    }

    // ── what the walk met ─────────────────────────────────────────────────────────────────────

    /**
     * A chunk of ring {@code ring} with matches: per material its count (some non-zero), and the section
     * ys that hold one. Joins every touching matching chunk's cluster.
     */
    public void hit(int cx, int cz, int ring, long[] counts, int[] sections, int minSection) {
        BitSet s = new BitSet();
        for (int sy : sections) s.set(sy - minSection);
        Hit h = new Hit(cx, cz, ring, order++, counts.clone(), s);
        hits.put(key(cx, cz), h);
        for (int ez = -1; ez <= 1; ez++)
            for (int ex = -1; ex <= 1; ex++) {
                if (ex == 0 && ez == 0) continue;
                Hit n = hits.get(key(cx + ex, cz + ez));
                if (n != null) union(h, n);
            }
    }

    /** An ungenerated chunk the walk met. */
    public void missing(int cx, int cz) {
        missing.add(new ChunkXZ(cx, cz));
    }

    /** Ring {@code r} is walked completely. */
    public void completed(int r) {
        reached = r;
    }

    private static long key(int cx, int cz) {
        return ((long) cx << 32) | (cz & 0xffffffffL);
    }

    private static Hit find(Hit h) {
        Hit r = h;
        while (r.parent != r) r = r.parent;
        while (h.parent != r) {
            Hit next = h.parent;
            h.parent = r;
            h = next;
        }
        return r;
    }

    /** Joins two clusters; the root stays the cluster's first chunk in walk order. */
    private static void union(Hit a, Hit b) {
        Hit ra = find(a), rb = find(b);
        if (ra == rb) return;
        if (ra.order < rb.order) rb.parent = ra;
        else ra.parent = rb;
    }

    /** Per cluster root, its farthest ring. */
    private Map<Hit, Integer> farthest() {
        Map<Hit, Integer> out = new HashMap<>();
        for (Hit h : hits.values()) out.merge(find(h), h.ring, Math::max);
        return out;
    }

    /** Clusters closed at the ring reached so far. */
    public int closedCount() {
        int n = 0;
        for (int far : farthest().values()) if (reached >= far + gap) n++;
        return n;
    }

    /** The answer: the whole walk so far (13, {@code search.result}). */
    public SearchResult result(long id, String dimension, int minSection) {
        Map<Hit, Integer> far = farthest();
        List<Hit> roots = new ArrayList<>(far.keySet());
        roots.sort(Comparator.comparingInt(h -> h.order));
        Map<Hit, Integer> index = new HashMap<>();
        for (Hit r : roots) index.put(r, index.size());
        int n = roots.size();
        int[] minX = new int[n], minZ = new int[n], maxX = new int[n], maxZ = new int[n], chunks = new int[n];
        long[] blocks = new long[n];
        java.util.Arrays.fill(minX, Integer.MAX_VALUE);
        java.util.Arrays.fill(minZ, Integer.MAX_VALUE);
        java.util.Arrays.fill(maxX, Integer.MIN_VALUE);
        java.util.Arrays.fill(maxZ, Integer.MIN_VALUE);
        List<Hit> sorted = new ArrayList<>(hits.values());
        sorted.sort(Comparator.<Hit>comparingInt(h -> h.cz).thenComparingInt(h -> h.cx));
        List<SearchChunk> out = new ArrayList<>(sorted.size());
        for (Hit h : sorted) {
            int c = index.get(find(h));
            minX[c] = Math.min(minX[c], h.cx);
            minZ[c] = Math.min(minZ[c], h.cz);
            maxX[c] = Math.max(maxX[c], h.cx);
            maxZ[c] = Math.max(maxZ[c], h.cz);
            chunks[c]++;
            for (long k : h.counts) blocks[c] += k;
            int[] secs = h.sections.stream().map(i -> i + minSection).toArray();
            out.add(new SearchChunk(h.cx, h.cz, h.counts.clone(), c, secs));
        }
        List<SearchCluster> clusters = new ArrayList<>(n);
        for (int c = 0; c < n; c++)
            clusters.add(new SearchCluster(minX[c], minZ[c], maxX[c], maxZ[c], chunks[c], blocks[c], reached >= far.get(roots.get(c)) + gap));
        List<ChunkXZ> miss = new ArrayList<>(missing);
        miss.sort(Comparator.comparingInt(ChunkXZ::cz).thenComparingInt(ChunkXZ::cx));
        return new SearchResult(id, dimension, materials, centreX, centreZ, radius, clipped, Math.max(reached, 0), minSection, clusters, out, miss);
    }

    // ── one section ───────────────────────────────────────────────────────────────────────────

    /**
     * Counts a section's matching blocks into {@code counts} (by {@code which}: the material index, or
     * -1), asking the palette first: -1 when the palette holds no matching state (certain, so the
     * blocks aren't read), else the blocks counted, which may be 0 when the palette keeps a stale
     * entry (18, *Already built*: a yes is a "maybe").
     */
    public static <T> long countSection(PalettedContainer<T> states, ToIntFunction<T> which, long[] counts) {
        if (!states.maybeHas(t -> which.applyAsInt(t) >= 0)) return -1;
        long[] n = {0};
        states.count((t, k) -> {
            int m = which.applyAsInt(t);
            if (m >= 0) {
                counts[m] += k;
                n[0] += k;
            }
        });
        return n[0];
    }
}
