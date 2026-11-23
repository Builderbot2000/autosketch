package dev.autosketch.mod.world;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.autosketch.mod.protocol.Messages.ChunkXZ;
import dev.autosketch.mod.protocol.SelectMessages.SearchChunk;
import dev.autosketch.mod.protocol.SelectMessages.SearchCluster;
import dev.autosketch.mod.protocol.SelectMessages.SearchResult;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import java.util.function.ToIntFunction;
import net.minecraft.core.IdMapper;
import net.minecraft.world.level.chunk.PalettedContainer;
import org.junit.jupiter.api.Test;

/**
 * The material search's section walk and bookkeeping (18, piece 2, *Testing*): the palette check has
 * no false negatives, a stale palette entry is a "maybe" that counts zero, and rings, clusters,
 * closing and the answer follow 13's {@code search}.
 */
class SearchWalkTest {
    /** A registry of plain names standing in for block states (the container is generic). */
    static IdMapper<String> registry(int n) {
        IdMapper<String> m = new IdMapper<>(n);
        for (int i = 0; i < n; i++) m.addMapping("s" + i, i);
        return m;
    }

    static PalettedContainer<String> section(IdMapper<String> reg) {
        return new PalettedContainer<>(reg, "s0", PalettedContainer.Strategy.SECTION_STATES);
    }

    /** Materials: s5 is material 0, s7 and s300 material 1; anything else matches nothing. */
    static final ToIntFunction<String> WHICH = s -> switch (s) {
        case "s5" -> 0;
        case "s7", "s300" -> 1;
        default -> -1;
    };

    @Test
    void paletteWalkHasNoFalseNegatives() {
        IdMapper<String> reg = registry(600);
        Random rnd = new Random(18);
        // Distinct values per section: single value, linear (≤16), hash map (≤256) and global palettes.
        for (int distinct : new int[] {1, 2, 9, 40, 400}) {
            for (int round = 0; round < 25; round++) {
                PalettedContainer<String> c = section(reg);
                long[] want = new long[2];
                String[] pool = new String[distinct];
                for (int i = 0; i < distinct; i++) pool[i] = "s" + rnd.nextInt(600);
                for (int y = 0; y < 16; y++)
                    for (int z = 0; z < 16; z++)
                        for (int x = 0; x < 16; x++) {
                            String v = distinct == 1 ? pool[0] : rnd.nextInt(4) == 0 ? pool[rnd.nextInt(distinct)] : "s0";
                            if (round % 5 == 0 && rnd.nextInt(500) == 0) v = rnd.nextBoolean() ? "s5" : "s300";
                            c.getAndSetUnchecked(x, y, z, v);
                        }
                for (int y = 0; y < 16; y++)
                    for (int z = 0; z < 16; z++)
                        for (int x = 0; x < 16; x++) {
                            int m = WHICH.applyAsInt(c.get(x, y, z));
                            if (m >= 0) want[m]++;
                        }
                long[] got = new long[2];
                long n = SearchWalk.countSection(c, WHICH, got);
                if (want[0] + want[1] > 0) {
                    assertTrue(n >= 0, "a section holding a material is never skipped (" + distinct + " values)");
                    assertArrayEquals(want, got, "exact counts (" + distinct + " values)");
                    assertEquals(want[0] + want[1], n);
                } else assertTrue(n <= 0, "nothing counted where nothing matches");
            }
        }
    }

    @Test
    void aStalePaletteEntryIsAMaybeThatCountsZero() {
        PalettedContainer<String> c = section(registry(64));
        c.getAndSetUnchecked(3, 4, 5, "s7");
        c.getAndSetUnchecked(3, 4, 5, "s0"); // s7 stays in the palette until a resize
        long[] got = new long[2];
        assertEquals(0, SearchWalk.countSection(c, WHICH, got), "maybe, and nothing counted");
        assertArrayEquals(new long[2], got);

        PalettedContainer<String> clean = section(registry(64));
        clean.getAndSetUnchecked(0, 0, 0, "s1");
        assertEquals(-1, SearchWalk.countSection(clean, WHICH, new long[2]), "a palette without a match is a certain no: the blocks aren't read");
    }

    @Test
    void eachBlockCountsUnderTheFirstMaterialItMatches() {
        PalettedContainer<String> c = section(registry(400));
        c.getAndSetUnchecked(0, 0, 0, "s5");
        c.getAndSetUnchecked(1, 0, 0, "s300");
        c.getAndSetUnchecked(2, 0, 0, "s300");
        long[] got = new long[2];
        assertEquals(3, SearchWalk.countSection(c, WHICH, got));
        assertArrayEquals(new long[] {1, 2}, got);
    }

    // ── rings and clusters ────────────────────────────────────────────────────────────────────

    static SearchWalk walk(int radius, int gap) {
        return new SearchWalk(List.of("minecraft:stone_bricks", "minecraft:mossy_stone_bricks"), 10, -3, radius, false, gap);
    }

    @Test
    void ringsGoOutwardInIndexOrder() {
        SearchWalk w = walk(3, 2);
        assertEquals(List.of("10,-3"), names(w.ring(0)));
        assertEquals(List.of("9,-4", "10,-4", "11,-4", "9,-3", "11,-3", "9,-2", "10,-2", "11,-2"), names(w.ring(1)));
        assertEquals(16, w.ring(2).size());
        List<int[]> r3 = w.ring(3);
        for (int i = 1; i < r3.size(); i++) {
            int[] a = r3.get(i - 1), b = r3.get(i);
            assertTrue(a[1] < b[1] || (a[1] == b[1] && a[0] < b[0]), "ascending cz, then cx");
        }
    }

    static List<String> names(List<int[]> ring) {
        List<String> out = new ArrayList<>();
        for (int[] c : ring) out.add(c[0] + "," + c[1]);
        return out;
    }

    @Test
    void cornersJoinClustersWhichCloseGapRingsPastTheirFarthestRing() {
        SearchWalk w = walk(8, 2);
        // Ring 1: two chunks touching only by a corner; ring 4: a separate chunk.
        w.hit(11, -2, 1, new long[] {3, 0}, new int[] {4}, -4);
        w.completed(0);
        w.completed(1);
        w.hit(12, -1, 2, new long[] {0, 2}, new int[] {-1, 4}, -4);
        w.completed(2);
        assertEquals(0, w.closedCount(), "the cluster reached ring 2: open until ring 4 is walked");
        w.completed(3);
        assertEquals(0, w.closedCount());
        w.hit(6, -3, 4, new long[] {1, 0}, new int[] {0}, -4);
        w.missing(14, -7);
        w.missing(6, -7);
        w.completed(4);
        assertEquals(1, w.closedCount(), "the first cluster closes after ring 4");

        SearchResult r = w.result(7, "minecraft:overworld", -4);
        assertEquals(4, r.reached());
        assertEquals(List.of(
                new SearchCluster(11, -2, 12, -1, 2, 5, true),
                new SearchCluster(6, -3, 6, -3, 1, 1, false)), r.clusters());
        List<SearchChunk> cs = r.chunks();
        assertEquals(3, cs.size());
        // Ascending by cz, then cx.
        assertEquals(6, cs.get(0).cx());
        assertEquals(1, cs.get(0).cluster());
        assertEquals(11, cs.get(1).cx());
        assertArrayEquals(new int[] {-1, 4}, cs.get(2).sections());
        assertEquals(List.of(new ChunkXZ(6, -7), new ChunkXZ(14, -7)), r.missing());
        // It encodes (the codec checks indices, clusters and sections).
        r.encode();
    }

    @Test
    void aLaterChunkMergesTwoClustersUnderTheEarlierOne() {
        SearchWalk w = walk(8, 1);
        w.hit(9, -4, 1, new long[] {1, 0}, new int[] {0}, -4);
        w.hit(11, -4, 1, new long[] {1, 0}, new int[] {0}, -4);
        assertEquals(2, w.result(1, "d", -4).clusters().size());
        w.hit(10, -5, 2, new long[] {0, 1}, new int[] {0}, -4);
        SearchResult r = w.result(1, "d", -4);
        assertEquals(1, r.clusters().size());
        assertEquals(new SearchCluster(9, -5, 11, -4, 3, 3, false), r.clusters().get(0));
        w.completed(2);
        assertFalse(w.result(1, "d", -4).clusters().get(0).closed());
        w.completed(3);
        assertTrue(w.result(1, "d", -4).clusters().get(0).closed(), "gap 1: closed once ring 3 is walked");
    }
}
