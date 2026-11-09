package dev.autosketch.mod.gametest;

import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.volume.Wand;
import java.util.List;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.entity.living.LivingSwapItemsEvent;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * Work and context volumes, the wand and its commands, in a running server (13, *Work and context
 * volumes in-game*; M3, M4, M12). The volumes are global, so each test runs in its own batch and
 * clears them when done.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class VolumeGameTests {
    private VolumeGameTests() {}

    @SuppressWarnings("removal")
    static ServerPlayer op(GameTestHelper h) {
        ServerPlayer p = h.makeMockServerPlayerInLevel();
        // GameTestServer ops at level 0; add the entry at level 2 directly.
        h.getLevel().getServer().getPlayerList().getOps().add(new net.minecraft.server.players.ServerOpListEntry(p.getGameProfile(), 2, false));
        return p;
    }

    static void run(ServerPlayer p, String command) {
        p.getServer().getCommands().performPrefixedCommand(p.createCommandSourceStack().withSuppressedOutput(), command);
    }

    static String xyz(BlockPos p) {
        return p.getX() + " " + p.getY() + " " + p.getZ();
    }

    static void done(GameTestHelper h, ServerPlayer p) {
        AutosketchMod.internals().volumes().clear();
        h.getLevel().getServer().getPlayerList().remove(p);
        h.succeed();
    }

    @GameTest(template = "empty", batch = "autosketch_commands")
    public static void commandsSetWorkAndContext(GameTestHelper h) {
        ServerPlayer p = op(h);
        BlockPos a = h.absolutePos(new BlockPos(0, 1, 0)), b = h.absolutePos(new BlockPos(2, 2, 2));
        long before = AutosketchMod.internals().volumes().link();
        run(p, "autosketch mode work");
        run(p, "autosketch pos1 " + xyz(a));
        h.assertTrue(Autosketch.link().current() == null, "one corner doesn't link");
        run(p, "autosketch pos2 " + xyz(b));
        LinkVolumes v = Autosketch.link().current();
        h.assertTrue(v != null, "both corners link");
        Box work = Box.of(a, b);
        h.assertTrue(v.work().equals(work), "work volume " + v.work());
        h.assertTrue(v.link() == before + 1, "a new work volume is a new link");
        h.assertTrue(v.context().equals(List.of(work.grow(3))), "default context is work grown by 3: " + v.context());

        run(p, "autosketch context grow 5");
        v = Autosketch.link().current();
        h.assertTrue(v.context().equals(List.of(work.grow(5))), "grow 5: " + v.context());
        h.assertTrue(v.link() == before + 1, "a context change keeps the link");

        BlockPos r1 = a.offset(40, 0, 0), r2 = a.offset(44, 3, 4);
        run(p, "autosketch mode context");
        run(p, "autosketch pos1 " + xyz(r1));
        run(p, "autosketch pos2 " + xyz(r2));
        run(p, "autosketch context add");
        v = Autosketch.link().current();
        h.assertTrue(v.context().equals(List.of(work.grow(5), Box.of(r1, r2))), "added a reference box: " + v.context());

        run(p, "autosketch context clear");
        v = Autosketch.link().current();
        h.assertTrue(v.context().equals(List.of(work.grow(3))), "clear restores the default: " + v.context());

        run(p, "autosketch clear");
        h.assertTrue(Autosketch.link().current() == null, "clear unlinks");
        h.assertTrue(AutosketchMod.internals().volumes().link() == before + 2, "clearing is a new link too");
        done(h, p);
    }

    @GameTest(template = "empty", batch = "autosketch_cap")
    public static void contextCapRefusesHugeVolumes(GameTestHelper h) {
        ServerPlayer p = op(h);
        BlockPos a = h.absolutePos(new BlockPos(0, 1, 0));
        run(p, "autosketch mode work");
        run(p, "autosketch pos1 " + xyz(a));
        run(p, "autosketch pos2 " + xyz(a.offset(300, 100, 300)));
        h.assertTrue(Autosketch.link().current() == null, "a work volume whose context exceeds the cap is refused");
        run(p, "autosketch pos2 " + xyz(a.offset(10, 10, 10)));
        h.assertTrue(Autosketch.link().current() != null, "a small one is accepted");
        run(p, "autosketch context grow 200");
        h.assertTrue(Autosketch.link().current().context().get(0).equals(Box.of(a, a.offset(10, 10, 10)).grow(3)), "an over-cap grow is refused");
        done(h, p);
    }

    @GameTest(template = "empty", batch = "autosketch_wand")
    public static void wandClicksAndSwapHands(GameTestHelper h) {
        ServerPlayer p = op(h);
        p.setItemInHand(InteractionHand.MAIN_HAND, Wand.create());
        h.assertTrue(Wand.isWand(p.getMainHandItem()), "the wand carries its marker");
        run(p, "autosketch mode work");

        BlockPos a = h.absolutePos(new BlockPos(0, 1, 0)), b = h.absolutePos(new BlockPos(2, 1, 2));
        h.setBlock(new BlockPos(0, 1, 0), Blocks.STONE);
        var left = new PlayerInteractEvent.LeftClickBlock(p, a, Direction.UP, PlayerInteractEvent.LeftClickBlock.Action.START);
        NeoForge.EVENT_BUS.post(left);
        h.assertTrue(left.isCanceled(), "the wand's left click is cancelled (never breaks)");
        var right = new PlayerInteractEvent.RightClickBlock(p, InteractionHand.MAIN_HAND, b, new net.minecraft.world.phys.BlockHitResult(Vec3.atCenterOf(b), Direction.UP, b, false));
        NeoForge.EVENT_BUS.post(right);
        h.assertTrue(right.isCanceled(), "the wand's right click is cancelled (never places or uses)");
        LinkVolumes v = Autosketch.link().current();
        h.assertTrue(v != null && v.work().equals(Box.of(a, b)), "left and right click set the work corners: " + v);
        h.assertBlockPresent(Blocks.STONE, new BlockPos(0, 1, 0));

        var swap = new LivingSwapItemsEvent.Hands(p);
        NeoForge.EVENT_BUS.post(swap);
        h.assertTrue(swap.isCanceled(), "swap-hands with the wand is cancelled");
        h.assertTrue(AutosketchMod.internals().wand().mode(p).name().equals("context"), "swap-hands cycles work -> context");
        NeoForge.EVENT_BUS.post(new LivingSwapItemsEvent.Hands(p));
        String third = AutosketchMod.internals().wand().mode(p).name();
        h.assertTrue(!third.equals("context"), "and on (" + third + ")");
        done(h, p);
    }

    @GameTest(template = "empty", batch = "autosketch_extend")
    public static void extensionKeepsTheLinkAndIsDroppedOnRelink(GameTestHelper h) throws Exception {
        ServerPlayer p = op(h);
        BlockPos a = h.absolutePos(new BlockPos(0, 1, 0)), b = h.absolutePos(new BlockPos(2, 2, 2));
        run(p, "autosketch mode work");
        run(p, "autosketch pos1 " + xyz(a));
        run(p, "autosketch pos2 " + xyz(b));
        var vm = AutosketchMod.internals().volumes();
        long link = vm.link();
        Box ext = Box.of(a, b.offset(0, 1, 0));
        try {
            vm.extend(1, link - 1, ext);
            h.fail("a stale link is refused");
        } catch (dev.autosketch.mod.protocol.ProtocolException e) {
            h.assertTrue(e.code().equals("stale_link"), e.code());
        }
        try {
            vm.extend(2, link, Box.of(a, a));
            h.fail("a box not containing the work volume is refused");
        } catch (dev.autosketch.mod.protocol.ProtocolException e) {
            h.assertTrue(e.code().equals("bad_extension"), e.code());
        }
        vm.extend(3, link, ext);
        LinkVolumes v = Autosketch.link().current();
        h.assertTrue(v.link() == link && ext.equals(v.extended()) && v.effectiveWork().equals(ext), "extension in force, same link: " + v);
        run(p, "autosketch pos2 " + xyz(b.offset(1, 0, 0)));
        v = Autosketch.link().current();
        h.assertTrue(v.link() == link + 1 && v.extended() == null, "a new work volume drops the extension: " + v);
        done(h, p);
    }

    /** M12: nothing this silo does touches entities. */
    @GameTest(template = "empty", batch = "autosketch_entities")
    public static void volumesLeaveEntitiesAlone(GameTestHelper h) throws Exception {
        ServerPlayer p = op(h);
        net.minecraft.world.entity.animal.Pig pig = h.spawn(EntityType.PIG, new BlockPos(1, 1, 1));
        Entity stand = h.spawn(EntityType.ARMOR_STAND, new BlockPos(0, 1, 2));
        pig.setNoAi(true);
        pig.setNoGravity(true);
        stand.setNoGravity(true);
        Vec3 pigAt = pig.position(), standAt = stand.position();
        UUID pigId = pig.getUUID();
        AABB area = new AABB(h.absolutePos(BlockPos.ZERO)).inflate(16);
        int count = h.getLevel().getEntities((Entity) null, area, e -> !(e instanceof Player)).size();

        BlockPos a = h.absolutePos(new BlockPos(0, 1, 0)), b = h.absolutePos(new BlockPos(2, 2, 2));
        p.setItemInHand(InteractionHand.MAIN_HAND, Wand.create());
        run(p, "autosketch mode work");
        run(p, "autosketch pos1 " + xyz(a));
        run(p, "autosketch pos2 " + xyz(b));
        run(p, "autosketch context grow 6");
        run(p, "autosketch show");
        var vm = AutosketchMod.internals().volumes();
        vm.extend(1, vm.link(), Box.of(a, b).grow(1));
        // Hold tickets as if linked, then release them.
        AutosketchMod.internals().tickets().hold(h.getLevel(), List.of(Box.of(a, b).grow(6)));
        AutosketchMod.internals().tickets().releaseAll();
        h.runAfterDelay(25, () -> {
            h.assertTrue(pig.isAlive() && stand.isAlive(), "entities are still alive");
            h.assertTrue(pig.position().equals(pigAt) && stand.position().equals(standAt), "and unmoved");
            h.assertTrue(h.getLevel().getEntity(pigId) == pig, "the same entity");
            int after = h.getLevel().getEntities((Entity) null, area, e -> !(e instanceof Player)).size();
            h.assertTrue(after == count, "no entity added or removed: " + count + " -> " + after);
            run(p, "autosketch clear");
            done(h, p);
        });
    }
}
