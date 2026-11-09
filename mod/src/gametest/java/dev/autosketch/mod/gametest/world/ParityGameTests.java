package dev.autosketch.mod.gametest.world;

import static dev.autosketch.mod.gametest.world.WorldTestKit.link;
import static dev.autosketch.mod.gametest.world.WorldTestKit.put;
import static dev.autosketch.mod.gametest.world.WorldTestKit.snbt;
import static dev.autosketch.mod.gametest.world.WorldTestKit.unlink;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.protocol.BodyTypes.PatchBlock;
import dev.autosketch.mod.protocol.BodyTypes.Rejected;
import dev.autosketch.mod.protocol.BodyTypes.WorldBlock;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.world.Hashing;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * Parity with L's fake host (silo O brief, *Done when*): the same starting world and patch as a
 * scenario run through {@code test/support/fake-host.ts}, with the ack the fake host sent recorded
 * below (positions relative to the work volume's minimum corner). The fake host was given the
 * game's own rules where it is configurable ({@code knownStates}, {@code acceptsNbt}: NBT only on a
 * chest, with a chest id); its default normalization (none) matches here because no applied
 * position carries a block entity. The furnace's NBT includes {@code RecipesUsed:{}}, the form the
 * game saves, as the MCP's cache holds it after an ack's normalized list.
 *
 * <pre>
 * fake host: {"applied":2,"overwritten":0,
 *   "skipped":[[[1,1,1],chest,nbt],[[3,1,1],"minecraft:oak_planks"],[[0,1,3],"minecraft:air"]],
 *   "rejected":[[[-1,1,0],"outside_volumes"],[[0,1,1],"unknown_state"],[[0,1,2],"bad_nbt"]],
 *   "normalized":0}
 * </pre>
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class ParityGameTests {
    private ParityGameTests() {}

    @GameTest(template = "empty", batch = "o_parity")
    public static void ackMatchesTheFakeHost(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        BlockPos o = h.absolutePos(new BlockPos(0, 0, 0));
        String chest = "minecraft:chest[facing=north,type=single,waterlogged=false]";
        String furnace = "minecraft:furnace[facing=north,lit=true]";
        for (int x = -1; x <= 4; x++) for (int y = 0; y <= 2; y++) for (int z = 0; z <= 4; z++) put(level, o.offset(x, y, z), y == 0 && x >= 0 ? "minecraft:stone" : "minecraft:air", null);
        CompoundTag chestBefore = snbt("{id:\"minecraft:chest\",Items:[{Slot:0b,count:3,id:\"minecraft:oak_planks\"}]}");
        CompoundTag furnBefore = snbt("{id:\"minecraft:furnace\",BurnTime:200s,CookTime:10s,CookTimeTotal:200s,Items:[{Slot:1b,count:8,id:\"minecraft:coal\"}],RecipesUsed:{}}");
        put(level, o.offset(1, 1, 1), chest, snbt("{id:\"minecraft:chest\",Items:[{Slot:0b,count:2,id:\"minecraft:diamond\"}]}"));
        put(level, o.offset(2, 1, 1), furnace, snbt("{id:\"minecraft:furnace\",BurnTime:150s,CookTime:60s,CookTimeTotal:200s,Items:[{Slot:1b,count:8,id:\"minecraft:coal\"}],RecipesUsed:{}}"));
        put(level, o.offset(3, 1, 1), "minecraft:oak_planks", null);
        LinkVolumes v = link(h, Box.of(o, o.offset(4, 2, 4)));
        var keys = PatchGameTests.defaults();
        if (!Messages.hex(Hashing.nbtHash(chestBefore, keys)).equals("e90e10d345f6b98f") || !Messages.hex(Hashing.nbtHash(furnBefore, keys)).equals("b35f02610a8978d1")) {
            unlink();
            h.fail("expected hashes differ from the fake host's");
        }
        List<PatchBlock> blocks = List.of(
                new PatchBlock(o.offset(0, 1, 0), "minecraft:air", "minecraft:stone", null, null),
                new PatchBlock(o.offset(3, 1, 1), "minecraft:air", "minecraft:glass", null, null),
                new PatchBlock(o.offset(1, 1, 1), chest, "minecraft:air", Hashing.nbtHash(chestBefore, keys), null),
                new PatchBlock(o.offset(2, 1, 1), furnace, "minecraft:stone", Hashing.nbtHash(furnBefore, keys), null),
                new PatchBlock(o.offset(-1, 1, 0), "minecraft:air", "minecraft:stone", null, null),
                new PatchBlock(o.offset(0, 1, 1), "minecraft:air", "minecraft:not_a_block", null, null),
                new PatchBlock(o.offset(0, 1, 2), "minecraft:air", "minecraft:stone", null, snbt("{id:\"minecraft:chest\"}")),
                new PatchBlock(o.offset(0, 1, 3), "minecraft:stone", "minecraft:glass", null, null));
        Messages.PatchAck ack = WorldTestKit.patch(v, blocks).ack();
        List<String> skipped = new ArrayList<>(), rejected = new ArrayList<>();
        for (WorldBlock b : ack.lists().skipped()) skipped.add(rel(o, b.pos()) + " " + b.state() + (b.nbt() != null ? " nbt" : ""));
        for (Rejected r : ack.lists().rejected()) rejected.add(rel(o, r.pos()) + " " + r.reason());
        String got = ack.applied() + "/" + ack.overwritten() + " skipped " + skipped + " rejected " + rejected + " normalized " + ack.lists().normalized().size();
        String want = "2/0 skipped [1,1,1 " + chest + " nbt, 3,1,1 minecraft:oak_planks, 0,1,3 minecraft:air] rejected [-1,1,0 outside_volumes, 0,1,1 unknown_state, 0,1,2 bad_nbt] normalized 0";
        unlink();
        if (!got.equals(want)) h.fail("ack differs from the fake host's:\n  got  " + got + "\n  want " + want);
        h.succeed();
    }

    private static String rel(BlockPos o, BlockPos p) {
        return (p.getX() - o.getX()) + "," + (p.getY() - o.getY()) + "," + (p.getZ() - o.getZ());
    }
}
