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

        RecordingBridge(boolean connected) {
            this.connected = connected;
        }

        @Override
        public boolean connected() {
            return connected;
        }

        @Override
        public @Nullable BridgeSession session() {
            return connected ? new BridgeSession(1, "test", "0", new JsonObject()) : null;
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
            run(player, "autosketch ask put a balcony here");
        });
        helper.assertTrue(bridge.sent.size() == 1, "one prompt sent, got " + bridge.sent.size());
        JsonObject h = bridge.sent.getFirst().header();
        helper.assertTrue(h.get("type").getAsString().equals("prompt"), "type prompt");
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

    @GameTest(template = "empty")
    public static void chatRespectsEachPlayersLogSetting(GameTestHelper helper) {
        MinecraftServer server = helper.getLevel().getServer();
        ServerPlayer asker = helper.makeMockServerPlayerInLevel();
        ServerPlayer watcher = helper.makeMockServerPlayerInLevel();
        ServerPlayer quiet = helper.makeMockServerPlayerInLevel();
        for (ServerPlayer p : List.of(asker, watcher, quiet)) server.getPlayerList().op(p.getGameProfile());
        Recorder out = new Recorder();
        with(new RecordingBridge(true), fixed(null), out, () -> {
            run(watcher, "autosketch log all");
            run(quiet, "autosketch log off");
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
        leave(asker, watcher, quiet);
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
