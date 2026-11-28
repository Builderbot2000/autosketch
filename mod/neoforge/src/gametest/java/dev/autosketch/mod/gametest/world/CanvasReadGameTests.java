package dev.autosketch.mod.gametest.world;

import static dev.autosketch.mod.gametest.world.SelectGameTests.HONEY;
import static dev.autosketch.mod.gametest.world.SelectGameTests.at;
import static dev.autosketch.mod.gametest.world.SelectGameTests.farChunk;
import static dev.autosketch.mod.gametest.world.SelectGameTests.refusedWith;
import static dev.autosketch.mod.gametest.world.WorldTestKit.box;
import static dev.autosketch.mod.gametest.world.WorldTestKit.dim;
import static dev.autosketch.mod.gametest.world.WorldTestKit.link;
import static dev.autosketch.mod.gametest.world.WorldTestKit.nextId;
import static dev.autosketch.mod.gametest.world.WorldTestKit.put;
import static dev.autosketch.mod.gametest.world.WorldTestKit.unlink;

import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.gametest.world.WorldTestKit.TestExchange;
import dev.autosketch.mod.protocol.Area;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.SelectMessages;
import dev.autosketch.mod.volume.CanvasManager;
import dev.autosketch.mod.volume.VolumeManager;
import dev.autosketch.mod.world.SelectGrants;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * Reads inside the canvas (13, *Reads inside the canvas*; 19, *Model*; briefs/canvas/K, K1): with a
 * work volume set near the test and the canvas far away, the canvas serves blocks, coarse and surface
 * snapshots, {@code search} (centred on its middle chunk without {@code around}) and {@code fill},
 * from disk, without generating chunks and with no select request open; section hashes stay inside
 * the volumes; outside both, {@code outside_volumes}. The mode doesn't enter: the mod serves the same
 * whatever request is open. The canvas is global, so this runs in its own batch and clears it.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class CanvasReadGameTests {
    private CanvasReadGameTests() {}

    static TestExchange blocks(Messages.SnapshotRequest req) {
        return SurfaceGameTests.blocks(req);
    }

    @GameTest(template = "empty", batch = "k_canvas_reads", timeoutTicks = 600)
    public static void canvasServesReadsFarFromTheWorkVolume(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        CanvasManager canvas = AutosketchMod.internals().canvas();
        SelectGrants.clear();
        int[] f = farChunk();
        int fx = f[0], fz = f[1];
        level.getChunk(fx, fz);
        BlockPos honey = at(fx, fz, 15, 70, 3);
        put(level, honey, HONEY, null);
        link(h, box(h, 0, 1, 0, 3, 3, 3));
        Box widened;
        try {
            // Chunks fx..fx+1 by fz..fz: chunk fx+1 is never generated.
            widened = canvas.set(level, new Box(fx << 4, 64, fz << 4, ((fx + 1) << 4) + 3, 70, (fz << 4) + 9));
        } catch (VolumeManager.Refused e) {
            throw new GameTestAssertException("a two-chunk canvas is refused: " + e.getMessage());
        }
        h.assertTrue(widened.equals(new Box(fx << 4, level.getMinBuildHeight(), fz << 4, ((fx + 1) << 4) + 15, level.getMaxBuildHeight() - 1, (fz << 4) + 15)),
                "widened to whole chunk columns and the full build height: " + widened);
        Box two = new Box(honey.getX(), 70, honey.getZ(), honey.getX() + 1, 70, honey.getZ());
        TestExchange in = blocks(new Messages.SnapshotRequest(nextId(), dim(h), List.of(two), null));
        Box outsideBox = new Box((fx + 2) << 4, 70, fz << 4, (fx + 2) << 4, 70, fz << 4);
        TestExchange out = blocks(new Messages.SnapshotRequest(nextId(), dim(h), List.of(outsideBox), null));
        TestExchange coarse = MaskCoarseGameTests.coarse(new SelectMessages.CoarseSnapshotRequest(nextId(), dim(h), 4, List.of(new Box((fx << 4) + 12, 68, fz << 4, (fx << 4) + 15, 71, (fz << 4) + 3))));
        TestExchange surface = SurfaceGameTests.surface(new Messages.SurfaceRequest(nextId(), dim(h), new Area(honey.getX(), honey.getZ(), honey.getX() + 1, honey.getZ()), null));
        TestExchange hashes = ReadGameTests.hashes(new Messages.HashesRequest(nextId(), dim(h), List.of(two)));
        TestExchange search = SelectGameTests.search(new SelectMessages.SearchRequest(nextId(), dim(h), false, List.of(HONEY), 1, null, 1, 1));
        TestExchange fill = FillGameTests.fill(new SelectMessages.FillRequest(nextId(), dim(h), honey, List.of(HONEY), null, null, null));
        TestExchange fillOut = FillGameTests.fill(new SelectMessages.FillRequest(nextId(), dim(h), at(fx + 2, fz, 0, 70, 0), List.of(HONEY), null, null, null));
        h.succeedWhen(() -> {
            for (TestExchange ex : List.of(in, out, coarse, surface, hashes, search, fill, fillOut))
                if (!ex.done) throw new GameTestAssertException("waiting for the replies");
            try {
                h.assertTrue(in.errorCode == null, "a blocks snapshot inside the canvas is served far from the work volume: " + in.errorCode);
                Messages.SnapshotResult r = Messages.SnapshotResult.decode(in.reply);
                int[] st = r.regions().get(0).states();
                h.assertTrue(r.palette().get(st[0]).equals(HONEY) && r.palette().get(st[1]).equals("minecraft:air"), "the block, then air in the ungenerated chunk: " + r.palette());
                h.assertTrue(List.of(new Messages.ChunkXZ(fx + 1, fz)).equals(r.missing()), "the ungenerated chunk is listed: " + r.missing());
                h.assertTrue(level.getChunkSource().getChunkNow(fx + 1, fz) == null, "and still not generated");
                refusedWith(h, out, "outside_volumes");
                h.assertTrue(coarse.errorCode == null, "a coarse snapshot inside the canvas: " + coarse.errorCode);
                SelectMessages.CoarseResult cr = SelectMessages.CoarseResult.decode(coarse.reply);
                h.assertTrue(cr.palette().contains(HONEY), "the coarse cell holds the honey: " + cr.palette());
                Messages.SurfaceResult s = SurfaceGameTests.result(surface);
                h.assertTrue(s.missing().equals(List.of(new Messages.ChunkXZ(fx + 1, fz))) && s.palette().get(s.surface().states()[0]).equals(HONEY), "surface inside the canvas: " + s.missing());
                refusedWith(h, hashes, "outside_volumes");
                SelectMessages.SearchResult sr = SelectGameTests.result(search);
                SelectGameTests.chunk(sr, fx, fz);
                h.assertTrue(FillGameTests.result(fill).count() == 1, "a fill seeded inside the canvas finds the one block");
                refusedWith(h, fillOut, "outside_volumes");
            } catch (ProtocolException e) {
                throw new GameTestAssertException("undecodable reply: " + e.getMessage());
            } finally {
                canvas.clear();
                unlink();
            }
        });
    }

    /** Without a canvas or a select request, search and fill are {@code no_grant} again; clearing the canvas ends its reads. */
    @GameTest(template = "empty", batch = "k_canvas_reads_cleared", timeoutTicks = 200)
    public static void clearingTheCanvasEndsItsReads(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        CanvasManager canvas = AutosketchMod.internals().canvas();
        SelectGrants.clear();
        unlink();
        int[] f = farChunk();
        int fx = f[0], fz = f[1];
        try {
            canvas.set(level, new Box(fx << 4, 0, fz << 4, fx << 4, 0, fz << 4));
        } catch (VolumeManager.Refused e) {
            throw new GameTestAssertException(e.getMessage());
        }
        canvas.clear();
        TestExchange search = SelectGameTests.search(new SelectMessages.SearchRequest(nextId(), dim(h), false, List.of(HONEY), 1, null, 1, 1));
        TestExchange blocks = blocks(new Messages.SnapshotRequest(nextId(), dim(h), List.of(new Box(fx << 4, 70, fz << 4, fx << 4, 70, fz << 4)), null));
        h.succeedWhen(() -> {
            if (!search.done || !blocks.done) throw new GameTestAssertException("waiting for the replies");
            refusedWith(h, search, "no_grant");
            refusedWith(h, blocks, "no_volumes");
        });
    }
}
