package dev.autosketch.mod.gametest.client.ghost;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import com.mojang.blaze3d.platform.NativeImage;
import dev.autosketch.mod.client.ui.AutosketchKeys;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.UiClient;
import dev.autosketch.mod.client.ui.UiToggles;
import dev.autosketch.mod.client.ui.ghost.Ghosts;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.client.CloudStatus;
import net.minecraft.client.KeyMapping;
import net.minecraft.core.BlockPos;
import org.lwjgl.glfw.GLFW;

/**
 * Ghost blocks in a real client (16, *Ghost blocks*; brief G, *Done when*): a fake MCP's
 * {@code ui.ghost} meshes exactly the sections it covers, an update re-meshes only what it touched,
 * {@code ui.ghost.clear} frees the meshes, the toggle hides and shows, {@code /autosketch ghost here}
 * sends {@code ghost.anchor} with the player's position, nothing draws offline, and a ghost is
 * visible and translucent over terrain (the one pixel check).
 *
 * <p>Each test starts a fake MCP whose script names this player (ghosts name their players) and
 * sends the ghost after the handshake; later updates are replies the fake sends when the test makes
 * the client send a request of a given kind (the fake can't be told to send mid-run otherwise).
 */
public final class GhostClientTests {
    private GhostClientTests() {}

    static final String STONE = "minecraft:stone";
    static final String GLASS = "minecraft:glass";
    static final String AIR = "minecraft:air";
    /** clienttest/ghost.json: the suite's own fake MCP. */
    static final String SUITE_SCRIPT = "{\"hello\":{\"features\":[\"prompt.close\",\"ui\"],\"modes\":[\"build\",\"ask\",\"plan\"]}}";

    // ── script helpers ──────────────────────────────────────────────────────────────────────

    static JsonArray players(ClientTestSuite s) {
        JsonArray a = new JsonArray();
        a.add(s.player().getUUID().toString());
        return a;
    }

    static JsonArray vec(int x, int y, int z) {
        JsonArray a = new JsonArray();
        a.add(x);
        a.add(y);
        a.add(z);
        return a;
    }

    static JsonObject fill(int sx, int sy, int sz, String state) {
        JsonObject o = new JsonObject();
        o.add("section", vec(sx, sy, sz));
        o.addProperty("fill", state);
        return o;
    }

    static JsonObject ghost(ClientTestSuite s, String id, BlockPos origin, String tint, boolean full, List<String> palette, JsonObject... sections) {
        JsonObject g = new JsonObject();
        g.addProperty("type", "ui.ghost");
        g.add("players", players(s));
        g.addProperty("ghost", id);
        g.addProperty("dimension", s.player().level().dimension().location().toString());
        g.add("origin", vec(origin.getX(), origin.getY(), origin.getZ()));
        g.addProperty("tint", tint);
        g.addProperty("full", full);
        JsonArray p = new JsonArray();
        palette.forEach(p::add);
        g.add("palette", p);
        JsonArray secs = new JsonArray();
        for (JsonObject o : sections) secs.add(o);
        g.add("sections", secs);
        return g;
    }

    static JsonObject clearMessage(ClientTestSuite s, String id) {
        JsonObject g = new JsonObject();
        g.addProperty("type", "ui.ghost.clear");
        g.add("players", players(s));
        g.addProperty("ghost", id);
        return g;
    }

    static JsonObject script(JsonArray send, JsonArray replies, JsonObject results) {
        JsonObject hello = new JsonObject();
        JsonArray features = new JsonArray();
        features.add("prompt.close");
        features.add("ui");
        hello.add("features", features);
        JsonObject o = new JsonObject();
        o.add("hello", hello);
        o.add("send", send);
        o.add("replies", replies);
        o.add("results", results);
        return o;
    }

    static JsonObject reply(String kind, JsonObject... send) {
        JsonObject r = new JsonObject();
        r.addProperty("on", "ui.request");
        r.addProperty("kind", kind);
        JsonArray a = new JsonArray();
        for (JsonObject m : send) a.add(m);
        r.add("send", a);
        return r;
    }

    static JsonObject ok(JsonObject result) {
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        o.add("result", result);
        return o;
    }

    /** Starts a fake MCP with the script and waits until the client hears it connected. */
    static void connect(ClientTestSuite s, java.util.function.Supplier<JsonObject> script) {
        s.step("start a fake MCP that sends a ghost", () -> s.startMcp(script.get().toString()));
        s.waitUntil("the client is connected", () -> LinkState.connected(), 400);
    }

    /** Makes the client send a request of {@code kind}, which the script answers with a scripted update. */
    static void trigger(ClientTestSuite s, String kind) {
        s.step("the fake MCP sends an update (on a " + kind + " request)", () -> UiClient.request(kind, new JsonObject(), r -> {}));
    }

    static void restoreMcp(ClientTestSuite s) {
        s.cleanup("back to the suite's fake MCP", () -> {
            UiToggles.ghosts = true;
            s.startMcp(SUITE_SCRIPT);
        });
        s.waitUntil("connected again", () -> LinkState.connected(), 400);
    }

    static BlockPos ahead(ClientTestSuite s) {
        return s.player().blockPosition().offset(-8, -1, 6);
    }

    static void lookAhead(ClientTestSuite s) {
        s.step("look south and down", () -> {
            s.player().setYRot(0f);
            s.player().setXRot(35f);
        });
    }

    // ── tests ───────────────────────────────────────────────────────────────────────────────

    /**
     * A ghost meshes exactly the sections it covers; an update re-meshes only its sections (one
     * changed, one emptied); {@code ui.ghost.clear} frees every mesh.
     */
    @ClientTest("ghost")
    public static void meshesUpdatesAndClears(ClientTestSuite s) {
        lookAhead(s);
        connect(s, () -> {
            BlockPos o = ahead(s);
            JsonArray send = new JsonArray();
            send.add(ghost(s, "j1", o, "#ff4040", true, List.of(STONE), fill(0, 0, 0, STONE), fill(1, 0, 0, STONE), fill(0, 1, 0, STONE)));
            JsonArray replies = new JsonArray();
            replies.add(reply("logs.list", ghost(s, "j1", o, "#ff4040", false, List.of(GLASS, AIR), fill(1, 0, 0, GLASS), fill(0, 1, 0, AIR))));
            replies.add(reply("settings.list", clearMessage(s, "j1")));
            JsonObject results = new JsonObject();
            JsonObject logs = new JsonObject();
            logs.add("logs", new JsonArray());
            results.add("logs.list", ok(logs));
            results.add("settings.list", ok(new JsonObject()));
            return script(send, replies, results);
        });
        s.waitUntil("ghost j1 holds three sections, all meshed once", () -> {
            Set<List<Integer>> want = Set.of(List.of(0, 0, 0), List.of(1, 0, 0), List.of(0, 1, 0));
            check(Ghosts.sections("j1").equals(want), "sections " + Ghosts.sections("j1"));
            check(Ghosts.pending() == 0, "pending " + Ghosts.pending());
            check(Ghosts.meshed("j1").equals(want), "meshed " + Ghosts.meshed("j1"));
            check(Ghosts.meshCounts("j1").equals(Map.of(List.of(0, 0, 0), 1, List.of(1, 0, 0), 1, List.of(0, 1, 0), 1)), "counts " + Ghosts.meshCounts("j1"));
            check(Ghosts.drawnSections() > 0, "nothing drawn");
            return true;
        }, 400);
        trigger(s, "logs.list");
        s.waitUntil("only section [1,0,0] was re-meshed; [0,1,0] is gone", () -> {
            check(Ghosts.pending() == 0, "pending " + Ghosts.pending());
            check(Ghosts.sections("j1").equals(Set.of(List.of(0, 0, 0), List.of(1, 0, 0))), "sections " + Ghosts.sections("j1"));
            check(Ghosts.meshed("j1").equals(Set.of(List.of(0, 0, 0), List.of(1, 0, 0))), "meshed " + Ghosts.meshed("j1"));
            check(Ghosts.meshCounts("j1").equals(Map.of(List.of(0, 0, 0), 1, List.of(1, 0, 0), 2, List.of(0, 1, 0), 1)), "counts " + Ghosts.meshCounts("j1"));
            return true;
        }, 400);
        trigger(s, "settings.list");
        s.waitUntil("ui.ghost.clear freed it", () -> {
            check(Ghosts.ids().isEmpty(), "ghosts " + Ghosts.ids());
            check(Ghosts.meshBytes() == 0, "mesh bytes " + Ghosts.meshBytes());
            return true;
        }, 400);
        restoreMcp(s);
    }

    /** The toggle key hides the ghost (its meshes freed) and shows it again. */
    @ClientTest("ghost")
    public static void toggleHidesAndShows(ClientTestSuite s) {
        lookAhead(s);
        connect(s, () -> {
            JsonArray send = new JsonArray();
            send.add(ghost(s, "j2", ahead(s), "#40ff40", true, List.of(STONE), fill(0, 0, 0, STONE)));
            return script(send, new JsonArray(), new JsonObject());
        });
        s.waitUntil("drawn", () -> Ghosts.drawnSections() == 1, 400);
        s.step("bind the toggle to F8 and press it", () -> {
            AutosketchKeys.TOGGLE_GHOSTS.setKey(InputConstants.Type.KEYSYM.getOrCreate(GLFW.GLFW_KEY_F8));
            KeyMapping.resetMapping();
            s.click(AutosketchKeys.TOGGLE_GHOSTS);
        });
        s.waitUntil("hidden: nothing drawn, meshes freed, blocks kept", () -> {
            check(!UiToggles.ghosts, "toggle still on");
            check(Ghosts.drawnSections() == 0, "drawn " + Ghosts.drawnSections());
            check(Ghosts.meshed("j2").isEmpty(), "meshes kept " + Ghosts.meshed("j2"));
            check(Ghosts.sections("j2").size() == 1, "blocks dropped");
            return true;
        }, 200);
        s.step("press it again", () -> s.click(AutosketchKeys.TOGGLE_GHOSTS));
        s.waitUntil("shown again", () -> UiToggles.ghosts && Ghosts.drawnSections() == 1, 200);
        s.cleanup("unbind the toggle", () -> {
            AutosketchKeys.TOGGLE_GHOSTS.setKey(InputConstants.UNKNOWN);
            KeyMapping.resetMapping();
        });
        restoreMcp(s);
    }

    /** Offline (the MCP went away), every ghost is dropped and nothing draws. */
    @ClientTest("ghost")
    public static void nothingDrawsOffline(ClientTestSuite s) {
        lookAhead(s);
        connect(s, () -> {
            JsonArray send = new JsonArray();
            send.add(ghost(s, "j3", ahead(s), "#4040ff", true, List.of(STONE), fill(0, 0, 0, STONE)));
            return script(send, new JsonArray(), new JsonObject());
        });
        s.waitUntil("drawn", () -> Ghosts.drawnSections() == 1, 400);
        s.step("stop the fake MCP", s::stopMcp);
        s.waitUntil("offline", () -> LinkState.get() == LinkState.State.OFFLINE, 400);
        long[] frame = new long[1];
        s.step("note the frame", () -> frame[0] = Ghosts.drawnFrames());
        s.waitUntil("a later frame draws no ghost; none is held", () -> {
            if (Ghosts.drawnFrames() <= frame[0] + 2) return false;
            check(Ghosts.ids().isEmpty(), "ghosts " + Ghosts.ids());
            check(Ghosts.drawnSections() == 0, "drawn " + Ghosts.drawnSections());
            check(Ghosts.meshBytes() == 0, "mesh bytes " + Ghosts.meshBytes());
            return true;
        }, 200);
        restoreMcp(s);
    }

    /**
     * {@code /autosketch ghost here} sends {@code ghost.anchor} with the player's dimension and block
     * position; the anchored ghost arrives and draws; {@code /autosketch ghost clear} sends
     * {@code ghost.clear} for it and the ghost goes.
     */
    @ClientTest("ghost")
    public static void ghostHereAnchorsAndClearRemoves(ClientTestSuite s) {
        lookAhead(s);
        BlockPos[] at = new BlockPos[1];
        connect(s, () -> {
            at[0] = s.player().blockPosition();
            JsonArray replies = new JsonArray();
            replies.add(reply("ghost.anchor", ghost(s, "doc", at[0], "#ffffff", true, List.of(STONE), fill(0, 0, 0, STONE))));
            replies.add(reply("ghost.clear", clearMessage(s, "doc")));
            JsonObject results = new JsonObject();
            JsonObject anchored = new JsonObject();
            anchored.addProperty("ghost", "doc");
            results.add("ghost.anchor", ok(anchored));
            results.add("ghost.clear", ok(new JsonObject()));
            return script(new JsonArray(), replies, results);
        });
        s.step("/autosketch ghost here", () -> s.command("autosketch ghost here"));
        s.waitUntil("the fake MCP got ghost.anchor with the player's position", () -> {
            for (JsonObject r : s.mcp().received("ui.request")) {
                if (!"ghost.anchor".equals(r.get("kind").getAsString())) continue;
                JsonObject args = r.getAsJsonObject("args");
                JsonArray pos = args.getAsJsonArray("pos");
                check(args.get("dimension").getAsString().equals(s.player().level().dimension().location().toString()), "dimension " + args);
                check(pos.get(0).getAsInt() == at[0].getX() && pos.get(1).getAsInt() == at[0].getY() && pos.get(2).getAsInt() == at[0].getZ(),
                        "pos " + pos + ", player at " + at[0]);
                return true;
            }
            return false;
        }, 200);
        s.waitUntil("the anchored ghost is held, remembered and drawn", () -> {
            check(Ghosts.anchored().equals(Set.of("doc")), "anchored " + Ghosts.anchored());
            return Ghosts.meshed("doc").size() == 1;
        }, 200);
        s.step("/autosketch ghost clear", () -> s.command("autosketch ghost clear"));
        s.waitUntil("ghost.clear sent and the ghost gone", () -> {
            boolean sent = s.mcp().received("ui.request").stream().anyMatch(r -> "ghost.clear".equals(r.get("kind").getAsString())
                    && "doc".equals(r.getAsJsonObject("args").get("ghost").getAsString()));
            return sent && Ghosts.ids().isEmpty() && Ghosts.anchored().isEmpty();
        }, 200);
        BlockPos clicked = new BlockPos(3, -61, 5);
        s.step("the wand in ghost mode, a click on a block", () -> s.onServer(server -> {
            var p = s.serverPlayer(server);
            check(dev.autosketch.mod.AutosketchMod.internals().wand().select(p, "ghost"), "no ghost mode");
            dev.autosketch.mod.AutosketchMod.internals().wand().mode(p).setCorner(p, 2, clicked);
            dev.autosketch.mod.AutosketchMod.internals().wand().select(p, "work");
            return null;
        }));
        s.waitUntil("ghost.anchor at the block above the clicked one", () -> s.mcp().received("ui.request").stream()
                .filter(r -> "ghost.anchor".equals(r.get("kind").getAsString()))
                .map(r -> r.getAsJsonObject("args").getAsJsonArray("pos"))
                .anyMatch(pos -> pos.get(0).getAsInt() == 3 && pos.get(1).getAsInt() == -60 && pos.get(2).getAsInt() == 5), 200);
        restoreMcp(s);
    }

    /**
     * The one pixel check: a ghost is visible over terrain and translucent. Three frames of the same
     * view: no ghost, the ghost, and the ghost drawn opaque; where the ghost shows, its pixels lie
     * between the terrain's and the opaque ghost's.
     */
    @ClientTest("ghost")
    public static void visibleAndTranslucentOverTerrain(ClientTestSuite s) {
        NativeImage[] shots = new NativeImage[3];
        s.step("hide the GUI and clouds; look down at the ground ahead", () -> {
            s.hideGui(true);
            s.mc().options.cloudStatus().set(CloudStatus.OFF);
            s.player().setYRot(0f);
            s.player().setXRot(25f);
        });
        connect(s, () -> {
            // Gold over the flat world's grass, standing on the ground in front of the player.
            JsonArray send = new JsonArray();
            send.add(ghost(s, "j4", s.player().blockPosition().offset(-8, 0, 7), "#ffffff", true, List.of("minecraft:gold_block"),
                    fill(0, 0, 0, "minecraft:gold_block")));
            return script(send, new JsonArray(), new JsonObject());
        });
        s.waitUntil("drawn", () -> Ghosts.pending() == 0 && Ghosts.drawnSections() == 1, 400);
        s.waitFrames("settle", 3);
        s.step("screenshot with the ghost", () -> shots[1] = s.screenshot("ghost-on"));
        s.step("draw it opaque", () -> Ghosts.alpha = 1f);
        s.waitFrames("an opaque frame", 3);
        s.step("screenshot opaque", () -> shots[2] = s.screenshot("ghost-opaque"));
        s.step("hide ghosts", () -> {
            Ghosts.alpha = 0.55f;
            UiToggles.ghosts = false;
        });
        s.waitFrames("a frame without", 3);
        s.step("screenshot without", () -> shots[0] = s.screenshot("ghost-off"));
        s.step("the ghost shows, and blends terrain with gold", () -> {
            NativeImage off = shots[0], on = shots[1], opaque = shots[2];
            long changed = 0, between = 0, total = (long) on.getWidth() * on.getHeight();
            for (int y = 0; y < on.getHeight(); y++)
                for (int x = 0; x < on.getWidth(); x++) {
                    int a = off.getPixelRGBA(x, y), b = on.getPixelRGBA(x, y), c = opaque.getPixelRGBA(x, y);
                    if (!differs(a, c, 24)) continue; // not where the opaque ghost shows
                    changed++;
                    if (differs(b, a, 8) && differs(b, c, 8) && betweenAll(a, b, c, 10)) between++;
                }
            check(changed > total / 20, "the opaque ghost covers only " + changed + " of " + total + " pixels");
            check(between > changed * 7 / 10, "translucent pixels " + between + " of " + changed);
        });
        s.cleanup("restore view and close the screenshots", () -> {
            UiToggles.ghosts = true;
            Ghosts.alpha = 0.55f;
            s.hideGui(false);
            s.mc().options.cloudStatus().set(CloudStatus.FANCY);
            for (NativeImage i : shots)
                if (i != null) i.close();
        });
        restoreMcp(s);
    }

    private static boolean differs(int p, int q, int tol) {
        for (int shift = 0; shift < 24; shift += 8)
            if (Math.abs(((p >> shift) & 0xFF) - ((q >> shift) & 0xFF)) > tol) return true;
        return false;
    }

    /** Each channel of {@code b} lies between {@code a}'s and {@code c}'s, within {@code tol}. */
    private static boolean betweenAll(int a, int b, int c, int tol) {
        for (int shift = 0; shift < 24; shift += 8) {
            int x = (a >> shift) & 0xFF, y = (b >> shift) & 0xFF, z = (c >> shift) & 0xFF;
            if (y < Math.min(x, z) - tol || y > Math.max(x, z) + tol) return false;
        }
        return true;
    }
}
