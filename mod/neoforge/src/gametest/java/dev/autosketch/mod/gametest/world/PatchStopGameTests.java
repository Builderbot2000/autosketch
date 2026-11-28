package dev.autosketch.mod.gametest.world;

import static dev.autosketch.mod.gametest.world.WorldTestKit.block;
import static dev.autosketch.mod.gametest.world.WorldTestKit.link;
import static dev.autosketch.mod.gametest.world.WorldTestKit.patch;
import static dev.autosketch.mod.gametest.world.WorldTestKit.print;
import static dev.autosketch.mod.gametest.world.WorldTestKit.unlink;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.gametest.world.WorldTestKit.TestExchange;
import dev.autosketch.mod.protocol.BodyTypes.PatchBlock;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.world.WorldModule;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * Stop on the mod side (19, *Stop*, step 2; briefs/canvas/G, deliverable 4): the patches the mod
 * hasn't started are dropped, each answered with an {@code error} so the MCP isn't left waiting, and
 * the patch in progress finishes and acks in full, as on a disconnect (13, step 7).
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class PatchStopGameTests {
    private PatchStopGameTests() {}

    static void fail(String what) {
        unlink();
        throw new GameTestAssertException(what);
    }

    @GameTest(template = "empty", batch = "g_stop_patches", timeoutTicks = 200)
    public static void stopDropsUnstartedPatchesAndFinishesTheOneInProgress(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        BlockPos base = h.absolutePos(new BlockPos(0, 20, 0));
        LinkVolumes v = link(h, dev.autosketch.mod.protocol.Box.of(base, base.offset(19, 9, 19)));
        WorldModule.budgetOverride = 500;
        List<PatchBlock> first = new ArrayList<>();
        for (int y = 0; y < 10; y++) for (int z = 0; z < 20; z++) for (int x = 0; x < 20; x++) {
            BlockPos p = base.offset(x, y, z);
            first.add(block(p, print(level, p), "minecraft:stone"));
        }
        BlockPos q = base.offset(0, 9, 0);
        String before = print(level, base.offset(0, 0, 0));
        TestExchange a = patch(v, first);
        TestExchange b = patch(v, List.of(block(q, "minecraft:stone", "minecraft:gold_block")));
        TestExchange c = patch(v, List.of(block(base, "minecraft:stone", "minecraft:diamond_block")));
        if (a.done || Autosketch.patchStatus().pending() != 3) fail("three patches pending, the first in progress: " + Autosketch.patchStatus().pending());
        if (before.equals("minecraft:stone") || !print(level, base).equals("minecraft:stone")) fail("the first patch is part-way");
        int dropped = WorldModule.services().patches().dropUnstarted(dev.autosketch.mod.protocol.ErrorCodes.DROPPED, "the request was stopped");
        if (dropped != 2) fail("two unstarted patches dropped, got " + dropped);
        if (!b.done || !c.done || b.errorCode == null || c.errorCode == null || !b.errorCode.startsWith(dev.autosketch.mod.protocol.ErrorCodes.DROPPED + ":") || !c.errorCode.startsWith(dev.autosketch.mod.protocol.ErrorCodes.DROPPED + ":")) fail("each dropped patch answered with an error: " + b.errorCode + " / " + c.errorCode);
        if (a.done || Autosketch.patchStatus().pending() != 1) fail("the patch in progress keeps going: pending " + Autosketch.patchStatus().pending());
        h.succeedWhen(() -> {
            if (!a.done) throw new GameTestAssertException("waiting for the first patch");
            Messages.PatchAck ack = a.ack();
            if (ack.applied() != 4000) fail("the patch in progress finished in full: " + ack.applied());
            if (!print(level, q).equals("minecraft:stone") || !print(level, base).equals("minecraft:stone")) fail("the dropped patches wrote nothing");
            if (Autosketch.patchStatus().pending() != 0) fail("nothing pending");
            List<PatchBlock> clear = new ArrayList<>();
            for (PatchBlock p : first) clear.add(block(p.pos(), "minecraft:stone", "minecraft:air"));
            WorldModule.budgetOverride = 1_000_000;
            patch(v, clear);
            unlink();
        });
    }
}
