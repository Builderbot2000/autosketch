package dev.autosketch.mod.gametest;

import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.link.Link;
import dev.autosketch.mod.link.LinkStatus;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.entity.living.LivingSwapItemsEvent;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;
import org.jetbrains.annotations.Nullable;

/**
 * The offline lock and the link state (16, *Mod side*; briefs/ui/L, *Done when*): with no MCP every
 * locked command and the wand answer with the one line and change nothing, {@code /autosketch status}
 * still works; marked volumes survive a disconnect and come back on connect; with an MCP lacking
 * {@code ui}, today's commands work and {@code 16}'s gate refuses with the too-old line; the client
 * half is told each status. Each test runs in its own batch: the bridge is global.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class LinkGameTests {
    private LinkGameTests() {}

    /** Action-bar lines from the lock, by player. */
    private static final class Lines implements Link.Output {
        final Map<UUID, List<String>> lines = new ConcurrentHashMap<>();

        @Override
        public void actionBar(ServerPlayer player, net.minecraft.network.chat.Component line) {
            lines.computeIfAbsent(player.getUUID(), k -> new ArrayList<>()).add(line.getString());
        }

        List<String> of(ServerPlayer p) {
            return lines.getOrDefault(p.getUUID(), List.of());
        }
    }

    private static void check(boolean condition, String message) {
        if (!condition) throw new GameTestAssertException(message);
    }

    /** Runs a command as the player and returns its result (0 when refused). */
    private static int exec(ServerPlayer p, String command) {
        try {
            return p.getServer().getCommands().getDispatcher().execute(command, p.createCommandSourceStack().withSuppressedOutput());
        } catch (CommandSyntaxException e) {
            throw new GameTestAssertException("/" + command + ": " + e.getMessage());
        }
    }

    @GameTest(template = "empty", batch = "autosketch_lock_offline")
    public static void offlineEveryLockedCommandAndTheWandAnswerWithTheLine(GameTestHelper h) {
        check(Link.status() == LinkStatus.OFFLINE, "no MCP connected");
        ServerPlayer p = VolumeGameTests.op(h);
        Lines out = new Lines();
        Link.Output old = Link.setOutput(out);
        try {
            BlockPos a = h.absolutePos(new BlockPos(0, 1, 0)), b = h.absolutePos(new BlockPos(2, 2, 2));
            long link = AutosketchMod.internals().volumes().link();
            List<String> locked = List.of("autosketch mode work", "autosketch pos1 " + VolumeGameTests.xyz(a), "autosketch pos2 " + VolumeGameTests.xyz(b),
                    "autosketch pos1", "autosketch show", "autosketch clear", "autosketch notices off", "autosketch context grow 4", "autosketch context add",
                    "autosketch context clear", "autosketch air", "autosketch air on", "autosketch air reach 9", "autosketch ask hello", "autosketch plan a wall",
                    "autosketch build a wall", "autosketch scan", "autosketch scan 3 the tower", "autosketch done", "autosketch log all", "autosketch focus clear");
            for (String c : locked) {
                int before = out.of(p).size();
                check(exec(p, c) == 0, "/" + c + " is refused offline");
                check(out.of(p).size() == before + 1 && out.of(p).getLast().equals(Link.OFFLINE_LINE), "/" + c + " answers with the one line: " + out.of(p));
            }
            check(Autosketch.link().current() == null && AutosketchMod.internals().volumes().link() == link, "no volume marked, no relink");
            check(!AutosketchMod.internals().air().on(p) && AutosketchMod.internals().air().reach(p) != 9, "air mode untouched");

            int before = out.of(p).size();
            check(exec(p, "autosketch status") == 1, "/autosketch status works offline");
            check(out.of(p).size() == before, "and shows no lock line");
            check(Link.statusLine().startsWith("link state: offline"), "status reports offline: " + Link.statusLine());

            // The wand: clicks cancelled (it never breaks or uses anything), the line once per click, nothing set.
            p.setItemInHand(InteractionHand.MAIN_HAND, new ItemStack(Items.BLAZE_ROD));
            String mode = AutosketchMod.internals().wand().mode(p).name();
            var left = new PlayerInteractEvent.LeftClickBlock(p, a, Direction.UP, PlayerInteractEvent.LeftClickBlock.Action.START);
            NeoForge.EVENT_BUS.post(left);
            var right = new PlayerInteractEvent.RightClickBlock(p, InteractionHand.MAIN_HAND, b, new BlockHitResult(Vec3.atCenterOf(b), Direction.UP, b, false));
            NeoForge.EVENT_BUS.post(right);
            var swap = new LivingSwapItemsEvent.Hands(p);
            NeoForge.EVENT_BUS.post(swap);
            check(left.isCanceled() && right.isCanceled() && swap.isCanceled(), "the wand's clicks are still cancelled");
            check(out.of(p).size() == before + 3 && out.of(p).stream().skip(before).allMatch(Link.OFFLINE_LINE::equals), "each click shows the line: " + out.of(p));
            check(AutosketchMod.internals().wand().mode(p).name().equals(mode), "swap-hands doesn't cycle the mode");
            check(Autosketch.link().current() == null, "the wand set no corner");

            // Air mode (as if turned on while connected): clicks into the air show the line and set nothing.
            AutosketchMod.internals().air().set(p, true);
            p.moveTo(a.getX() + 0.5, a.getY() + 40, a.getZ() + 0.5, 0f, -90f);
            check(AutosketchMod.internals().air().rightClickAir(p, true), "the air click is cancelled");
            AutosketchMod.internals().air().clientClick(p, 1, 3);
            check(out.of(p).size() == before + 5, "both air clicks show the line: " + out.of(p));
            check(Autosketch.link().current() == null && AutosketchMod.internals().air().reach(p) != 3, "air mode set nothing");
            AutosketchMod.internals().air().set(p, false);
        } finally {
            Link.setOutput(old);
        }
        h.getLevel().getServer().getPlayerList().remove(p);
        h.succeed();
    }

    /** Records the statuses sent to clients, delegating everything else to the real platform. */
    private record Recording(Platform real, Map<UUID, List<LinkStatus>> sent) implements Platform {
        @Override
        public @Nullable MinecraftServer currentServer() {
            return real.currentServer();
        }

        @Override
        public Path configDir() {
            return real.configDir();
        }

        @Override
        public String loader() {
            return real.loader();
        }

        @Override
        public String loaderVersion() {
            return real.loaderVersion();
        }

        @Override
        public CompoundTag playerData(ServerPlayer player) {
            return real.playerData(player);
        }

        @Override
        public boolean hasClientHalf(ServerPlayer player) {
            return real.hasClientHalf(player);
        }

        @Override
        public void sendAirState(ServerPlayer player, boolean on, int reach, String wandItem) {
            real.sendAirState(player, on, reach, wandItem);
        }

        @Override
        public void sendLinkStatus(ServerPlayer player, LinkStatus status) {
            sent.computeIfAbsent(player.getUUID(), k -> new java.util.concurrent.CopyOnWriteArrayList<>()).add(status);
            real.sendLinkStatus(player, status);
        }
    }

    private static @Nullable LinkStatus lastSent(Map<UUID, List<LinkStatus>> sent, ServerPlayer p) {
        List<LinkStatus> l = sent.get(p.getUUID());
        return l == null || l.isEmpty() ? null : l.getLast();
    }

    /**
     * Volumes survive a disconnect and come back on connect; the client half is told connected,
     * offline and too_old in turn; with an MCP lacking {@code ui}, today's commands work and the
     * in-game UI's gate refuses with the too-old line.
     */
    @GameTest(template = "empty", batch = "autosketch_lock_reconnect", timeoutTicks = 400)
    public static void volumesSurviveADisconnectAndAnOlderMcpLocksOnlyTheUi(GameTestHelper h) {
        Platform real = Platform.get();
        Map<UUID, List<LinkStatus>> sent = new ConcurrentHashMap<>();
        Platform.install(new Recording(real, sent));
        Lines out = new Lines();
        Link.Output oldOut = Link.setOutput(out);
        ServerPlayer p = VolumeGameTests.op(h);
        BlockPos a = h.absolutePos(new BlockPos(0, 1, 0)), b = h.absolutePos(new BlockPos(2, 2, 2));
        Box work = Box.of(a, b);
        FakeMcp first = FakeMcp.open();
        FakeMcp[] older = new FakeMcp[1];
        long[] link = new long[1];
        first.start(h)
                .thenExecute(() -> {
                    check(Link.status() == LinkStatus.CONNECTED, "an MCP listing ui: connected");
                    check(lastSent(sent, p) == LinkStatus.CONNECTED, "the client is told connected: " + sent.get(p.getUUID()));
                    VolumeGameTests.run(p, "autosketch mode work");
                    VolumeGameTests.run(p, "autosketch pos1 " + VolumeGameTests.xyz(a));
                    VolumeGameTests.run(p, "autosketch pos2 " + VolumeGameTests.xyz(b));
                    LinkVolumes v = Autosketch.link().current();
                    check(v != null && v.work().equals(work), "volumes marked while connected");
                    link[0] = v.link();
                    first.close();
                })
                .thenWaitUntil(() -> check(Link.status() == LinkStatus.OFFLINE, "the MCP disconnected"))
                .thenExecute(() -> {
                    check(lastSent(sent, p) == LinkStatus.OFFLINE, "the client is told offline: " + sent.get(p.getUUID()));
                    LinkVolumes v = Autosketch.link().current();
                    check(v != null && v.work().equals(work) && v.link() == link[0], "the marked volumes are kept while offline: " + v);
                    check(exec(p, "autosketch clear") == 0 && out.of(p).getLast().equals(Link.OFFLINE_LINE), "and can't be cleared offline");
                    older[0] = FakeMcp.open(List.of(Messages.MCP_FEATURE_PROMPT_CLOSE));
                })
                .thenWaitUntil(() -> check(older[0].paired() && older[0].frames.stream().anyMatch(f -> f.type().equals("volumes")), "an older MCP pairs and gets the volumes"))
                .thenExecute(() -> {
                    check(Link.status() == LinkStatus.TOO_OLD, "an MCP without ui: too_old");
                    check(lastSent(sent, p) == LinkStatus.TOO_OLD, "the client is told too_old: " + sent.get(p.getUUID()));
                    Messages.Volumes v = volumes(older[0]);
                    check(work.equals(v.work()) && v.link() == link[0], "the kept volumes come back on connect: " + v.work());
                    String line = Link.statusLine();
                    check(line.contains("too_old") && line.contains("protocol " + Messages.PROTOCOL_VERSION) && line.contains("prompt.close"), "status names protocol and features: " + line);
                    // Today's features work.
                    VolumeGameTests.run(p, "autosketch context grow 5");
                    check(Autosketch.link().current().context().equals(List.of(work.grow(5))), "today's commands work with an older MCP");
                    // 16's features are refused with the too-old line.
                    int before = out.of(p).size();
                    check(!Link.requireUi(p.createCommandSourceStack()), "the in-game UI's gate refuses");
                    check(out.of(p).size() == before + 1 && out.of(p).getLast().equals(Link.TOO_OLD_LINE), "with the too-old line: " + out.of(p));
                    check(Link.requireConnected(p) && out.of(p).size() == before + 1, "while today's gate passes silently");
                    AutosketchMod.internals().volumes().clear();
                    older[0].close();
                })
                .thenWaitUntil(() -> check(!Autosketch.bridge().connected(), "the older MCP disconnected"))
                .thenExecute(() -> {
                    Link.setOutput(oldOut);
                    Platform.install(real);
                    h.getLevel().getServer().getPlayerList().remove(p);
                })
                .thenSucceed();
    }

    /** The first {@code volumes} the mod sent this MCP (right after its hello). */
    private static Messages.Volumes volumes(FakeMcp mcp) {
        for (Frame f : mcp.frames)
            if (f.type().equals("volumes")) {
                try {
                    return Messages.Volumes.decode(f);
                } catch (ProtocolException e) {
                    throw new GameTestAssertException(e.getMessage());
                }
            }
        throw new GameTestAssertException("no volumes yet: " + mcp.frames);
    }
}
