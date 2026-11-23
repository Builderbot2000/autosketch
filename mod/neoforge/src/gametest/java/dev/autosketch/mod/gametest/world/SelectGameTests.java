package dev.autosketch.mod.gametest.world;

import static dev.autosketch.mod.gametest.world.WorldTestKit.dim;
import static dev.autosketch.mod.gametest.world.WorldTestKit.nextId;
import static dev.autosketch.mod.gametest.world.WorldTestKit.put;
import static dev.autosketch.mod.gametest.world.WorldTestKit.unlink;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.gametest.world.WorldTestKit.TestExchange;
import dev.autosketch.mod.protocol.Area;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.SelectMessages;
import dev.autosketch.mod.protocol.SelectMessages.SearchChunk;
import dev.autosketch.mod.protocol.SelectMessages.SearchCluster;
import dev.autosketch.mod.protocol.SelectMessages.SearchResult;
import dev.autosketch.mod.world.MaterialSearch;
import dev.autosketch.mod.world.ScanGrants;
import dev.autosketch.mod.world.SelectGrants;
import dev.autosketch.mod.world.WorldModule;
import java.util.Arrays;
import java.util.List;
import java.util.Random;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;
import org.slf4j.Logger;

/**
 * Select, mod side (18, pieces 2 and 5's grant; *Testing*): the material search over loaded chunks,
 * chunks read from disk and ungenerated ones, stopping early and continuing, its refusals, and the
 * select grant's reads. Each test works in a far, random area, since the test world is kept between
 * runs. Handlers are called directly: the mod lists the feature {@code select} only from M3.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class SelectGameTests {
    private SelectGameTests() {}

    private static final Logger LOG = LogUtils.getLogger();
    static final String HONEY = "minecraft:honeycomb_block", KELP = "minecraft:dried_kelp_block";

    /** A far chunk no earlier run has touched (well inside the world border). */
    static int[] farChunk() {
        Random r = new Random();
        return new int[] {(r.nextBoolean() ? 1 : -1) * (20_000 + r.nextInt(1_000_000)), (r.nextBoolean() ? 1 : -1) * (20_000 + r.nextInt(1_000_000))};
    }

    static BlockPos at(int cx, int cz, int x, int y, int z) {
        return new BlockPos((cx << 4) + x, y, (cz << 4) + z);
    }

    static TestExchange search(SelectMessages.SearchRequest req) {
        TestExchange ex = new TestExchange(req.id());
        try {
            WorldModule.search().search(SelectMessages.SearchRequest.decode(req.encode()), ex);
        } catch (ProtocolException e) {
            ex.error(e.code(), e.getMessage());
        }
        return ex;
    }

    static SelectMessages.SearchRequest walk(GameTestHelper h, List<String> materials, Integer radius, BlockPos around, Integer gap, Integer stop) {
        return new SelectMessages.SearchRequest(nextId(), dim(h), false, materials, radius, around, gap, stop);
    }

    static SelectMessages.SearchRequest more(GameTestHelper h, Integer stop) {
        return new SelectMessages.SearchRequest(nextId(), dim(h), true, null, null, null, null, stop);
    }

    static SearchResult result(TestExchange ex) {
        if (ex.errorCode != null) throw new GameTestAssertException("refused: " + ex.errorCode);
        try {
            return SearchResult.decode(ex.reply);
        } catch (ProtocolException e) {
            throw new GameTestAssertException("undecodable search result: " + e.getMessage());
        }
    }

    static void refusedWith(GameTestHelper h, TestExchange ex, String code) {
        h.assertTrue(ex.done && ex.errorCode != null && ex.errorCode.startsWith(code + ":"), "expected " + code + ", got " + ex.errorCode);
    }

    /** Logs the cost of the last search (Z1 reads these, 18 *Measure first*). */
    static void logSearch(String what) {
        LOG.info("Autosketch search timing ({}): {}", what, MaterialSearch.lastSearch);
    }

    static SearchChunk chunk(SearchResult r, int cx, int cz) {
        for (SearchChunk c : r.chunks()) if (c.cx() == cx && c.cz() == cz) return c;
        throw new GameTestAssertException("no matching chunk " + cx + "," + cz + " in " + r.chunks().stream().map(c -> c.cx() + "," + c.cz()).toList());
    }

    static void assertChunk(GameTestHelper h, SearchResult r, int cx, int cz, long[] counts, int cluster, int[] sections) {
        SearchChunk c = chunk(r, cx, cz);
        h.assertTrue(Arrays.equals(c.counts(), counts), "chunk " + cx + "," + cz + " counts " + Arrays.toString(c.counts()));
        h.assertTrue(c.cluster() == cluster, "chunk " + cx + "," + cz + " cluster " + c.cluster());
        h.assertTrue(Arrays.equals(c.sections(), sections), "chunk " + cx + "," + cz + " sections " + Arrays.toString(c.sections()));
    }

    /**
     * Loaded, saved-but-unloaded and ungenerated chunks: A (centre) and B (touching A by a corner)
     * are saved and unloaded, C five chunks east stays loaded, D two west is generated with no match.
     * Gap 1, stop 2: {A, B} closes after ring 2, C after ring 6, where the walk stops.
     */
    @GameTest(template = "empty", batch = "y_select_search_disk", timeoutTicks = 2400)
    public static void searchReadsLoadedAndSavedChunksAndListsUngenerated(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        int[] f = farChunk();
        int fx = f[0], fz = f[1];
        int[][] generated = {{fx, fz}, {fx + 1, fz + 1}, {fx + 5, fz}, {fx - 2, fz}};
        for (int[] c : generated) level.getChunk(c[0], c[1]);
        put(level, at(fx, fz, 1, 70, 1), HONEY, null);
        put(level, at(fx, fz, 2, 70, 1), HONEY, null);
        put(level, at(fx, fz, 3, 100, 3), HONEY, null);
        put(level, at(fx, fz, 4, -50, 4), KELP, null);
        put(level, at(fx + 1, fz + 1, 0, 70, 0), KELP, null);
        put(level, at(fx + 1, fz + 1, 1, 70, 0), KELP, null);
        put(level, at(fx + 5, fz, 8, -60, 8), HONEY, null);
        level.setChunkForced(fx + 5, fz, true);
        level.getChunkSource().save(true);
        TestExchange[] ex = new TestExchange[1];
        h.startSequence()
                .thenWaitUntil(() -> {
                    for (int[] c : new int[][] {generated[0], generated[1], generated[3]})
                        if (level.getChunkSource().getChunkNow(c[0], c[1]) != null) throw new GameTestAssertException("waiting for chunk " + c[0] + "," + c[1] + " to unload");
                })
                .thenExecute(() -> {
                    SelectGrants.set(level.dimension(), at(fx, fz, 8, 64, 8), 8);
                    ex[0] = search(walk(h, List.of(HONEY, KELP), 10, null, 1, 2));
                })
                .thenWaitUntil(() -> {
                    if (!ex[0].done) throw new GameTestAssertException("waiting for the search");
                })
                .thenExecute(() -> {
                    try {
                        logSearch("loaded, disk, missing; radius 10, stopped at ring 6");
                        SearchResult r = result(ex[0]);
                        h.assertTrue(r.centreX() == fx && r.centreZ() == fz && r.radius() == 10 && !r.clipped(), "centre and radius: " + r.centreX() + "," + r.centreZ() + " r " + r.radius());
                        h.assertTrue(r.reached() == 6, "stopped after ring 6, where the second cluster closed: " + r.reached());
                        h.assertTrue(r.minSection() == level.getMinSection(), "minSection");
                        h.assertTrue(r.materials().equals(List.of(HONEY, KELP)), "materials");
                        h.assertTrue(r.clusters().equals(List.of(new SearchCluster(fx, fz, fx + 1, fz + 1, 2, 6, true), new SearchCluster(fx + 5, fz, fx + 5, fz, 1, 1, true))),
                                "clusters: " + r.clusters());
                        h.assertTrue(r.chunks().size() == 3, "three matching chunks: " + r.chunks().size());
                        assertChunk(h, r, fx, fz, new long[] {3, 1}, 0, new int[] {-4, 4, 6});
                        assertChunk(h, r, fx + 1, fz + 1, new long[] {0, 2}, 0, new int[] {4});
                        assertChunk(h, r, fx + 5, fz, new long[] {1, 0}, 1, new int[] {-4});
                        // Rings 0 to 6: 13 × 13 chunks. Generated: A, B and D (read from disk) and the
                        // loaded ones, which are C and the neighbours its forced ticket keeps full.
                        MaterialSearch.Stats st = MaterialSearch.lastSearch;
                        h.assertTrue(st != null && st.chunks() == 13 * 13, "walked rings 0 to 6: " + st);
                        h.assertTrue(r.missing().size() == 13 * 13 - st.loaded() - st.disk(), "every ungenerated chunk walked is listed: " + r.missing().size() + ", " + st);
                        for (int[] c : generated) h.assertTrue(!r.missing().contains(new Messages.ChunkXZ(c[0], c[1])), "generated chunk " + c[0] + "," + c[1] + " isn't missing");
                        for (Messages.ChunkXZ m : r.missing())
                            h.assertTrue(level.getChunkSource().getChunkNow(m.cx(), m.cz()) == null, "missing chunk " + m + " wasn't generated");
                        h.assertTrue(level.getChunkSource().getChunkNow(fx, fz) == null, "the saved chunk was read without loading it");
                        MaterialSearch.Stats s = MaterialSearch.lastSearch;
                        h.assertTrue(s != null && s.loaded() >= 1 && s.disk() >= 3 && s.fallback() == 0, "read loaded and from disk: " + s);
                    } finally {
                        level.setChunkForced(fx + 5, fz, false);
                        SelectGrants.clear();
                    }
                })
                .thenSucceed();
    }

    /**
     * Loaded chunks at rings 1, 4 and 7 around a far centre; gap 2, stop 1, one chunk per tick: each
     * search closes one more cluster, a continuation carries on from the ring reached, and every answer
     * covers the whole walk so far. Then the refusals and what ends the walk.
     */
    @GameTest(template = "empty", batch = "y_select_search_more", timeoutTicks = 2400)
    public static void searchStopsEarlyAndContinues(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        int[] f = farChunk();
        int fx = f[0], fz = f[1];
        int[][] hits = {{fx + 1, fz}, {fx + 4, fz + 4}, {fx - 7, fz}};
        for (int[] c : hits) {
            level.getChunk(c[0], c[1]);
            level.setChunkForced(c[0], c[1], true);
        }
        put(level, at(fx + 1, fz, 0, 10, 0), HONEY, null);
        put(level, at(fx + 1, fz, 15, 11, 15), HONEY, null);
        put(level, at(fx + 4, fz + 4, 5, 200, 5), HONEY, null);
        put(level, at(fx - 7, fz, 5, 0, 5), HONEY, null);
        long slice = MaterialSearch.sliceNanos;
        BlockPos centre = at(fx, fz, 8, 64, 8);
        TestExchange[] ex = new TestExchange[6];
        Runnable cleanup = () -> {
            MaterialSearch.sliceNanos = slice;
            for (int[] c : hits) level.setChunkForced(c[0], c[1], false);
            SelectGrants.clear();
            ScanGrants.clear();
            unlink();
        };
        try {
            // Refusals, before any walk.
            SelectGrants.clear();
            ScanGrants.clear();
            refusedWith(h, search(walk(h, List.of(HONEY), 4, null, null, null)), "no_grant");
            SelectGrants.set(level.dimension(), centre, 8);
            refusedWith(h, search(new SelectMessages.SearchRequest(nextId(), "minecraft:the_nether", false, List.of(HONEY), 4, null, null, null)), "wrong_dimension");
            refusedWith(h, search(more(h, null)), "bad_request");
            refusedWith(h, search(walk(h, List.of(HONEY), 4, at(fx + 9, fz, 0, 0, 0), null, null)), "outside_volumes");
        } catch (RuntimeException e) {
            cleanup.run();
            throw e;
        }
        MaterialSearch.sliceNanos = 1;
        int cap = AutosketchConfig.get().select.selectChunks;
        h.startSequence()
                // Asked past selectChunks: clipped. Gap 2, stop 1 (the default): the ring-1 cluster closes after ring 3.
                .thenExecute(() -> ex[0] = search(walk(h, List.of(HONEY), cap + 44, null, 2, null)))
                .thenWaitUntil(() -> done(ex[0]))
                .thenExecute(() -> {
                    logSearch("loaded, stop 1, one chunk per tick");
                    SearchResult r = result(ex[0]);
                    h.assertTrue(r.clipped() && r.radius() == cap, "clipped to selectChunks: " + r.radius());
                    h.assertTrue(r.reached() == 3, "stopped after ring 3: " + r.reached());
                    h.assertTrue(r.clusters().equals(List.of(new SearchCluster(fx + 1, fz, fx + 1, fz, 1, 2, true))), "one closed cluster: " + r.clusters());
                    MaterialSearch.Stats s = MaterialSearch.lastSearch;
                    h.assertTrue(s != null && s.ticks() > 1, "sliced over ticks: " + s);
                    ex[1] = search(more(h, null));
                })
                .thenWaitUntil(() -> done(ex[1]))
                .thenExecute(() -> {
                    logSearch("continue to ring 6");
                    SearchResult r = result(ex[1]);
                    h.assertTrue(r.reached() == 6, "continued to ring 6: " + r.reached());
                    h.assertTrue(r.clusters().equals(List.of(new SearchCluster(fx + 1, fz, fx + 1, fz, 1, 2, true), new SearchCluster(fx + 4, fz + 4, fx + 4, fz + 4, 1, 1, true))),
                            "the whole walk so far: " + r.clusters());
                    assertChunk(h, r, fx + 4, fz + 4, new long[] {1}, 1, new int[] {12});
                    ex[2] = search(more(h, 1));
                })
                .thenWaitUntil(() -> done(ex[2]))
                .thenExecute(() -> {
                    SearchResult r = result(ex[2]);
                    h.assertTrue(r.reached() == 9 && r.clusters().size() == 3 && r.clusters().get(2).closed(), "the ring-7 cluster closes after ring 9: " + r.reached() + " " + r.clusters());
                    h.assertTrue(r.chunks().size() == 3, "chunks outside the grant are skipped: " + r.chunks().size());
                    // A new search replaces the walk.
                    ex[3] = search(walk(h, List.of(KELP), 8, null, null, null));
                })
                .thenWaitUntil(() -> done(ex[3]))
                .thenExecute(() -> {
                    SearchResult r = result(ex[3]);
                    h.assertTrue(r.reached() == 8 && r.clusters().isEmpty() && r.materials().equals(List.of(KELP)), "a miss walks the whole radius: " + r.reached());
                    ex[4] = search(more(h, null));
                })
                .thenWaitUntil(() -> done(ex[4]))
                .thenExecute(() -> {
                    SearchResult r = result(ex[4]);
                    h.assertTrue(r.reached() == 8 && r.materials().equals(List.of(KELP)), "continuing a complete walk answers it again");
                    // A new select request starts without a walk; a scan request ends the grant.
                    SelectGrants.set(level.dimension(), centre, 8);
                    refusedWith(h, search(more(h, null)), "bad_request");
                    ScanGrants.set(level.dimension(), new Messages.ScanGrant(1, false, new Area(0, 0, 15, 15), new Box(0, 0, 0, 1, 1, 1)));
                    h.assertTrue(SelectGrants.current() == null, "a scan grant ends the select grant");
                    refusedWith(h, search(walk(h, List.of(HONEY), 4, null, null, null)), "no_grant");
                    SelectGrants.set(level.dimension(), centre, 8);
                    h.assertTrue(ScanGrants.current() == null, "a select grant ends the scan grant");
                })
                .thenExecute(cleanup)
                .thenSucceed();
    }

    static void done(TestExchange ex) {
        if (!ex.done) throw new GameTestAssertException("waiting for the search");
    }

    static TestExchange blocks(Messages.SnapshotRequest req) {
        return ScanGameTests.blocks(req);
    }

    /**
     * The select grant (13, *Where the mod serves reads*): blocks and surface snapshots anywhere within
     * its square without volumes, ungenerated chunks read as air and listed; over {@code contextCap}
     * {@code too_large}; outside it the usual refusals.
     */
    @GameTest(template = "empty", batch = "y_select_reads", timeoutTicks = 400)
    public static void selectGrantServesReadsInItsSquare(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        unlink();
        ScanGrants.clear();
        int[] f = farChunk();
        int fx = f[0], fz = f[1];
        level.getChunk(fx, fz);
        BlockPos stone = at(fx, fz, 15, 70, 3);
        put(level, stone, HONEY, null);
        SelectGrants.set(level.dimension(), at(fx, fz, 0, 64, 0), 3);
        // Chunk fx and the ungenerated chunk east of it.
        Box two = new Box(stone.getX(), 70, stone.getZ(), stone.getX() + 1, 70, stone.getZ());
        TestExchange in = blocks(new Messages.SnapshotRequest(nextId(), dim(h), List.of(two), null));
        Box over = new Box((fx - 3) << 4, level.getMinBuildHeight(), (fz - 3) << 4, ((fx + 3) << 4) + 15, level.getMaxBuildHeight() - 1, ((fz + 3) << 4) + 15);
        TestExchange tooLarge = blocks(new Messages.SnapshotRequest(nextId(), dim(h), List.of(over), null));
        Box outside = new Box((fx + 4) << 4, 70, fz << 4, (fx + 4) << 4, 70, fz << 4);
        TestExchange out = blocks(new Messages.SnapshotRequest(nextId(), dim(h), List.of(outside), null));
        TestExchange surface = ScanGameTests.surface(new Messages.SurfaceRequest(nextId(), dim(h), new Area(stone.getX(), stone.getZ(), stone.getX() + 1, stone.getZ()), null));
        h.succeedWhen(() -> {
            if (!in.done || !tooLarge.done || !out.done || !surface.done) throw new GameTestAssertException("waiting for the replies");
            try {
                h.assertTrue(in.errorCode == null, "a blocks snapshot inside the select grant is served without volumes: " + in.errorCode);
                Messages.SnapshotResult r = Messages.SnapshotResult.decode(in.reply);
                List<String> pal = r.palette();
                int[] st = r.regions().get(0).states();
                h.assertTrue(pal.get(st[0]).equals(HONEY) && pal.get(st[1]).equals("minecraft:air"), "the block, then air in the ungenerated chunk: " + pal);
                h.assertTrue(List.of(new Messages.ChunkXZ(fx + 1, fz)).equals(r.missing()), "the ungenerated chunk is listed: " + r.missing());
                h.assertTrue(level.getChunkSource().getChunkNow(fx + 1, fz) == null, "and still not generated");
                refusedWith(h, tooLarge, "too_large");
                refusedWith(h, out, "no_volumes");
                Messages.SurfaceResult s = ScanGameTests.result(surface);
                h.assertTrue(s.missing().equals(List.of(new Messages.ChunkXZ(fx + 1, fz))) && s.palette().get(s.surface().states()[0]).equals(HONEY), "surface inside the grant: " + s.missing());
            } catch (ProtocolException e) {
                throw new GameTestAssertException("undecodable snapshot: " + e.getMessage());
            } finally {
                SelectGrants.clear();
            }
        });
    }
}
