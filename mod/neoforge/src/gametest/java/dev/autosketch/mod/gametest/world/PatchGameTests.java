package dev.autosketch.mod.gametest.world;

import static dev.autosketch.mod.gametest.world.WorldTestKit.block;
import static dev.autosketch.mod.gametest.world.WorldTestKit.box;
import static dev.autosketch.mod.gametest.world.WorldTestKit.link;
import static dev.autosketch.mod.gametest.world.WorldTestKit.patch;
import static dev.autosketch.mod.gametest.world.WorldTestKit.print;
import static dev.autosketch.mod.gametest.world.WorldTestKit.put;
import static dev.autosketch.mod.gametest.world.WorldTestKit.snbt;
import static dev.autosketch.mod.gametest.world.WorldTestKit.unlink;

import com.google.gson.JsonParser;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.gametest.world.WorldTestKit.TestExchange;
import dev.autosketch.mod.protocol.BodyTypes.PatchBlock;
import dev.autosketch.mod.protocol.BodyTypes.Rejected;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.world.Hashing;
import dev.autosketch.mod.world.VolatileKeys;
import dev.autosketch.mod.world.WorldBlocks;
import dev.autosketch.mod.world.WorldModule;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.entity.ChestBlockEntity;
import net.minecraft.world.phys.AABB;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * The patch applier in a running game (13, *Applying a patch*; M5–M7). Each test has its own batch,
 * so tests run one after another: they share the global link volumes.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class PatchGameTests {
    private PatchGameTests() {}

    static VolatileKeys defaults() {
        return VolatileKeys.parse(JsonParser.parseString(WorldTestKit.DEFAULT_VOLATILE).getAsJsonObject());
    }

    static void check(GameTestHelper h, boolean ok, String what) {
        if (!ok) {
            unlink();
            h.fail(what);
        }
    }

    @GameTest(template = "empty", batch = "o_match")
    public static void matchingExpectedStateWrites(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        LinkVolumes v = link(h, box(h, 0, 0, 0, 2, 2, 2));
        BlockPos p = h.absolutePos(new BlockPos(1, 1, 1));
        put(level, p, "minecraft:air", null);
        TestExchange ex = patch(v, List.of(block(p, "minecraft:air", "minecraft:stone")));
        check(h, ex.done, "a one-block patch is acked in the same tick");
        Messages.PatchAck ack = ex.ack();
        check(h, ack.applied() == 1 && ack.lists().skipped().isEmpty() && ack.lists().rejected().isEmpty(), "applied 1: " + ack);
        check(h, print(level, p).equals("minecraft:stone"), "stone written");
        check(h, Autosketch.patchStatus().last() != null && Autosketch.patchStatus().last().id() == ack.id(), "status shows the last patch");
        unlink();
        h.succeed();
    }

    @GameTest(template = "empty", batch = "o_mismatch")
    public static void mismatchSkipsAndReportsActualState(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        LinkVolumes v = link(h, box(h, 0, 0, 0, 2, 2, 2));
        BlockPos p = h.absolutePos(new BlockPos(1, 1, 1));
        put(level, p, "minecraft:oak_log[axis=x]", null); // the player's hand edit
        Messages.PatchAck ack = patch(v, List.of(block(p, "minecraft:air", "minecraft:stone"))).ack();
        check(h, ack.applied() == 0 && ack.lists().skipped().size() == 1, "skipped: " + ack);
        check(h, ack.lists().skipped().get(0).state().equals("minecraft:oak_log[axis=x]"), "actual state reported");
        check(h, print(level, p).equals("minecraft:oak_log[axis=x]"), "the hand edit is untouched");

        // force writes it anyway and counts it as overwritten.
        Messages.PatchAck forced = patch(v, true, List.of(block(p, "minecraft:air", "minecraft:stone")), WorldTestKit.session()).ack();
        check(h, forced.applied() == 1 && forced.overwritten() == 1 && forced.lists().skipped().isEmpty(), "forced: " + forced);
        check(h, print(level, p).equals("minecraft:stone"), "forced write");
        unlink();
        h.succeed();
    }

    @GameTest(template = "empty", batch = "o_chest")
    public static void chestWithChangedItemsIsSkippedByNbtHash(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        LinkVolumes v = link(h, box(h, 0, 0, 0, 2, 2, 2));
        BlockPos p = h.absolutePos(new BlockPos(1, 1, 1));
        String chest = "minecraft:chest[facing=north,type=single,waterlogged=false]";
        put(level, p, chest, snbt("{id:\"minecraft:chest\",Items:[{Slot:0b,count:3,id:\"minecraft:oak_planks\"}]}"));
        long cached = Hashing.nbtHash(WorldBlocks.nbtAt(level, p), defaults());
        // The player swaps the contents; the state stays the same.
        ((ChestBlockEntity) level.getBlockEntity(p)).setItem(0, new ItemStack(Items.DIAMOND, 2));
        Messages.PatchAck ack = patch(v, List.of(new PatchBlock(p, chest, "minecraft:stone", cached, null))).ack();
        check(h, ack.applied() == 0 && ack.lists().skipped().size() == 1, "skipped by NBT hash: " + ack);
        CompoundTag actual = ack.lists().skipped().get(0).nbt();
        check(h, actual != null && actual.toString().contains("minecraft:diamond"), "actual NBT reported: " + actual);
        check(h, print(level, p).equals(chest), "chest untouched");

        // With the hash of what the world now holds, the patch applies.
        long now = Hashing.nbtHash(WorldBlocks.nbtAt(level, p), defaults());
        Messages.PatchAck ok = patch(v, List.of(new PatchBlock(p, chest, "minecraft:air", now, null))).ack();
        check(h, ok.applied() == 1, "applied with the current hash: " + ok);
        unlink();
        h.succeed();
    }

    @GameTest(template = "empty", batch = "o_furnace")
    public static void litFurnaceWhoseBurnTimeTickedIsNotSkipped(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        LinkVolumes v = link(h, box(h, 0, 0, 0, 2, 2, 2));
        BlockPos p = h.absolutePos(new BlockPos(1, 1, 1));
        String furnace = "minecraft:furnace[facing=north,lit=true]";
        put(level, p, furnace, snbt("{id:\"minecraft:furnace\",BurnTime:200s,CookTime:10s,CookTimeTotal:200s,Items:[{Slot:1b,count:8,id:\"minecraft:coal\"}]}"));
        long cached = Hashing.nbtHash(WorldBlocks.nbtAt(level, p), defaults());
        // Burn time ticks on its own.
        level.getBlockEntity(p).loadWithComponents(snbt("{id:\"minecraft:furnace\",BurnTime:150s,CookTime:60s,CookTimeTotal:200s,Items:[{Slot:1b,count:8,id:\"minecraft:coal\"}]}"), level.registryAccess());
        check(h, !WorldBlocks.nbtAt(level, p).equals(snbt("{}")), "furnace has NBT");
        Messages.PatchAck ack = patch(v, List.of(new PatchBlock(p, furnace, "minecraft:stone", cached, null))).ack();
        check(h, ack.applied() == 1 && ack.lists().skipped().isEmpty(), "volatile keys ignored: " + ack);
        check(h, print(level, p).equals("minecraft:stone"), "written");
        unlink();
        h.succeed();
    }

    @GameTest(template = "empty", batch = "o_unknown")
    public static void unknownStatesAreRejectedNeverAir(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        LinkVolumes v = link(h, box(h, 0, 0, 0, 2, 2, 2));
        String[] bad = {"minecraft:not_a_block", "minecraft:stone[foo=bar]", "stone", "minecraft:oak_log", "minecraft:oak_log[axis=q]",
                "minecraft:oak_log[ axis=x]", "minecraft:cave_air", "minecraft:oak_stairs[half=bottom,facing=east,shape=straight,waterlogged=false]"};
        List<PatchBlock> blocks = new ArrayList<>();
        for (int i = 0; i < bad.length; i++) {
            BlockPos p = h.absolutePos(new BlockPos(i % 3, i / 3, 0));
            put(level, p, "minecraft:stone", null);
            blocks.add(block(p, "minecraft:stone", bad[i]));
        }
        Messages.PatchAck ack = patch(v, blocks).ack();
        check(h, ack.applied() == 0 && ack.lists().rejected().size() == bad.length, "all rejected: " + ack);
        for (Rejected r : ack.lists().rejected()) check(h, r.reason().equals("unknown_state"), "reason " + r);
        for (PatchBlock b : blocks) check(h, print(level, b.pos()).equals("minecraft:stone"), "untouched at " + b.pos());
        unlink();
        h.succeed();
    }

    @GameTest(template = "empty", batch = "o_volumes")
    public static void contextStaleAndBadNbtAreRejected(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        LinkVolumes v = link(h, box(h, 0, 0, 0, 2, 2, 2));
        BlockPos inCtx = h.absolutePos(new BlockPos(-1, 1, 1)); // in the context (work grown by 3), not the work
        BlockPos outside = h.absolutePos(new BlockPos(-10, 1, 1));
        BlockPos a = h.absolutePos(new BlockPos(0, 0, 0)), b = h.absolutePos(new BlockPos(1, 0, 0)), c = h.absolutePos(new BlockPos(2, 0, 0));
        for (BlockPos p : List.of(inCtx, outside, a, b, c)) put(level, p, "minecraft:air", null);
        Messages.PatchAck ack = patch(v, List.of(
                block(inCtx, "minecraft:air", "minecraft:stone"),
                block(outside, "minecraft:air", "minecraft:stone"),
                new PatchBlock(a, "minecraft:air", "minecraft:stone", null, snbt("{id:\"minecraft:chest\"}")),
                new PatchBlock(b, "minecraft:air", "minecraft:chest[facing=north,type=single,waterlogged=false]", null, snbt("{id:\"minecraft:furnace\"}")),
                new PatchBlock(c, "minecraft:air", "minecraft:chest[facing=north,type=single,waterlogged=false]", null, snbt("{Items:[]}")))).ack();
        check(h, ack.applied() == 0, "nothing applied: " + ack);
        java.util.Map<BlockPos, String> reasons = new java.util.HashMap<>();
        for (Rejected r : ack.lists().rejected()) reasons.put(r.pos(), r.reason());
        check(h, "outside_volumes".equals(reasons.get(inCtx)), "context is never written: " + reasons);
        check(h, "outside_volumes".equals(reasons.get(outside)), "outside: " + reasons);
        check(h, "bad_nbt".equals(reasons.get(a)) && "bad_nbt".equals(reasons.get(b)) && "bad_nbt".equals(reasons.get(c)), "bad_nbt: " + reasons);
        check(h, print(level, inCtx).equals("minecraft:air"), "context untouched");

        // A patch built for an older link is rejected entirely.
        LinkVolumes newer = link(h, box(h, 0, 0, 0, 2, 2, 2));
        Messages.PatchAck stale = patch(v, List.of(block(a, "minecraft:air", "minecraft:stone"))).ack();
        check(h, stale.lists().rejected().size() == 1 && stale.lists().rejected().get(0).reason().equals("stale_link"), "stale: " + stale);
        check(h, newer.link() != v.link(), "new link");
        unlink();
        h.succeed();
    }

    @GameTest(template = "empty", batch = "o_normalized")
    public static void blockEntityWithoutNbtIsListedAsNormalized(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        LinkVolumes v = link(h, box(h, 0, 0, 0, 2, 2, 2));
        BlockPos p = h.absolutePos(new BlockPos(1, 1, 1));
        put(level, p, "minecraft:air", null);
        String chest = "minecraft:chest[facing=north,type=single,waterlogged=false]";
        Messages.PatchAck ack = patch(v, List.of(block(p, "minecraft:air", chest))).ack();
        check(h, ack.applied() == 1 && ack.lists().normalized().size() == 1, "normalized: " + ack);
        CompoundTag n = ack.lists().normalized().get(0).nbt();
        check(h, n != null && "minecraft:chest".equals(n.getString("id")), "the world's NBT: " + n);
        // Sending exactly what the world holds isn't listed.
        put(level, p, "minecraft:air", null);
        Messages.PatchAck same = patch(v, List.of(new PatchBlock(p, "minecraft:air", chest, null, n))).ack();
        check(h, same.applied() == 1 && same.lists().normalized().isEmpty(), "not normalized: " + same);
        unlink();
        h.succeed();
    }

    @GameTest(template = "empty", batch = "o_sand", timeoutTicks = 60)
    public static void sandPlacedMidAirDoesNotFall(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        LinkVolumes v = link(h, box(h, 0, 0, 0, 2, 2, 2));
        BlockPos p = h.absolutePos(new BlockPos(1, 2, 1));
        for (int y = 0; y <= 2; y++) put(level, h.absolutePos(new BlockPos(1, y, 1)), "minecraft:air", null);
        Messages.PatchAck ack = patch(v, List.of(block(p, "minecraft:air", "minecraft:sand"))).ack();
        check(h, ack.applied() == 1, "applied");
        h.runAfterDelay(20, () -> {
            check(h, print(level, p).equals("minecraft:sand"), "sand still in place");
            check(h, level.getEntitiesOfClass(net.minecraft.world.entity.item.FallingBlockEntity.class, new AABB(p).inflate(4)).isEmpty(), "no falling block");
            unlink();
            h.succeed();
        });
    }

    @GameTest(template = "empty", batch = "o_water", timeoutTicks = 80)
    public static void placedWaterSourceDoesNotFlow(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        LinkVolumes v = link(h, box(h, 0, 0, 0, 2, 2, 2));
        BlockPos p = h.absolutePos(new BlockPos(1, 2, 1));
        for (int x = 0; x <= 2; x++) for (int y = 0; y <= 2; y++) for (int z = 0; z <= 2; z++) put(level, h.absolutePos(new BlockPos(x, y, z)), "minecraft:air", null);
        Messages.PatchAck ack = patch(v, List.of(block(p, "minecraft:air", "minecraft:water[level=0]"))).ack();
        check(h, ack.applied() == 1, "applied: " + ack);
        h.runAfterDelay(40, () -> {
            check(h, print(level, p).equals("minecraft:water[level=0]"), "source in place");
            for (BlockPos n : List.of(p.below(), p.north(), p.south(), p.east(), p.west()))
                check(h, print(level, n).equals("minecraft:air"), "no flow at " + n + ": " + print(level, n));
            unlink();
            h.succeed();
        });
    }

    @GameTest(template = "empty", batch = "o_drops", timeoutTicks = 40)
    public static void breakingAChestDropsNothing(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        LinkVolumes v = link(h, box(h, 0, 0, 0, 2, 2, 2));
        BlockPos p = h.absolutePos(new BlockPos(1, 1, 1));
        String chest = "minecraft:chest[facing=north,type=single,waterlogged=false]";
        put(level, p, chest, snbt("{id:\"minecraft:chest\",Items:[{Slot:0b,count:64,id:\"minecraft:diamond\"}]}"));
        long hash = Hashing.nbtHash(WorldBlocks.nbtAt(level, p), defaults());
        Messages.PatchAck ack = patch(v, List.of(new PatchBlock(p, chest, "minecraft:air", hash, null))).ack();
        check(h, ack.applied() == 1, "applied: " + ack);
        h.runAfterDelay(5, () -> {
            check(h, print(level, p).equals("minecraft:air"), "chest gone");
            check(h, level.getBlockEntity(p) == null, "block entity gone");
            check(h, level.getEntitiesOfClass(ItemEntity.class, new AABB(p).inflate(4)).isEmpty(), "nothing dropped");
            unlink();
            h.succeed();
        });
    }

    @GameTest(template = "empty", batch = "o_light", timeoutTicks = 60)
    public static void lightFollowsAPatchedLightSource(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        LinkVolumes v = link(h, box(h, 0, 0, 0, 2, 2, 2));
        BlockPos p = h.absolutePos(new BlockPos(1, 1, 1));
        put(level, p, "minecraft:air", null);
        put(level, p.above(), "minecraft:air", null);
        check(h, patch(v, List.of(block(p, "minecraft:air", "minecraft:glowstone"))).ack().applied() == 1, "applied");
        h.runAfterDelay(10, () -> {
            int lit = level.getBrightness(net.minecraft.world.level.LightLayer.BLOCK, p.above());
            check(h, lit == 14, "block light next to the glowstone is 14, got " + lit);
            check(h, patch(v, List.of(block(p, "minecraft:glowstone", "minecraft:air"))).ack().applied() == 1, "removed");
            h.runAfterDelay(10, () -> {
                int dark = level.getBrightness(net.minecraft.world.level.LightLayer.BLOCK, p.above());
                check(h, dark < 14, "light goes when the source goes, got " + dark);
                unlink();
                h.succeed();
            });
        });
    }

    /** 100,000 blocks under a 10,000 budget: at least 10 ticks, in id order, visible part-way. */
    @GameTest(template = "empty", batch = "o_large", timeoutTicks = 400)
    public static void largePatchSpreadsAcrossTicksInOrder(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        BlockPos base = h.absolutePos(new BlockPos(0, 20, 0));
        dev.autosketch.mod.protocol.Box work = dev.autosketch.mod.protocol.Box.of(base, base.offset(49, 39, 49));
        LinkVolumes v = link(h, work);
        WorldModule.budgetOverride = 10_000;
        List<PatchBlock> first = new ArrayList<>(100_000), second = new ArrayList<>();
        for (int y = 0; y < 40; y++) for (int z = 0; z < 50; z++) for (int x = 0; x < 50; x++) {
            BlockPos p = base.offset(x, y, z);
            first.add(block(p, print(level, p), "minecraft:stone"));
        }
        BlockPos last = base.offset(49, 39, 49);
        second.add(block(last, "minecraft:stone", "minecraft:gold_block")); // only matches after the first patch
        long startTick = level.getServer().getTickCount();
        TestExchange a = patch(v, first);
        TestExchange b = patch(v, second);
        check(h, !a.done && Autosketch.patchStatus().pending() == 2, "pending 2 after submit, got " + Autosketch.patchStatus().pending());
        check(h, print(level, base).equals("minecraft:stone") && !print(level, last).equals("minecraft:stone"), "visible part-way");
        h.succeedWhen(() -> {
            if (!b.done) throw new net.minecraft.gametest.framework.GameTestAssertException("waiting");
            Messages.PatchAck ackA = a.ack(), ackB = b.ack();
            long ticks = a.doneAtTick - startTick;
            if (ackA.applied() != 100_000) fail(h, "first applied " + ackA.applied());
            if (ticks < 9) fail(h, "first patch finished after " + ticks + " ticks");
            if (b.doneAtTick < a.doneAtTick || ackB.applied() != 1) fail(h, "second after first: " + ackB);
            if (!print(level, last).equals("minecraft:gold_block")) fail(h, "second applied on top");
            // clean up the 100k blocks the same way
            List<PatchBlock> clear = new ArrayList<>(100_000);
            for (PatchBlock p : first) clear.add(block(p.pos(), print(level, p.pos()), "minecraft:air"));
            WorldModule.budgetOverride = 1_000_000;
            patch(v, clear);
            unlink();
        });
    }

    static void fail(GameTestHelper h, String what) {
        unlink();
        throw new net.minecraft.gametest.framework.GameTestAssertException(what);
    }
}
