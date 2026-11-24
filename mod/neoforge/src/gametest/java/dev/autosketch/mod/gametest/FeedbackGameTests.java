package dev.autosketch.mod.gametest;

import static dev.autosketch.mod.gametest.VolumeGameTests.op;
import static dev.autosketch.mod.gametest.VolumeGameTests.run;
import static dev.autosketch.mod.gametest.VolumeGameTests.xyz;

import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.feedback.Feedback;
import dev.autosketch.mod.feedback.VolumeOutlines;
import dev.autosketch.mod.link.LinkStatus;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Messages;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;
import org.jetbrains.annotations.Nullable;

/**
 * Volume outlines on the overlay, particles as the fallback (18, piece 8; 13, *Relay to the client*,
 * op {@code 4}; briefs/select/C, C3): a player whose client registered the UI channel gets the
 * outlines as op-4 JSON while the link is {@code connected} and no particles; a vanilla client (no
 * channel) keeps the dust particles; with an MCP too old for the UI, the client half's player gets
 * particles too and its overlay is emptied. The channel is faked by a platform that says which mock
 * player has it and records what is sent; the real drawing is the client suite's
 * ({@code overlay}, {@code VolumeOverlayClientTests}).
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class FeedbackGameTests {
    private FeedbackGameTests() {}

    static final int WORK = 0x33e05a, CONTEXT = 0x3a8dff;

    static Feedback feedback() {
        return AutosketchMod.internals().feedback();
    }

    /** One entry per wand mode in mode order: work's box in green, the context in blue, the other modes' (ghost, focus) boxes empty. */
    static String expected(ServerPlayer p, Box work, int contextGrow) {
        List<VolumeOutlines.Entry> out = new java.util.ArrayList<>();
        for (dev.autosketch.mod.api.WandMode m : Autosketch.wandModes())
            out.add(switch (m.name()) {
                case "work" -> new VolumeOutlines.Entry(WORK, List.of(work));
                case "context" -> new VolumeOutlines.Entry(CONTEXT, List.of(work.grow(contextGrow)));
                default -> new VolumeOutlines.Entry(m.colour(), List.of());
            });
        return new VolumeOutlines(p.serverLevel().dimension().location().toString(), out).toJson();
    }

    static String expected(ServerPlayer p, Box work) {
        return expected(p, work, 3);
    }

    static String none(ServerPlayer p) {
        return VolumeOutlines.none(p.serverLevel().dimension().location().toString()).toJson();
    }

    static void check(boolean ok, String message) {
        if (!ok) throw new GameTestAssertException(message);
    }

    /** {@code body}, running {@code cleanup} first when it fails, so a failure leaves no platform or volumes behind for later batches. */
    static Runnable guarded(Runnable cleanup, Runnable body) {
        return () -> {
            try {
                body.run();
            } catch (RuntimeException | Error e) {
                cleanup.run();
                throw e;
            }
        };
    }

    /** Stands the mock player at {@code at} (it starts at the world origin, far beyond the particles' range). */
    static void standAt(ServerPlayer p, BlockPos at) {
        p.moveTo(at.getX() + 0.5, at.getY(), at.getZ() + 0.5, 0f, 0f);
    }

    @GameTest(template = "empty", batch = "autosketch_feedback_overlay", timeoutTicks = 300)
    public static void clientHalfGetsOutlinesVanillaGetsParticles(GameTestHelper h) {
        Platform real = Platform.get();
        Map<UUID, List<String>> sent = new ConcurrentHashMap<>();
        ServerPlayer withHalf = op(h), vanilla = op(h);
        Platform.install(new Channels(real, Set.of(withHalf.getUUID()), sent));
        BlockPos a = h.absolutePos(new BlockPos(0, 1, 0)), b = h.absolutePos(new BlockPos(2, 2, 2));
        Box work = Box.of(a, b);
        int[] before = new int[2];
        Runnable cleanup = () -> {
            Platform.install(real);
            AutosketchMod.internals().players().get(withHalf.getUUID()).show = false;
            AutosketchMod.internals().players().get(vanilla.getUUID()).show = false;
            AutosketchMod.internals().volumes().clear();
            h.getLevel().getServer().getPlayerList().remove(withHalf);
            h.getLevel().getServer().getPlayerList().remove(vanilla);
        };
        FakeMcp mcp = FakeMcp.open();
        mcp.finish(mcp.start(h).thenExecute(guarded(cleanup, () -> {
            standAt(withHalf, a);
            standAt(vanilla, a);
            run(vanilla, "autosketch mode work");
            run(vanilla, "autosketch pos1 " + xyz(a));
            run(vanilla, "autosketch pos2 " + xyz(b));
            run(withHalf, "autosketch show");
            run(vanilla, "autosketch show");
            before[0] = feedback().particlesSent(withHalf.getUUID());
            before[1] = feedback().particlesSent(vanilla.getUUID());
        })).thenIdle(2 * Feedback.OUTLINE_PERIOD + 1).thenExecute(guarded(cleanup, () -> {
            List<String> got = sent.getOrDefault(withHalf.getUUID(), List.of());
            check(!got.isEmpty() && got.getLast().equals(expected(withHalf, work)), "the client half's outlines: " + got);
            check(got.stream().filter(j -> j.equals(expected(withHalf, work))).count() == 1, "sent once, not every tick: " + got);
            check(feedback().particlesSent(withHalf.getUUID()) == before[0], "no particles to the client half's player");
            check(feedback().particlesSent(vanilla.getUUID()) > before[1], "particles to the vanilla client");
            check(!sent.containsKey(vanilla.getUUID()), "nothing on the channel to the vanilla client");
            run(withHalf, "autosketch show");
        })).thenIdle(2).thenExecute(guarded(cleanup, () -> {
            List<String> got = sent.get(withHalf.getUUID());
            check(got.getLast().equals(none(withHalf)), "show off empties the overlay: " + got);
            run(withHalf, "autosketch show");
        })).thenIdle(2).thenExecute(guarded(cleanup, () -> {
            List<String> got = sent.get(withHalf.getUUID());
            check(got.getLast().equals(expected(withHalf, work)), "show on again: " + got);
            run(vanilla, "autosketch context grow 4");
        })).thenIdle(2).thenExecute(guarded(cleanup, () -> {
            List<String> got = sent.get(withHalf.getUUID());
            String grown = expected(withHalf, work, 4);
            check(got.getLast().equals(grown), "the context grew at once: " + got);
        })).thenExecute(cleanup));
    }

    @GameTest(template = "empty", batch = "autosketch_feedback_too_old", timeoutTicks = 300)
    public static void anMcpWithoutUiFallsBackToParticles(GameTestHelper h) {
        Platform real = Platform.get();
        Map<UUID, List<String>> sent = new ConcurrentHashMap<>();
        ServerPlayer withHalf = op(h);
        Platform.install(new Channels(real, Set.of(withHalf.getUUID()), sent));
        BlockPos a = h.absolutePos(new BlockPos(0, 1, 0)), b = h.absolutePos(new BlockPos(1, 1, 1));
        int[] before = new int[1];
        Runnable cleanup = () -> {
            Platform.install(real);
            AutosketchMod.internals().players().get(withHalf.getUUID()).show = false;
            AutosketchMod.internals().volumes().clear();
            h.getLevel().getServer().getPlayerList().remove(withHalf);
        };
        FakeMcp mcp = FakeMcp.open(List.of(Messages.MCP_FEATURE_PROMPT_CLOSE));
        mcp.finish(mcp.start(h).thenExecute(guarded(cleanup, () -> {
            standAt(withHalf, a);
            check(dev.autosketch.mod.link.Link.status() == LinkStatus.TOO_OLD, "link " + dev.autosketch.mod.link.Link.status());
            run(withHalf, "autosketch mode work");
            run(withHalf, "autosketch pos1 " + xyz(a));
            run(withHalf, "autosketch pos2 " + xyz(b));
            run(withHalf, "autosketch show");
            before[0] = feedback().particlesSent(withHalf.getUUID());
        })).thenIdle(2 * Feedback.OUTLINE_PERIOD + 1).thenExecute(guarded(cleanup, () -> {
            List<String> got = sent.getOrDefault(withHalf.getUUID(), List.of());
            check(!got.isEmpty() && got.stream().allMatch(j -> j.equals(none(withHalf))), "only an empty overlay: " + got);
            check(feedback().particlesSent(withHalf.getUUID()) > before[0], "particles instead");
        })).thenExecute(cleanup));
    }

    /** The real platform, except that only {@code channel}'s players have the UI channel, and op-4 sends are recorded. */
    private record Channels(Platform real, Set<UUID> channel, Map<UUID, List<String>> sent) implements Platform {
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
            real.sendLinkStatus(player, status);
        }

        @Override
        public boolean hasUiChannel(ServerPlayer player) {
            return channel.contains(player.getUUID());
        }

        @Override
        public void sendVolumeOutlines(ServerPlayer player, String json) {
            sent.computeIfAbsent(player.getUUID(), k -> new CopyOnWriteArrayList<>()).add(json);
        }
    }
}
