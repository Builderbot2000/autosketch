package dev.autosketch.mod.gametest;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.api.LinkState;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.prompt.ChatRules.LogMode;
import dev.autosketch.mod.prompt.InGamePrompts;
import dev.autosketch.mod.prompt.PromptModule;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.players.ServerOpListEntry;
import net.minecraft.world.level.block.Blocks;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;
import org.jetbrains.annotations.Nullable;

/**
 * In-game requests in a running server (13, *Prompting from the game*, M13; briefs/world/S, *Done
 * when*). Each test swaps in a recording bridge, a fixed link and a recording output, and restores
 * them before returning, all within one call on the server thread, so no other test sees them.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class PromptGameTests {
    private PromptGameTests() {}

    /** A connected bridge that keeps what it is sent. */
    private static final class RecordingBridge implements Bridge {
        final List<Frame> sent = new ArrayList<>();
        final boolean connected;
        final List<String> modes;
        final List<String> features;

        RecordingBridge(boolean connected) {
            this(connected, List.of("ask", "plan", "build"));
        }

        /** Connected, to an MCP whose hello lists these request modes. */
        RecordingBridge(boolean connected, List<String> modes) {
            this(connected, modes, List.of());
        }

        /** Connected, to an MCP whose hello lists these request modes and features. */
        RecordingBridge(boolean connected, List<String> modes, List<String> features) {
            this.connected = connected;
            this.modes = modes;
            this.features = features;
        }

        @Override
        public boolean connected() {
            return connected;
        }

        @Override
        public @Nullable BridgeSession session() {
            return connected ? new BridgeSession(1, "test", "0", new JsonObject(), modes, features) : null;
        }

        @Override
        public boolean send(Frame frame) {
            if (!connected) return false;
            sent.add(frame);
            return true;
        }

        @Override
        public void addListener(Listener listener) {}
    }

    private static LinkState fixed(@Nullable LinkVolumes v) {
        return new LinkState() {
            @Override
            public @Nullable LinkVolumes current() {
                return v;
            }

            @Override
            public void addListener(Listener listener) {}
        };
    }

    /** What players were shown: action-bar and chat lines by player. */
    private static final class Recorder implements InGamePrompts.Output {
        final Map<UUID, List<String>> bar = new HashMap<>();
        final Map<UUID, List<String>> chat = new HashMap<>();

        @Override
        public void actionBar(ServerPlayer player, Component text) {
            bar.computeIfAbsent(player.getUUID(), k -> new ArrayList<>()).add(text.getString());
        }

        @Override
        public void chat(ServerPlayer player, Component text) {
            chat.computeIfAbsent(player.getUUID(), k -> new ArrayList<>()).add(text.getString());
        }

        List<String> chatOf(ServerPlayer p) {
            return chat.getOrDefault(p.getUUID(), List.of());
        }

        List<String> barOf(ServerPlayer p) {
            return bar.getOrDefault(p.getUUID(), List.of());
        }
    }

    /** Runs {@code body} with the given services and output installed, restoring them afterwards. */
    private static void with(Bridge bridge, LinkState link, Recorder out, Runnable body) {
        Bridge oldBridge = Autosketch.bridge();
        LinkState oldLink = Autosketch.link();
        InGamePrompts.Output oldOut = InGamePrompts.setOutput(out);
        Autosketch.install(bridge, link, Autosketch.patchStatus(), Autosketch.wandModes());
        try {
            body.run();
        } finally {
            Autosketch.install(oldBridge, oldLink, Autosketch.patchStatus(), Autosketch.wandModes());
            InGamePrompts.setOutput(oldOut);
        }
    }

    private static void run(ServerPlayer player, String command) {
        MinecraftServer server = player.getServer();
        server.getCommands().performPrefixedCommand(player.createCommandSourceStack().withPermission(2), command);
    }

    private static void leave(ServerPlayer... players) {
        for (ServerPlayer p : players) {
            p.getServer().getPlayerList().deop(p.getGameProfile());
            p.getServer().getPlayerList().remove(p);
        }
    }

    private static int[] ints(JsonArray a) {
        return new int[] {a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()};
    }

    @GameTest(template = "empty")
    public static void askSendsThePromptWithItsGameContext(GameTestHelper helper) {
        BlockPos block = helper.absolutePos(new BlockPos(1, 1, 2));
        helper.setBlock(new BlockPos(1, 1, 2), Blocks.OAK_PLANKS);
        BlockPos origin = helper.absolutePos(BlockPos.ZERO);
        Box work = new Box(origin.getX(), origin.getY(), origin.getZ(), origin.getX() + 2, origin.getY() + 2, origin.getZ() + 2);
        LinkVolumes volumes = new LinkVolumes(1, helper.getLevel().dimension(), work, null, List.of(work.grow(1)));
        ServerPlayer player = helper.makeMockServerPlayerInLevel();
        // Eye at the centre of the column x=1, level with the block, two blocks north of it, facing south.
        player.moveTo(block.getX() + 0.5, block.getY() + 0.5 - player.getEyeHeight(), block.getZ() - 1.5, 0f, 0f);
        RecordingBridge bridge = new RecordingBridge(true);
        Recorder out = new Recorder();
        with(bridge, fixed(volumes), out, () -> {
            InGamePrompts.clearFocus(player);
            PromptModule.FOCUS_MODE.setCorner(player, 1, origin);
            PromptModule.FOCUS_MODE.setCorner(player, 2, origin.offset(5, 1, 1)); // past the context box: clipped
            helper.assertTrue(out.barOf(player).getLast().contains("clipped"), "the player is warned that the focus box was clipped");
            helper.assertTrue(PromptModule.FOCUS_MODE.outline(player).equals(List.of(new Box(origin.getX(), origin.getY(), origin.getZ(), origin.getX() + 3, origin.getY() + 1, origin.getZ() + 1))),
                    "the focus outline is the clipped box");
            run(player, "autosketch build put a balcony here");
        });
        helper.assertTrue(bridge.sent.size() == 1, "one prompt sent, got " + bridge.sent.size());
        JsonObject h = bridge.sent.getFirst().header();
        helper.assertTrue(h.get("type").getAsString().equals("prompt"), "type prompt");
        helper.assertTrue(h.get("mode").getAsString().equals("build"), "mode build (B6): " + h.get("mode"));
        helper.assertTrue(!h.has("scan"), "no scan grant outside scan mode");
        helper.assertTrue(h.get("text").getAsString().equals("put a balcony here"), "text");
        helper.assertTrue(h.getAsJsonObject("player").get("uuid").getAsString().equals(player.getUUID().toString()), "player uuid");
        helper.assertTrue(h.getAsJsonObject("player").get("name").getAsString().equals(player.getGameProfile().getName()), "player name");
        JsonObject c = h.getAsJsonObject("context");
        helper.assertTrue(c.get("dimension").getAsString().equals(helper.getLevel().dimension().location().toString()), "dimension");
        helper.assertTrue(c.get("yaw").getAsDouble() == 0 && c.get("pitch").getAsDouble() == 0, "yaw and pitch " + c.get("yaw") + " " + c.get("pitch"));
        helper.assertTrue(c.get("facing").getAsString().equals("south"), "facing south");
        JsonArray eye = c.getAsJsonArray("eye");
        helper.assertTrue(Math.abs(eye.get(0).getAsDouble() - (block.getX() + 0.5)) < 1e-6 && Math.abs(eye.get(1).getAsDouble() - (block.getY() + 0.5)) < 1e-6, "eye position " + eye);
        JsonObject t = c.getAsJsonObject("target");
        helper.assertTrue(t != null, "a crosshair target");
        int[] tp = ints(t.getAsJsonArray("pos"));
        helper.assertTrue(tp[0] == block.getX() && tp[1] == block.getY() && tp[2] == block.getZ(), "target position");
        helper.assertTrue(t.get("state").getAsString().equals("minecraft:oak_planks"), "target state " + t.get("state"));
        helper.assertTrue(t.get("face").getAsString().equals("north"), "target face " + t.get("face"));
        Box focus;
        try {
            focus = Box.fromJson(c.get("focus"), "focus", null);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        helper.assertTrue(focus.equals(new Box(origin.getX(), origin.getY(), origin.getZ(), origin.getX() + 3, origin.getY() + 1, origin.getZ() + 1)), "focus clipped to the context box: " + focus);
        helper.assertTrue(c.has("focusClipped") && c.get("focusClipped").getAsBoolean(), "focusClipped");
        helper.assertTrue(out.barOf(player).getLast().contains("asking"), "the action bar says the request went out");
        InGamePrompts.clearFocus(player);
        leave(player);
        helper.succeed();
    }

    @GameTest(template = "empty")
    public static void refusedResultShowsItsReasonOnTheActionBar(GameTestHelper helper) {
        ServerPlayer player = helper.makeMockServerPlayerInLevel();
        RecordingBridge bridge = new RecordingBridge(true);
        Recorder out = new Recorder();
        with(bridge, fixed(null), out, () -> {
            run(player, "autosketch ask hello");
            long id = bridge.sent.getFirst().id();
            JsonObject result = Json.header("prompt.result");
            result.addProperty("id", id);
            result.addProperty("delivered", false);
            result.addProperty("reason", "not_allowed");
            try {
                InGamePrompts.onResult(result, player.getServer());
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        helper.assertTrue(out.barOf(player).getLast().contains("not on the agent's allowed players"), "the reason on the action bar: " + out.barOf(player));
        // With no MCP connected at all, the mod says no_link itself and sends nothing.
        RecordingBridge down = new RecordingBridge(false);
        with(down, fixed(null), out, () -> run(player, "autosketch ask hello"));
        helper.assertTrue(down.sent.isEmpty(), "nothing sent while disconnected");
        helper.assertTrue(out.barOf(player).getLast().contains("no linked world"), "no_link on the action bar: " + out.barOf(player));
        leave(player);
        helper.succeed();
    }

    /** B6: each subcommand sends its mode; a mode the MCP's hello doesn't list is refused here and nothing is sent. */
    @GameTest(template = "empty")
    public static void subcommandsSendTheirModeAndUnlistedModesAreRefused(GameTestHelper helper) {
        ServerPlayer player = helper.makeMockServerPlayerInLevel();
        Recorder out = new Recorder();
        RecordingBridge all = new RecordingBridge(true);
        with(all, fixed(null), out, () -> {
            run(player, "autosketch ask what is this made of?");
            run(player, "autosketch plan a gatehouse");
            run(player, "autosketch build a gatehouse");
        });
        List<String> modes = all.sent.stream().map(f -> f.header().get("mode").getAsString()).toList();
        helper.assertTrue(modes.equals(List.of("ask", "plan", "build")), "modes sent: " + modes);
        helper.assertTrue(all.sent.getFirst().header().get("text").getAsString().equals("what is this made of?"), "text");

        RecordingBridge buildOnly = new RecordingBridge(true, List.of("build"));
        with(buildOnly, fixed(null), out, () -> run(player, "autosketch ask what is this?"));
        helper.assertTrue(buildOnly.sent.isEmpty(), "an ask request to an MCP listing only build sends nothing");
        helper.assertTrue(out.barOf(player).getLast().contains("doesn't accept ask requests"), "unsupported_mode on the action bar: " + out.barOf(player));
        with(buildOnly, fixed(null), out, () -> run(player, "autosketch plan a wall"));
        helper.assertTrue(buildOnly.sent.isEmpty() && out.barOf(player).getLast().contains("doesn't accept plan requests"), "plan refused too");

        // The MCP refusing a mode itself shows the same way.
        with(all, fixed(null), out, () -> {
            run(player, "autosketch ask hello");
            JsonObject result = Json.header("prompt.result");
            result.addProperty("id", all.sent.getLast().id());
            result.addProperty("delivered", false);
            result.addProperty("reason", "unsupported_mode");
            try {
                InGamePrompts.onResult(result, player.getServer());
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        });
        helper.assertTrue(out.barOf(player).getLast().contains("doesn't accept this request mode"), "prompt.result unsupported_mode: " + out.barOf(player));
        leave(player);
        helper.succeed();
    }

    /** B4: /autosketch scan [radius] [text] sends a scan request with its grant; an MCP without scan gets nothing. */
    @GameTest(template = "empty")
    public static void scanSendsItsGrantAndIsRefusedWhenUnlisted(GameTestHelper helper) {
        ServerPlayer player = helper.makeMockServerPlayerInLevel();
        Recorder out = new Recorder();
        dev.autosketch.mod.world.ScanGrants.clear();
        RecordingBridge noScan = new RecordingBridge(true);
        with(noScan, fixed(null), out, () -> run(player, "autosketch scan the tower"));
        helper.assertTrue(noScan.sent.isEmpty(), "a scan request to an MCP whose hello lacks scan sends nothing");
        helper.assertTrue(out.barOf(player).getLast().contains("doesn't accept scan requests"), "unsupported_mode on the action bar: " + out.barOf(player));
        helper.assertTrue(dev.autosketch.mod.world.ScanGrants.current() == null, "and grants nothing");

        RecordingBridge all = new RecordingBridge(true, List.of("ask", "scan", "plan", "build"));
        with(all, fixed(null), out, () -> {
            run(player, "autosketch scan");
            run(player, "autosketch scan the tower and the courtyard");
            run(player, "autosketch scan 20 the tower");
        });
        helper.assertTrue(all.sent.size() == 3, "three scan requests sent: " + all.sent.size());
        try {
            var plain = dev.autosketch.mod.protocol.Messages.Prompt.decode(all.sent.get(0));
            var texted = dev.autosketch.mod.protocol.Messages.Prompt.decode(all.sent.get(1));
            var big = dev.autosketch.mod.protocol.Messages.Prompt.decode(all.sent.get(2));
            helper.assertTrue(plain.mode().equals("scan") && plain.text().isEmpty() && plain.scan().radius() == 4 && !plain.scan().clipped(), "default radius 4, no text: " + plain);
            helper.assertTrue(texted.text().equals("the tower and the courtyard") && texted.scan().radius() == 4, "text without a radius: " + texted.text());
            helper.assertTrue(big.text().equals("the tower") && big.scan().radius() == 12 && big.scan().clipped(), "radius 20 clipped to 12: " + big.scan());
            BlockPos feet = player.blockPosition();
            int cx = feet.getX() >> 4;
            helper.assertTrue(big.scan().columns().minX() == 16 * (cx - 12) && big.scan().columns().maxX() == 16 * (cx + 12) + 15, "columns of the chunks within 12");
            helper.assertTrue(big.scan().box().minY() == Math.max(helper.getLevel().getMinBuildHeight(), feet.getY() - 32), "the box reaches scanBelow under the feet");
            var held = dev.autosketch.mod.world.ScanGrants.current();
            helper.assertTrue(held != null && held.grant().equals(big.scan()) && held.dimension().equals(helper.getLevel().dimension()), "the latest scan's grant is in force");
        } catch (dev.autosketch.mod.protocol.ProtocolException e) {
            throw new RuntimeException(e);
        }
        helper.assertTrue(out.barOf(player).getLast().contains("scanChunksMax"), "the clipped radius is warned about: " + out.barOf(player));
        dev.autosketch.mod.world.ScanGrants.clear();
        leave(player);
        helper.succeed();
    }

    /**
     * B6: {@code /autosketch done} (and {@code /<alias> done}) sends {@code prompt.close} only to an MCP
     * whose hello lists {@code prompt.close}; an older MCP is refused on the action bar with nothing
     * sent, and with no connection the player hears no_link. The MCP's answer is a notice to that
     * player, shown whatever their notices setting.
     */
    @GameTest(template = "empty")
    public static void doneIsSentOnlyToAnMcpListingPromptClose(GameTestHelper helper) {
        ServerPlayer player = helper.makeMockServerPlayerInLevel();
        Recorder out = new Recorder();
        RecordingBridge listed = new RecordingBridge(true, List.of("ask", "scan", "plan", "build"), List.of("prompt.close"));
        with(listed, fixed(null), out, () -> run(player, "autosketch done"));
        helper.assertTrue(listed.sent.size() == 1, "one prompt.close sent, got " + listed.sent.size());
        Frame f = listed.sent.getFirst();
        helper.assertTrue(f.type().equals("prompt.close") && f.id() == null, "type prompt.close, no id: " + f.header());
        try {
            var close = dev.autosketch.mod.protocol.Messages.PromptClose.decode(f);
            helper.assertTrue(close.player().uuid().equals(player.getUUID()) && close.player().name().equals(player.getGameProfile().getName()), "the player: " + close.player());
        } catch (dev.autosketch.mod.protocol.ProtocolException e) {
            throw new RuntimeException(e);
        }
        helper.assertTrue(out.barOf(player).getLast().contains("ending the open request"), "the action bar says it went out: " + out.barOf(player));
        // The alias root has it too.
        var dispatcher = new com.mojang.brigadier.CommandDispatcher<net.minecraft.commands.CommandSourceStack>();
        PromptModule.alias(dispatcher, "zz");
        helper.assertTrue(dispatcher.getRoot().getChild("zz").getChild("done") != null, "/zz done");

        RecordingBridge old = new RecordingBridge(true, List.of("ask", "scan", "plan", "build"));
        with(old, fixed(null), out, () -> run(player, "autosketch done"));
        helper.assertTrue(old.sent.isEmpty(), "nothing sent to an MCP whose hello lacks prompt.close");
        helper.assertTrue(out.barOf(player).getLast().equals(InGamePrompts.DONE_UNSUPPORTED), "the MCP needs updating, on the action bar: " + out.barOf(player));

        RecordingBridge down = new RecordingBridge(false);
        with(down, fixed(null), out, () -> run(player, "autosketch done"));
        helper.assertTrue(down.sent.isEmpty() && out.barOf(player).getLast().contains("no linked world"), "no_link while disconnected: " + out.barOf(player));
        leave(player);
        helper.succeed();
    }

    /** B6: askAlias is a short root for the request subcommands. */
    @GameTest(template = "empty")
    public static void aliasIsAShortRootForRequests(GameTestHelper helper) {
        var dispatcher = new com.mojang.brigadier.CommandDispatcher<net.minecraft.commands.CommandSourceStack>();
        PromptModule.alias(dispatcher, "zz");
        var root = dispatcher.getRoot().getChild("zz");
        helper.assertTrue(root != null, "the alias is registered");
        for (String m : List.of("ask", "scan", "plan", "build")) helper.assertTrue(root.getChild(m) != null, "/zz " + m);
        PromptModule.alias(dispatcher, "Bad Name");
        helper.assertTrue(dispatcher.getRoot().getChild("Bad Name") == null, "a malformed alias is skipped");
        helper.succeed();
    }

    @GameTest(template = "empty")
    public static void chatRespectsEachPlayersLogSetting(GameTestHelper helper) {
        MinecraftServer server = helper.getLevel().getServer();
        ServerPlayer asker = helper.makeMockServerPlayerInLevel();
        ServerPlayer watcher = helper.makeMockServerPlayerInLevel();
        ServerPlayer quiet = helper.makeMockServerPlayerInLevel();
        // The GameTest server's default op level is 0, so op the players at level 2 explicitly.
        for (ServerPlayer p : List.of(asker, watcher, quiet)) server.getPlayerList().getOps().add(new ServerOpListEntry(p.getGameProfile(), 2, false));
        ServerPlayer stranger = helper.makeMockServerPlayerInLevel(); // not an op: never sees agent output
        Recorder out = new Recorder();
        with(new RecordingBridge(true), fixed(null), out, () -> {
            run(watcher, "autosketch log all");
            run(quiet, "autosketch log off");
            InGamePrompts.setLogMode(stranger, LogMode.ALL); // as if set while still an op
            helper.assertTrue(InGamePrompts.logMode(asker) == LogMode.MINE, "mine by default");
            helper.assertTrue(InGamePrompts.logMode(watcher) == LogMode.ALL && InGamePrompts.logMode(quiet) == LogMode.OFF, "log commands set the mode");
            chat(server, 1L, asker.getUUID(), "activity", "fill: 1,204 blocks");
            chat(server, 1L, asker.getUUID(), "reply", "Done: a balcony on the south wall.");
            chat(server, null, null, "activity", "render: 1 image");
            chat(server, 2L, quiet.getUUID(), "activity", "fill: 3 blocks");
            chat(server, 2L, quiet.getUUID(), "reply", "x".repeat(150));
        });
        helper.assertTrue(out.chatOf(asker).equals(List.of("· fill: 1,204 blocks", "Agent: Done: a balcony on the south wall.")), "asker (mine): " + out.chatOf(asker));
        helper.assertTrue(out.chatOf(watcher).size() == 6, "watcher (all) sees everything, the long reply wrapped: " + out.chatOf(watcher));
        helper.assertTrue(out.chatOf(watcher).get(2).equals("· render: 1 image"), "watcher sees unprompted activity");
        helper.assertTrue(out.chatOf(quiet).equals(List.of("Agent: " + "x".repeat(100), "Agent: " + "x".repeat(50))), "quiet (off) sees only replies to itself, wrapped: " + out.chatOf(quiet));
        helper.assertTrue(out.chatOf(stranger).isEmpty(), "a player who isn't an op sees nothing: " + out.chatOf(stranger));
        leave(asker, watcher, quiet, stranger);
        helper.succeed();
    }

    private static void chat(MinecraftServer server, @Nullable Long request, @Nullable UUID player, String kind, String... lines) {
        JsonObject h = Json.header("chat");
        h.add("request", Json.nullable(request));
        h.add("player", Json.nullable(player == null ? null : player.toString()));
        h.addProperty("kind", kind);
        h.add("lines", Json.strings(List.of(lines)));
        try {
            InGamePrompts.onChat(h, server);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
