package dev.autosketch.mod.gametest.client.replay;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.autosketch.mod.client.ui.AutosketchKeys;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.replay.ReplayCamera;
import dev.autosketch.mod.client.ui.replay.ReplayClient;
import dev.autosketch.mod.client.ui.replay.ReplayHud;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import dev.autosketch.mod.world.States;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;
import org.lwjgl.glfw.GLFW;

/**
 * Replay in the world, client half (16, *Replay in the world*; briefs/ui/R, *Done when*), in a real
 * client against the fake MCP, compared with the integrated server in the same process. The fake
 * MCP's script is built per test, since frames name the player's UUID.
 *
 * <p>The volume is a 3×3×3 box just above the flat test world's grass, near the player, so its
 * chunks are loaded; its keyframe mixes three states by index.
 */
public final class ReplayClientTests {
    private ReplayClientTests() {}

    static final String DIM = "minecraft:overworld";
    static final int X0 = 3, Y0 = -60, Z0 = 3, X1 = 5, Y1 = -58, Z1 = 5;
    static final List<String> PALETTE = List.of("minecraft:gold_block", "minecraft:diamond_block", "minecraft:air");
    static final BlockPos DELTA_A = new BlockPos(4, -59, 4), DELTA_B = new BlockPos(3, -60, 3);
    static final BlockPos INSIDE = new BlockPos(5, -58, 5), OUTSIDE = new BlockPos(8, -60, 8);

    static List<BlockPos> volume() {
        List<BlockPos> out = new ArrayList<>();
        for (int y = Y0; y <= Y1; y++)
            for (int z = Z0; z <= Z1; z++)
                for (int x = X0; x <= X1; x++) out.add(new BlockPos(x, y, z));
        return out;
    }

    /** The keyframe's state at a position: index order x, then z, then y. */
    static String keyframeState(BlockPos p) {
        int i = (p.getX() - X0) + 3 * ((p.getZ() - Z0) + 3 * (p.getY() - Y0));
        return PALETTE.get(i % 3);
    }

    static JsonObject box(int x0, int y0, int z0, int x1, int y1, int z1) {
        JsonObject b = new JsonObject();
        JsonArray min = new JsonArray(), max = new JsonArray();
        min.add(x0);
        min.add(y0);
        min.add(z0);
        max.add(x1);
        max.add(y1);
        max.add(z1);
        b.add("min", min);
        b.add("max", max);
        return b;
    }

    static JsonArray players(ClientTestSuite s) {
        JsonArray a = new JsonArray();
        a.add(s.player().getUUID().toString());
        return a;
    }

    static JsonObject hud(String call) {
        JsonObject h = new JsonObject();
        h.addProperty("call", call);
        h.add("brief", com.google.gson.JsonNull.INSTANCE);
        return h;
    }

    static JsonObject keyframe(ClientTestSuite s) {
        JsonObject f = new JsonObject();
        f.addProperty("type", "replay.frame");
        f.add("players", players(s));
        f.addProperty("replay", "r1");
        f.addProperty("step", 0);
        f.addProperty("steps", 4);
        f.addProperty("keyframe", true);
        f.addProperty("dimension", DIM);
        f.addProperty("time", "2026-11-17T10:00:00.000Z");
        f.add("hud", hud("doc_open: house"));
        JsonObject job = new JsonObject();
        job.addProperty("id", "j1");
        job.addProperty("colour", "#3fa7d6");
        job.addProperty("brief", "the tower");
        job.addProperty("dimension", DIM);
        job.add("work", box(X0, Y0, Z0, X1, Y1, Z1));
        job.add("context", new JsonArray());
        JsonArray jobs = new JsonArray();
        jobs.add(job);
        f.add("jobs", jobs);
        f.add("flashes", new JsonArray());
        JsonArray pal = new JsonArray();
        PALETTE.forEach(pal::add);
        f.add("palette", pal);
        JsonArray states = new JsonArray();
        for (int i = 0; i < 27; i++) states.add(i % 3);
        JsonObject region = new JsonObject();
        region.add("box", box(X0, Y0, Z0, X1, Y1, Z1));
        region.add("states", states);
        JsonArray regions = new JsonArray();
        regions.add(region);
        f.add("regions", regions);
        JsonArray markers = new JsonArray();
        markers.add(marker(1, "fork", "j1"));
        markers.add(marker(3, "merge", "j1"));
        f.add("markers", markers);
        return f;
    }

    static JsonObject marker(int step, String kind, String label) {
        JsonObject m = new JsonObject();
        m.addProperty("step", step);
        m.addProperty("kind", kind);
        m.addProperty("label", label);
        return m;
    }

    static JsonObject delta(ClientTestSuite s) {
        JsonObject f = new JsonObject();
        f.addProperty("type", "replay.frame");
        f.add("players", players(s));
        f.addProperty("replay", "r1");
        f.addProperty("step", 1);
        f.addProperty("steps", 4);
        f.addProperty("keyframe", false);
        f.addProperty("from", 0);
        f.addProperty("dimension", DIM);
        f.addProperty("time", "2026-11-17T10:00:05.000Z");
        f.add("hud", hud("set_blocks: 2 blocks"));
        f.add("jobs", new JsonArray());
        JsonArray flashes = new JsonArray();
        JsonObject fl = new JsonObject();
        fl.addProperty("job", "base");
        fl.addProperty("colour", "#ffffff");
        fl.addProperty("dimension", DIM);
        JsonArray boxes = new JsonArray();
        boxes.add(box(3, -60, 3, 4, -59, 4));
        fl.add("boxes", boxes);
        flashes.add(fl);
        f.add("flashes", flashes);
        JsonArray blocks = new JsonArray();
        blocks.add(block(DELTA_A, "minecraft:air"));
        blocks.add(block(DELTA_B, "minecraft:oak_planks"));
        f.add("blocks", blocks);
        return f;
    }

    static JsonObject block(BlockPos p, String state) {
        JsonObject b = new JsonObject();
        JsonArray pos = new JsonArray();
        pos.add(p.getX());
        pos.add(p.getY());
        pos.add(p.getZ());
        b.add("pos", pos);
        b.addProperty("state", state);
        return b;
    }

    static JsonObject ok(JsonObject result) {
        JsonObject r = new JsonObject();
        r.addProperty("type", "ui.result");
        r.addProperty("ok", true);
        r.add("result", result);
        return r;
    }

    static JsonObject reply(String kind, JsonObject... send) {
        JsonObject r = new JsonObject();
        r.addProperty("on", "ui.request");
        r.addProperty("kind", kind);
        JsonArray a = new JsonArray();
        for (JsonObject o : send) a.add(o);
        r.add("send", a);
        return r;
    }

    /**
     * The fake MCP's script: logs listed, {@code replay.open} answered with the keyframe, and
     * {@code replay.seek} answered with the delta from 0 to 1 ({@code withDelta}) or with a result
     * only (the key tests, which read the requests).
     */
    static String script(ClientTestSuite s, boolean withDelta) {
        JsonObject opened = new JsonObject();
        opened.addProperty("replay", "r1");
        opened.addProperty("steps", 4);
        opened.addProperty("step", 0);
        opened.addProperty("dimension", DIM);
        opened.add("volume", box(X0, Y0, Z0, X1, Y1, Z1));
        JsonArray replies = new JsonArray();
        replies.add(reply("replay.open", ok(opened), keyframe(s)));
        JsonObject seeked = new JsonObject();
        seeked.addProperty("step", 1);
        replies.add(withDelta ? reply("replay.seek", ok(seeked), delta(s)) : reply("replay.seek", ok(seeked)));
        JsonObject results = new JsonObject();
        JsonObject logs = new JsonObject();
        JsonArray list = new JsonArray();
        JsonObject live = new JsonObject();
        live.addProperty("id", "s2");
        live.addProperty("doc", "house");
        live.addProperty("session", "s2");
        live.addProperty("modified", "2026-11-17T10:05:00Z");
        live.addProperty("live", true);
        JsonObject old = new JsonObject();
        old.addProperty("id", "s1");
        old.addProperty("doc", "barn");
        old.addProperty("session", "s1");
        old.addProperty("modified", "2026-11-16T09:00:00Z");
        old.addProperty("live", false);
        list.add(live);
        list.add(old);
        JsonObject lr = new JsonObject();
        lr.add("logs", list);
        logs.addProperty("ok", true);
        logs.add("result", lr);
        results.add("logs.list", logs);
        JsonObject closed = new JsonObject();
        closed.addProperty("ok", true);
        closed.add("result", new JsonObject());
        results.add("replay.close", closed);
        JsonObject root = new JsonObject();
        root.add("replies", replies);
        root.add("results", results);
        return root.toString();
    }

    static BlockState client(ClientTestSuite s, BlockPos p) {
        return s.mc().level.getBlockState(p);
    }

    /** The player at a known spot near the volume, the volume's server blocks reset to air, and the fake MCP on this test's script. */
    static void setUp(ClientTestSuite s, boolean withDelta) {
        s.step("fake MCP with the replay script", () -> s.startMcp(script(s, withDelta)));
        s.waitUntil("connected", () -> LinkState.connected(), 400);
        s.step("player near the volume; the volume is air on the server", () -> {
            s.command("tp @s 0.5 -60 0.5 -45 20");
            s.onServer(server -> {
                var level = server.overworld();
                for (BlockPos p : volume()) level.setBlockAndUpdate(p, Blocks.AIR.defaultBlockState());
                level.setBlockAndUpdate(OUTSIDE, Blocks.AIR.defaultBlockState());
                return null;
            });
        });
        s.waitUntil("the client sees the volume as air", () -> {
            for (BlockPos p : volume()) check(client(s, p).isAir(), "client block at " + p + " is " + client(s, p));
            return true;
        }, 200);
    }

    static void open(ClientTestSuite s) {
        s.step("/autosketch replay live", () -> s.command("autosketch replay live"));
        s.waitUntil("the keyframe is in the client's world", () -> {
            check(ReplayClient.settled() && ReplayClient.step() == 0, "replay " + ReplayClient.replay() + " at step " + ReplayClient.step());
            return true;
        }, 400);
    }

    static ClientTestSuite.Condition matchesServer(ClientTestSuite s) {
        return () -> {
            List<BlockState> server = s.onServer(sv -> volume().stream().map(p -> sv.overworld().getBlockState(p)).toList());
            List<BlockPos> v = volume();
            for (int i = 0; i < v.size(); i++) check(client(s, v.get(i)) == server.get(i), "client " + client(s, v.get(i)) + " at " + v.get(i) + ", server " + server.get(i));
            return true;
        };
    }

    static void closeAfter(ClientTestSuite s) {
        s.cleanup("replay closed", () -> {
            if (ReplayClient.isOpen()) ReplayClient.close();
            if (s.mc().screen != null) s.mc().setScreen(null);
        });
    }

    /**
     * {@code /autosketch replay} lists the logs newest first as clickable lines; {@code replay live}
     * opens the live session; after the keyframe every position equals the frame's; a delta changes
     * exactly its positions; a server change inside the volume doesn't show while one outside does;
     * Backspace (a real key press) sends {@code replay.close}, and then the client matches the
     * server's world.
     */
    @ClientTest("replay")
    public static void framesOverrideTheClientAndCloseRestoresTheServersWorld(ClientTestSuite s) {
        setUp(s, true);
        s.step("/autosketch replay", () -> s.command("autosketch replay"));
        s.waitUntil("the logs are listed newest first, each running its replay command", () -> {
            var lines = ReplayClient.listed();
            check(lines.size() == 2, "listed " + lines);
            check(lines.get(0).getString().contains("house") && lines.get(0).getString().contains("live"), "first line " + lines.get(0).getString());
            check(lines.get(1).getString().contains("barn"), "second line " + lines.get(1).getString());
            var click0 = lines.get(0).getStyle().getClickEvent();
            var click1 = lines.get(1).getStyle().getClickEvent();
            check(click0 != null && click0.getValue().equals("/autosketch replay live"), "live line runs /autosketch replay live");
            check(click1 != null && click1.getValue().equals("/autosketch replay s1"), "the other runs /autosketch replay s1");
            return true;
        }, 200);
        open(s);
        s.step("every position equals the keyframe's", () -> {
            for (BlockPos p : volume()) check(States.print(client(s, p)).equals(keyframeState(p)), "client " + client(s, p) + " at " + p + ", frame " + keyframeState(p));
            check(ReplayHud.lines().get(1).equals("doc_open: house"), "the strip shows the call: " + ReplayHud.lines());
            check(ReplayClient.markerSteps().equals(List.of(1L, 3L)), "markers " + ReplayClient.markerSteps());
        });
        s.step("step forward", () -> s.click(AutosketchKeys.REPLAY_FORWARD));
        s.waitUntil("the delta is applied", () -> ReplayClient.settled() && ReplayClient.step() == 1, 200);
        s.step("the delta changed exactly its positions", () -> {
            for (BlockPos p : volume()) {
                String want = p.equals(DELTA_A) ? "minecraft:air" : p.equals(DELTA_B) ? "minecraft:oak_planks" : keyframeState(p);
                check(States.print(client(s, p)).equals(want), "client " + client(s, p) + " at " + p + ", want " + want);
            }
            check(ReplayHud.lines().get(1).equals("set_blocks: 2 blocks"), "the strip follows: " + ReplayHud.lines());
        });
        s.step("the server changes a block inside the volume and one outside", () -> s.onServer(server -> {
            server.overworld().setBlockAndUpdate(INSIDE, Blocks.EMERALD_BLOCK.defaultBlockState());
            server.overworld().setBlockAndUpdate(OUTSIDE, Blocks.EMERALD_BLOCK.defaultBlockState());
            return null;
        }));
        s.waitUntil("the outside change arrives", () -> client(s, OUTSIDE).is(Blocks.EMERALD_BLOCK), 200);
        s.waitFrames("a few more frames", 5);
        s.step("the inside change doesn't show", () -> check(States.print(client(s, INSIDE)).equals(keyframeState(INSIDE)), "client " + client(s, INSIDE) + " at " + INSIDE));
        s.step("until close, the client differs from the server inside the volume", () -> {
            boolean differs = false;
            try {
                matchesServer(s).test();
            } catch (ClientTestSuite.Failure f) {
                differs = true;
            }
            check(differs, "the client already matched the server during replay");
        });
        s.step("Backspace (a real key)", () -> {
            long w = s.mc().getWindow().getWindow();
            s.mc().keyboardHandler.keyPress(w, GLFW.GLFW_KEY_BACKSPACE, 0, GLFW.GLFW_PRESS, 0);
            s.mc().keyboardHandler.keyPress(w, GLFW.GLFW_KEY_BACKSPACE, 0, GLFW.GLFW_RELEASE, 0);
        });
        s.waitUntil("replay.close is sent and the replay is closed", () -> {
            check(!ReplayClient.isOpen(), "replay still open");
            return s.mcp().received("ui.request").stream().anyMatch(r -> r.get("kind").getAsString().equals("replay.close")
                    && r.getAsJsonObject("args").get("replay").getAsString().equals("r1"));
        }, 200);
        s.waitUntil("the client shows exactly the server's world in the volume", matchesServer(s), 400);
        closeAfter(s);
    }

    /**
     * The camera is detached and the player frozen: holding forward moves the camera, not the player
     * (client or server); Esc still opens the pause menu, and the replay stays open.
     */
    @ClientTest("replay")
    public static void cameraDetachedPlayerFrozenEscStillPauses(ClientTestSuite s) {
        setUp(s, false);
        open(s);
        Vec3[] at = new Vec3[2];
        s.step("the camera is detached; hold forward", () -> {
            check(ReplayCamera.detached(), "camera not detached");
            check(s.mc().getCameraEntity() != s.player(), "the camera is the player");
            at[0] = s.player().position();
            at[1] = s.mc().getCameraEntity().position();
            s.hold(s.mc().options.keyUp, true);
        });
        s.waitUntil("the camera moves 6 blocks", () -> s.mc().getCameraEntity().position().distanceTo(at[1]) > 6, 200);
        s.step("release; the player didn't move", () -> {
            s.hold(s.mc().options.keyUp, false);
            check(s.player().position().distanceTo(at[0]) < 1e-6, "client player moved from " + at[0] + " to " + s.player().position());
            Vec3 server = s.onServer(sv -> s.serverPlayer(sv).position());
            check(server.distanceTo(at[0]) < 1e-3, "server player at " + server + ", stood at " + at[0]);
            check(s.mc().gameMode.getPlayerMode() == net.minecraft.world.level.GameType.CREATIVE, "no game-mode change: " + s.mc().gameMode.getPlayerMode());
        });
        s.step("Esc (a real key)", () -> {
            long w = s.mc().getWindow().getWindow();
            s.mc().keyboardHandler.keyPress(w, GLFW.GLFW_KEY_ESCAPE, 0, GLFW.GLFW_PRESS, 0);
            s.mc().keyboardHandler.keyPress(w, GLFW.GLFW_KEY_ESCAPE, 0, GLFW.GLFW_RELEASE, 0);
        });
        s.waitUntil("the pause menu opens and the replay stays open", () -> s.mc().screen instanceof PauseScreen && ReplayClient.isOpen(), 100);
        s.step("back to the game; close", () -> {
            s.mc().setScreen(null);
            s.click(AutosketchKeys.REPLAY_CLOSE);
        });
        s.waitUntil("the camera is the player again", () -> !ReplayClient.isOpen() && s.mc().getCameraEntity() == s.player(), 100);
        closeAfter(s);
    }

    private static List<Long> seeks(ClientTestSuite s) {
        List<Long> out = new ArrayList<>();
        for (JsonObject r : s.mcp().received("ui.request"))
            if (r.get("kind").getAsString().equals("replay.seek")) out.add(r.getAsJsonObject("args").get("step").getAsLong());
        return out;
    }

    private static void press(ClientTestSuite s, String name, Runnable press, List<Long> want) {
        s.step(name, press::run);
        s.waitUntil(name + " sends seeks " + want, () -> {
            check(seeks(s).equals(want), "seeks " + seeks(s));
            return true;
        }, 200);
    }

    /**
     * Each replay key: forward, back and scroll send {@code replay.seek} for the next step; the marker
     * keys seek to the next and previous marker; play and pause; slower and faster change the local
     * speed; Backspace sends {@code replay.close}.
     */
    @ClientTest("replay")
    public static void eachReplayKeySendsItsRequest(ClientTestSuite s) {
        setUp(s, false);
        open(s);
        press(s, "forward", () -> s.click(AutosketchKeys.REPLAY_FORWARD), List.of(1L));
        press(s, "forward again", () -> s.click(AutosketchKeys.REPLAY_FORWARD), List.of(1L, 2L));
        press(s, "back", () -> s.click(AutosketchKeys.REPLAY_BACK), List.of(1L, 2L, 1L));
        press(s, "next marker", () -> s.click(AutosketchKeys.REPLAY_NEXT_MARKER), List.of(1L, 2L, 1L, 3L));
        press(s, "previous marker", () -> s.click(AutosketchKeys.REPLAY_PREVIOUS_MARKER), List.of(1L, 2L, 1L, 3L, 1L));
        press(s, "scroll up", () -> check(s.scroll(1), "the scroll wasn't taken"), List.of(1L, 2L, 1L, 3L, 1L, 2L));
        s.step("slower, then faster twice", () -> {
            check(ReplayClient.speed() == ReplayClient.SPEEDS[ReplayClient.DEFAULT_SPEED], "default speed " + ReplayClient.speed());
            s.click(AutosketchKeys.REPLAY_SLOWER);
        });
        s.waitUntil("slower", () -> ReplayClient.speed() == ReplayClient.SPEEDS[ReplayClient.DEFAULT_SPEED - 1], 100);
        s.step("faster twice", () -> {
            s.click(AutosketchKeys.REPLAY_FASTER);
            s.click(AutosketchKeys.REPLAY_FASTER);
        });
        s.waitUntil("faster", () -> ReplayClient.speed() == ReplayClient.SPEEDS[ReplayClient.DEFAULT_SPEED + 1], 100);
        s.step("play", () -> s.click(AutosketchKeys.REPLAY_PLAY));
        s.waitUntil("playing", ReplayClient::playing, 100);
        s.step("pause", () -> s.click(AutosketchKeys.REPLAY_PLAY));
        s.waitUntil("paused", () -> !ReplayClient.playing(), 100);
        s.step("close", () -> s.click(AutosketchKeys.REPLAY_CLOSE));
        s.waitUntil("replay.close is sent", () -> !ReplayClient.isOpen()
                && s.mcp().received("ui.request").stream().anyMatch(r -> r.get("kind").getAsString().equals("replay.close")), 200);
        closeAfter(s);
    }

    /**
     * The MCP going away mid-replay: the client gives the camera back, and the server half resends
     * the volume's chunks itself, so the client matches the server again.
     */
    @ClientTest("replay")
    public static void mcpGoingAwayClosesTheReplay(ClientTestSuite s) {
        setUp(s, false);
        open(s);
        s.step("the MCP goes away", s::stopMcp);
        s.waitUntil("offline, replay closed, camera back", () -> !LinkState.connected() && !ReplayClient.isOpen() && s.mc().getCameraEntity() == s.player(), 400);
        s.waitUntil("the client shows exactly the server's world in the volume", matchesServer(s), 400);
        s.cleanup("an MCP again", () -> s.startMcp("{}"));
    }
}
