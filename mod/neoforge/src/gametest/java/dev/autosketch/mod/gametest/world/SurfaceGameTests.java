package dev.autosketch.mod.gametest.world;

import static dev.autosketch.mod.gametest.world.WorldTestKit.box;
import static dev.autosketch.mod.gametest.world.WorldTestKit.dim;
import static dev.autosketch.mod.gametest.world.WorldTestKit.unlink;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.gametest.world.WorldTestKit.TestExchange;
import dev.autosketch.mod.protocol.Area;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.world.States;
import dev.autosketch.mod.world.SurfaceReads;
import dev.autosketch.mod.world.WorldModule;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.levelgen.Heightmap;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;
import org.slf4j.Logger;

/**
 * Surface snapshots inside the volumes and {@code volumes.set} (13, B4), mod side. Surface reads
 * inside the select grant are {@link SelectGameTests}'; the scan grant was removed with
 * {@code /autosketch scan} (18, *Removal*).
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class SurfaceGameTests {
    private SurfaceGameTests() {}

    private static final Logger LOG = LogUtils.getLogger();

    static TestExchange surface(Messages.SurfaceRequest req) {
        TestExchange ex = new TestExchange(req.id());
        try {
            WorldModule.surface().surface(Messages.SurfaceRequest.decode(req.encode()), ex);
        } catch (ProtocolException e) {
            ex.error(e.code(), e.getMessage());
        }
        return ex;
    }

    static TestExchange blocks(Messages.SnapshotRequest req) {
        TestExchange ex = new TestExchange(req.id());
        try {
            WorldModule.services().reads().snapshot(Messages.SnapshotRequest.decode(req.encode()), ex);
        } catch (ProtocolException e) {
            ex.error(e.code(), e.getMessage());
        }
        return ex;
    }

    static Messages.SurfaceResult result(TestExchange ex) {
        if (ex.errorCode != null) throw new GameTestAssertException("refused: " + ex.errorCode);
        try {
            return Messages.SurfaceResult.decode(ex.reply);
        } catch (ProtocolException e) {
            throw new GameTestAssertException("undecodable surface result: " + e.getMessage());
        }
    }

    @GameTest(template = "empty", batch = "y_surface_reads", timeoutTicks = 200)
    public static void surfaceServedInsideTheVolumes(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        unlink();
        var vm = AutosketchMod.internals().volumes();
        vm.clear();
        BlockPos o = h.absolutePos(BlockPos.ZERO);
        // Column (1, 1): stone on top of the template. Column (0, 0): stone at the bottom and planks at the top, a cave between.
        h.setBlock(new BlockPos(1, 2, 1), Blocks.STONE);
        h.setBlock(new BlockPos(0, 0, 0), Blocks.STONE);
        h.setBlock(new BlockPos(0, 2, 0), Blocks.OAK_PLANKS);
        Area area = new Area(o.getX(), o.getZ(), o.getX() + 2, o.getZ() + 2);
        int ceiling = o.getY() + 1;

        TestExchange none = surface(new Messages.SurfaceRequest(WorldTestKit.nextId(), dim(h), area, null));
        h.assertTrue(none.errorCode != null && none.errorCode.startsWith("no_volumes"), "without volumes or a select grant: no_volumes, got " + none.errorCode);

        try {
            vm.setFromAgent(1, dim(h), box(h, 0, 0, 0, 2, 2, 2), null);
        } catch (ProtocolException e) {
            throw new GameTestAssertException("volumes.set refused: " + e.code());
        }
        TestExchange near = surface(new Messages.SurfaceRequest(WorldTestKit.nextId(), dim(h), area, ceiling));
        TestExchange outside = surface(new Messages.SurfaceRequest(WorldTestKit.nextId(), dim(h), new Area(o.getX() - 64, o.getZ(), o.getX(), o.getZ()), null));
        h.succeedWhen(() -> {
            if (!near.done || !outside.done) throw new GameTestAssertException("waiting for the replies");
            try {
                Messages.SurfaceResult r = result(near);
                int minY = level.getMinBuildHeight();
                h.assertTrue(r.minY() == minY && r.missing().isEmpty() && r.ceiling() == ceiling && r.ceilings() != null, "header: " + r);
                for (int dz = 0; dz < 3; dz++)
                    for (int dx = 0; dx < 3; dx++) {
                        int i = dx + 3 * dz, x = o.getX() + dx, z = o.getZ() + dz;
                        int top = level.getHeight(Heightmap.Types.WORLD_SURFACE, x, z) - 1;
                        h.assertTrue(r.surface().heights()[i] == top - minY + 1, "column " + dx + "," + dz + " height");
                        String st = States.print(level.getBlockState(new BlockPos(x, top, z)));
                        h.assertTrue(r.palette().get(r.surface().states()[i]).equals(st), "column " + dx + "," + dz + " state " + st);
                    }
                int i11 = 1 + 3, i00 = 0;
                h.assertTrue(r.surface().heights()[i11] == o.getY() + 2 - minY + 1 || level.getHeight(Heightmap.Types.WORLD_SURFACE, o.getX() + 1, o.getZ() + 1) - 1 > o.getY() + 2,
                        "the stone on top of column 1,1 is its surface");
                h.assertTrue(r.ceilings().heights()[i00] == o.getY() + 2 - minY + 1 && r.palette().get(r.ceilings().states()[i00]).equals("minecraft:oak_planks"),
                        "column 0,0's ceiling above y " + ceiling + " is the planks: " + r.ceilings().heights()[i00]);
                h.assertTrue(outside.errorCode != null && outside.errorCode.startsWith("outside_volumes"), "columns outside the volumes' chunks: outside_volumes, got " + outside.errorCode);
            } finally {
                vm.clear();
                unlink();
            }
        });
    }

    @GameTest(template = "empty", batch = "y_volumes_set")
    public static void volumesSetActsAsThePlayer(GameTestHelper h) throws Exception {
        var vm = AutosketchMod.internals().volumes();
        vm.clear();
        Box work = box(h, 0, 0, 0, 2, 2, 2);
        long before = vm.link();
        vm.setFromAgent(1, dim(h), work, null);
        LinkVolumes v = Autosketch.link().current();
        h.assertTrue(v != null && v.work().equals(work) && v.link() == before + 1, "a new work volume, a new link: " + v);
        h.assertTrue(v.context().equals(List.of(work.grow(3))), "the default context: " + v.context());

        Box ref = box(h, 20, 0, 0, 24, 3, 4);
        vm.setFromAgent(2, dim(h), work, List.of(ref));
        v = Autosketch.link().current();
        h.assertTrue(v.link() == before + 1, "the same work volume keeps the link");
        h.assertTrue(v.context().equals(List.of(work.grow(1), ref)), "the seam box leads the given context: " + v.context());
        vm.setFromAgent(3, dim(h), work, List.of(work.grow(2), ref));
        h.assertTrue(Autosketch.link().current().context().equals(List.of(work.grow(2), ref)), "no seam box added when a given box covers it");

        refused(h, () -> vm.setFromAgent(4, dim(h), work, List.of(work.grow(200))), "bad_volumes");
        refused(h, () -> vm.setFromAgent(5, dim(h), new Box(work.minX(), 400, work.minZ(), work.maxX(), 410, work.maxZ()), null), "bad_volumes");
        refused(h, () -> vm.setFromAgent(6, "autosketch:nowhere", work, null), "wrong_dimension");
        h.assertTrue(Autosketch.link().current().context().equals(List.of(work.grow(2), ref)), "refusals change nothing");

        // The player marking a new work volume afterwards starts from the default context again.
        var level = h.getLevel();
        vm.setWork(level, work.grow(1));
        h.assertTrue(Autosketch.link().current().context().equals(List.of(work.grow(4))), "a player's new work volume gets the default context: " + Autosketch.link().current().context());
        vm.clear();
        h.succeed();
    }

    interface Call {
        void run() throws Exception;
    }

    static void refused(GameTestHelper h, Call c, String code) {
        try {
            c.run();
            h.fail("expected " + code);
        } catch (ProtocolException e) {
            h.assertTrue(e.code().equals(code), "expected " + code + ", got " + e.code());
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /** Logs the cost of the last surface read (measurements on a real world are in 13, *Measured on Craftoria*). */
    static void logStats() {
        SurfaceReads.Stats s = SurfaceReads.lastRead;
        if (s != null) LOG.info("Autosketch surface read: {}", s);
    }
}
