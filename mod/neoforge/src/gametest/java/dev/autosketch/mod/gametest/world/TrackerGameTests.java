package dev.autosketch.mod.gametest.world;

import static dev.autosketch.mod.gametest.world.WorldTestKit.block;
import static dev.autosketch.mod.gametest.world.WorldTestKit.box;
import static dev.autosketch.mod.gametest.world.WorldTestKit.link;
import static dev.autosketch.mod.gametest.world.WorldTestKit.patch;
import static dev.autosketch.mod.gametest.world.WorldTestKit.put;
import static dev.autosketch.mod.gametest.world.WorldTestKit.unlink;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.protocol.BodyTypes.WorldBlock;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.world.ChangeTracker;
import dev.autosketch.mod.world.WorldModule;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.piston.PistonBaseBlock;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * The change tracker in a running game (13, *World → agent*; M9): a piston push in the work volume
 * and a block broken in the context each produce a {@code dirty}; a change outside both volumes and
 * the mod's own writes don't. Run with the hook and with the scan.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class TrackerGameTests {
    private TrackerGameTests() {}

    /** Captures dirty notices; restores the bridge sink when done. */
    static final class Capture implements AutoCloseable {
        final List<Messages.Dirty> notices = new CopyOnWriteArrayList<>();
        private final Consumer<Frame> prev;

        Capture() {
            prev = WorldModule.services().tracker().sink(f -> {
                try {
                    notices.add(Messages.Dirty.decode(f));
                } catch (ProtocolException e) {
                    throw new IllegalStateException(e);
                }
            });
        }

        boolean reported(BlockPos p) {
            for (Messages.Dirty d : notices) {
                if (d.everything()) return true;
                for (WorldBlock b : d.blocks()) if (b.pos().equals(p)) return true;
            }
            return false;
        }

        @Override
        public void close() {
            WorldModule.services().tracker().sink(prev);
        }
    }

    static void run(GameTestHelper h, ChangeTracker.Mode mode) {
        ServerLevel level = h.getLevel();
        WorldModule.modeOverride = mode;
        for (int x = -6; x <= 8; x++) for (int y = 0; y <= 4; y++) for (int z = -1; z <= 3; z++) put(level, h.absolutePos(new BlockPos(x, y, z)), "minecraft:air", null);
        BlockPos pistonPos = h.absolutePos(new BlockPos(0, 1, 1));
        BlockPos pushed = h.absolutePos(new BlockPos(1, 1, 1));
        BlockPos ctxBlock = h.absolutePos(new BlockPos(-2, 1, 1)); // context only
        BlockPos outside = h.absolutePos(new BlockPos(8, 1, 1));   // beyond work + 3
        put(level, pistonPos, "minecraft:piston[extended=false,facing=east]", null);
        put(level, pushed, "minecraft:stone", null);
        put(level, ctxBlock, "minecraft:stone", null);
        put(level, outside, "minecraft:stone", null);
        LinkVolumes v = link(h, box(h, 0, 0, 0, 4, 2, 2));
        Capture cap = new Capture();
        int[] step = {0};
        h.runAfterDelay(mode == ChangeTracker.Mode.HOOK ? 2 : 25, () -> {
            // The mod's own write: never reported.
            patch(v, List.of(block(h.absolutePos(new BlockPos(3, 2, 2)), "minecraft:air", "minecraft:gold_block")));
            // Piston push in the work volume (a redstone block powers it), a block broken in the
            // context, and a change outside both volumes.
            level.setBlockAndUpdate(pistonPos.below(), Blocks.REDSTONE_BLOCK.defaultBlockState());
            level.destroyBlock(ctxBlock, false);
            level.setBlockAndUpdate(outside, Blocks.DIRT.defaultBlockState());
        });
        h.runAfterDelay(mode == ChangeTracker.Mode.HOOK ? 10 : 75, () -> {
            try {
                if (!level.getBlockState(pistonPos).getValue(PistonBaseBlock.EXTENDED)) throw new GameTestAssertException("piston didn't extend");
                if (!cap.reported(pushed.relative(Direction.EAST)) || !cap.reported(pushed)) throw new GameTestAssertException("piston push not reported: " + cap.notices);
                if (!cap.reported(ctxBlock)) throw new GameTestAssertException("context break not reported: " + cap.notices);
                for (Messages.Dirty d : cap.notices) {
                    if (d.everything()) throw new GameTestAssertException("unexpected everything");
                    for (WorldBlock b : d.blocks()) {
                        if (b.pos().equals(outside)) throw new GameTestAssertException("a change outside both volumes was reported");
                        if (b.pos().equals(h.absolutePos(new BlockPos(3, 2, 2)))) throw new GameTestAssertException("the mod's own write was reported");
                        if (!v.contains(b.pos())) throw new GameTestAssertException("reported outside the volumes: " + b.pos());
                    }
                }
                // The notice carries the state at the end of the tick.
                boolean sawHead = false;
                for (Messages.Dirty d : cap.notices) for (WorldBlock b : d.blocks()) if (b.pos().equals(pushed.relative(Direction.EAST)) && b.state().equals("minecraft:stone")) sawHead = true;
                if (!sawHead) throw new GameTestAssertException("pushed block's new state not reported: " + cap.notices);
            } finally {
                cap.close();
                unlink();
            }
            h.succeed();
        });
    }

    @GameTest(template = "empty", batch = "o_track_hook", timeoutTicks = 100)
    public static void hookReportsChangesInsideVolumesOnly(GameTestHelper h) {
        run(h, ChangeTracker.Mode.HOOK);
    }

    @GameTest(template = "empty", batch = "o_track_scan", timeoutTicks = 120)
    public static void scanReportsChangesInsideVolumesOnly(GameTestHelper h) {
        run(h, ChangeTracker.Mode.SCAN);
    }

    @GameTest(template = "empty", batch = "o_track_cap", timeoutTicks = 40)
    public static void moreThanTheCapSendsEverything(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        BlockPos base = h.absolutePos(new BlockPos(0, 10, 0));
        LinkVolumes v = link(h, dev.autosketch.mod.protocol.Box.of(base, base.offset(20, 10, 20)));
        Capture cap = new Capture();
        h.runAfterDelay(1, () -> {
            for (int y = 0; y < 11; y++) for (int z = 0; z < 21; z++) for (int x = 0; x < 21; x++)
                level.setBlock(base.offset(x, y, z), Blocks.GLASS.defaultBlockState(), 2);
        });
        h.runAfterDelay(4, () -> {
            try {
                if (cap.notices.size() != 1 || !cap.notices.get(0).everything()) throw new GameTestAssertException("expected one everything notice, got " + cap.notices.size());
            } finally {
                for (int y = 0; y < 11; y++) for (int z = 0; z < 21; z++) for (int x = 0; x < 21; x++) put(level, base.offset(x, y, z), "minecraft:air", null);
                cap.close();
                unlink();
            }
            if (v.link() == 0) throw new GameTestAssertException("unreachable");
            h.succeed();
        });
    }
}
