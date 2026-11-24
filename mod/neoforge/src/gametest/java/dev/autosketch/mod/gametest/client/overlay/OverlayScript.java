package dev.autosketch.mod.gametest.client.overlay;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.overlay.OverlayClient;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import net.minecraft.client.KeyMapping;

/**
 * The fake MCP's script for the overlay suite, built at run time because every {@code ui.*}
 * message names its players and the test player's UUID is only known in game (13, *In-game UI*,
 * <em>Players</em>). After the handshake the MCP sends a full {@code ui.state} (seq 1: jobs j1 and j2,
 * an ask request, token totals, no refusal). The tests then make it send more by sending a
 * {@code ui.request} whose reply is scripted (the fake MCP answers by kind; the kinds are only
 * triggers here):
 *
 * <ul>
 * <li>{@code logs.list}: the change seq 2, removing j2 and setting a refusal;</li>
 * <li>{@code library.list}: a {@code ui.flash} on j1's two boxes;</li>
 * <li>{@code settings.list}: a change with seq 9 adding j3, a gap the client must drop and resync on;</li>
 * <li>{@code library.entry}: the change seq 2 adding the steady fill {@code candidate} (one section's
 * shell, a cube's twelve edges) and one in the nether (18, piece 8);</li>
 * <li>{@code library.thumbnail}: the change seq 3 replacing {@code candidate} by two sections' shell;</li>
 * <li>{@code library.preview}: the change seq 4 removing {@code candidate};</li>
 * <li>{@code library.rename}: a {@code ui.flash} of two proposed hits (job {@code candidate});</li>
 * <li>{@code resync} (the client's own): the full state seq 1 again, then the result.</li>
 * </ul>
 */
final class OverlayScript {
    private OverlayScript() {}

    static final String OVERWORLD = "minecraft:overworld";
    static final int J1_COLOUR = 0x3fa7d6, J2_COLOUR = 0xf26419, J3_COLOUR = 0x22aa44;
    static final String J1_BRIEF = "east tower: four storeys, conical roof", J2_BRIEF = "courtyard paving", J3_BRIEF = "never shown";

    static JsonArray box(int x0, int y0, int z0, int x1, int y1, int z1) {
        JsonArray min = new JsonArray(), max = new JsonArray();
        min.add(x0);
        min.add(y0);
        min.add(z0);
        max.add(x1);
        max.add(y1);
        max.add(z1);
        JsonArray wrap = new JsonArray();
        JsonObject o = new JsonObject();
        o.add("min", min);
        o.add("max", max);
        wrap.add(o);
        return wrap;
    }

    static JsonObject one(JsonArray box) {
        return box.get(0).getAsJsonObject();
    }

    static JsonObject job(String id, int colour, String brief, String dimension, JsonArray work, JsonArray context) {
        JsonObject j = new JsonObject();
        j.addProperty("id", id);
        j.addProperty("colour", String.format("#%06x", colour));
        j.addProperty("brief", brief);
        j.addProperty("dimension", dimension);
        j.add("work", one(work));
        j.add("context", context);
        return j;
    }

    static JsonArray concat(JsonArray... parts) {
        JsonArray a = new JsonArray();
        for (JsonArray p : parts) a.addAll(p);
        return a;
    }

    static JsonArray players(ClientTestSuite s) {
        JsonArray a = new JsonArray();
        a.add(s.player().getUUID().toString());
        return a;
    }

    static JsonObject j1() {
        return job("j1", J1_COLOUR, J1_BRIEF, OVERWORLD, box(4, -60, 4, 8, -56, 8), box(3, -61, 3, 9, -55, 9));
    }

    static JsonObject j2() {
        return job("j2", J2_COLOUR, J2_BRIEF, OVERWORLD, box(-8, -60, 4, -4, -60, 8), concat(box(-9, -61, 3, -3, -59, 9), box(-12, -61, 3, -10, -59, 5)));
    }

    /** A job in the nether: kept, never drawn in the overworld. */
    static JsonObject nether() {
        return job("jn", 0x884488, "nether job", "minecraft:the_nether", box(0, 64, 0, 3, 67, 3), new JsonArray());
    }

    static JsonObject full(ClientTestSuite s, long seq, JsonObject... jobs) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "ui.state");
        m.add("players", players(s));
        m.addProperty("seq", seq);
        m.addProperty("full", true);
        JsonArray a = new JsonArray();
        for (JsonObject j : jobs) a.add(j);
        m.add("jobs", a);
        JsonObject request = new JsonObject();
        request.addProperty("id", 7);
        request.addProperty("mode", "ask");
        request.addProperty("text", "how tall should the east tower be?");
        m.add("request", request);
        JsonObject tokens = new JsonObject();
        tokens.addProperty("input", 18234);
        tokens.addProperty("output", 2210);
        tokens.addProperty("cacheRead", 120400);
        tokens.addProperty("cacheCreation", 5320);
        tokens.addProperty("cost", 0.4825);
        m.add("tokens", tokens);
        m.add("refusal", JsonNull.INSTANCE);
        return m;
    }

    static JsonObject removeJ2(ClientTestSuite s) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "ui.state");
        m.add("players", players(s));
        m.addProperty("seq", 2);
        m.addProperty("full", false);
        JsonArray removed = new JsonArray();
        removed.add("j2");
        m.add("removed", removed);
        JsonObject refusal = new JsonObject();
        refusal.addProperty("code", "outside_work_volume");
        refusal.addProperty("text", "fill reached outside j1's work volume");
        m.add("refusal", refusal);
        return m;
    }

    static JsonObject gap(ClientTestSuite s) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "ui.state");
        m.add("players", players(s));
        m.addProperty("seq", 9);
        m.addProperty("full", false);
        JsonArray jobs = new JsonArray();
        jobs.add(job("j3", J3_COLOUR, J3_BRIEF, OVERWORLD, box(0, -60, 10, 2, -58, 12), new JsonArray()));
        m.add("jobs", jobs);
        return m;
    }

    static JsonObject flash(ClientTestSuite s) {
        JsonObject f = new JsonObject();
        f.addProperty("job", "j1");
        f.addProperty("colour", String.format("#%06x", J1_COLOUR));
        f.addProperty("dimension", OVERWORLD);
        f.add("boxes", concat(box(5, -60, 5, 5, -60, 5), box(6, -59, 6, 7, -59, 7)));
        JsonObject other = new JsonObject();
        other.addProperty("job", "base");
        other.addProperty("colour", "#ffffff");
        other.addProperty("dimension", "minecraft:the_nether");
        other.add("boxes", box(0, 64, 0, 0, 64, 0));
        JsonArray flashes = new JsonArray();
        flashes.add(f);
        flashes.add(other);
        JsonObject m = new JsonObject();
        m.addProperty("type", "ui.flash");
        m.add("players", players(s));
        m.add("flashes", flashes);
        return m;
    }

    // ── the select candidate (18, piece 8) ──────────────────────────────────────────────────

    static final int CANDIDATE_COLOUR = 0xff00ff, CANDIDATE_ALPHA = 96;

    static JsonArray span(int... v) {
        JsonArray a = new JsonArray();
        for (int n : v) a.add(n);
        return a;
    }

    static JsonArray spans(int[]... spans) {
        JsonArray a = new JsonArray();
        for (int[] s : spans) a.add(span(s));
        return a;
    }

    /** The six faces of the box {@code [x0, x1] × [y0, y1] × [z0, z1]} (corner coordinates). */
    static int[][] shell(int x0, int y0, int z0, int x1, int y1, int z1) {
        return new int[][] {{x0, y0, z0, x0, y1, z1}, {x1, y0, z0, x1, y1, z1}, {x0, y0, z0, x1, y0, z1}, {x0, y1, z0, x1, y1, z1},
                {x0, y0, z0, x1, y1, z0}, {x0, y0, z1, x1, y1, z1}};
    }

    /** The twelve edges of the box {@code [x0, x1] × [y0, y1] × [z0, z1]}. */
    static int[][] edges(int x0, int y0, int z0, int x1, int y1, int z1) {
        return new int[][] {{x0, y0, z0, x1, y0, z0}, {x0, y1, z0, x1, y1, z0}, {x0, y0, z1, x1, y0, z1}, {x0, y1, z1, x1, y1, z1},
                {x0, y0, z0, x0, y1, z0}, {x1, y0, z0, x1, y1, z0}, {x0, y0, z1, x0, y1, z1}, {x1, y0, z1, x1, y1, z1},
                {x0, y0, z0, x0, y0, z1}, {x1, y0, z0, x1, y0, z1}, {x0, y1, z0, x0, y1, z1}, {x1, y1, z0, x1, y1, z1}};
    }

    /** The first candidate: section (0, -4, 0)'s shell, and a 3³ cube's edges at 4..7, -60..-57, 4..7. */
    static final int[][] FACES_A = shell(0, -64, 0, 16, -48, 16), EDGES_A = edges(4, -60, 4, 7, -57, 7);
    /** The second: sections (0, -4, 0) and (1, -4, 0), their shell merged (no face at x = 16), and a 16×3×3 block's edges. */
    static final int[][] FACES_B = shell(0, -64, 0, 32, -48, 16), EDGES_B = edges(4, -60, 4, 20, -57, 7);

    static JsonObject fill(String id, String dimension, int[][] faces, int[][] edges) {
        JsonObject f = new JsonObject();
        f.addProperty("id", id);
        f.addProperty("colour", String.format("#%06x", CANDIDATE_COLOUR));
        f.addProperty("alpha", CANDIDATE_ALPHA);
        f.addProperty("dimension", dimension);
        f.add("faces", spans(faces));
        f.add("edges", spans(edges));
        return f;
    }

    static JsonObject change(ClientTestSuite s, long seq, JsonArray fills, JsonArray fillsRemoved) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "ui.state");
        m.add("players", players(s));
        m.addProperty("seq", seq);
        m.addProperty("full", false);
        if (fills != null) m.add("fills", fills);
        if (fillsRemoved != null) m.add("fillsRemoved", fillsRemoved);
        return m;
    }

    static JsonObject fillAdded(ClientTestSuite s) {
        JsonArray fills = new JsonArray();
        fills.add(fill("candidate", OVERWORLD, FACES_A, EDGES_A));
        fills.add(fill("elsewhere", "minecraft:the_nether", FACES_A, EDGES_A));
        return change(s, 2, fills, null);
    }

    static JsonObject fillReplaced(ClientTestSuite s) {
        JsonArray fills = new JsonArray();
        fills.add(fill("candidate", OVERWORLD, FACES_B, EDGES_B));
        return change(s, 3, fills, null);
    }

    static JsonObject fillRemoved(ClientTestSuite s) {
        JsonArray removed = new JsonArray();
        removed.add("candidate");
        return change(s, 4, null, removed);
    }

    /** Two proposed hits, pulsed as a flash with job {@code candidate} (13, *Fill*, proposed hits). */
    static JsonObject hits(ClientTestSuite s) {
        JsonObject f = new JsonObject();
        f.addProperty("job", "candidate");
        f.addProperty("colour", String.format("#%06x", CANDIDATE_COLOUR));
        f.addProperty("dimension", OVERWORLD);
        f.add("boxes", concat(box(-40, -61, 0, -25, -50, 15), box(48, -61, 32, 63, -50, 47)));
        JsonArray flashes = new JsonArray();
        flashes.add(f);
        JsonObject m = new JsonObject();
        m.addProperty("type", "ui.flash");
        m.add("players", players(s));
        m.add("flashes", flashes);
        return m;
    }

    private static JsonObject reply(String kind, JsonElement send) {
        JsonObject r = new JsonObject();
        r.addProperty("on", "ui.request");
        r.addProperty("kind", kind);
        r.add("send", send);
        return r;
    }

    private static JsonObject ok() {
        JsonObject o = new JsonObject();
        o.addProperty("ok", true);
        o.add("result", new JsonObject());
        return o;
    }

    /** The script: {@code jobs} in the first full state (and in every resync's). */
    static String script(ClientTestSuite s, JsonObject... jobs) {
        JsonObject hello = new JsonObject();
        JsonArray features = new JsonArray();
        features.add("prompt.close");
        features.add("ui");
        hello.add("features", features);
        JsonObject script = new JsonObject();
        script.add("hello", hello);
        JsonArray send = new JsonArray();
        send.add(full(s, 1, jobs));
        script.add("send", send);
        JsonArray replies = new JsonArray();
        replies.add(reply("logs.list", removeJ2(s)));
        replies.add(reply("library.list", flash(s)));
        replies.add(reply("settings.list", gap(s)));
        replies.add(reply("library.entry", fillAdded(s)));
        replies.add(reply("library.thumbnail", fillReplaced(s)));
        replies.add(reply("library.preview", fillRemoved(s)));
        replies.add(reply("library.rename", hits(s)));
        JsonArray resync = new JsonArray();
        resync.add(full(s, 1, jobs));
        JsonObject result = new JsonObject();
        result.addProperty("type", "ui.result");
        result.addProperty("ok", true);
        result.add("result", new JsonObject());
        resync.add(result);
        replies.add(reply("resync", resync));
        script.add("replies", replies);
        JsonObject results = new JsonObject();
        for (String k : new String[] {"logs.list", "library.list", "settings.list", "library.entry", "library.thumbnail", "library.preview", "library.rename"}) results.add(k, ok());
        script.add("results", results);
        return script.toString();
    }

    /** The ids of the jobs the running overlay MCP's full state holds; null before one started. */
    private static java.util.List<String> playing;

    /** The jobs most tests share: j1, j2 and a job in the nether. */
    static JsonObject[] shared() {
        return new JsonObject[] {j1(), j2(), nether()};
    }

    /**
     * Steps: bring the client to the full state seq 1 holding {@code jobs}. When the running MCP
     * already plays those jobs, the test asks it for a {@code resync} (13, <em>Sequence and
     * resync</em>), so most tests share one MCP and never wait on a restart; otherwise it starts one.
     * While connected with no state held (an old MCP's late offline notice cleared it), it resyncs.
     */
    static void connect(ClientTestSuite s, JsonObject... jobs) {
        java.util.List<String> ids = java.util.Arrays.stream(jobs).map(j -> j.get("id").getAsString()).toList();
        long[] lastResync = new long[1];
        s.step("the overlay MCP plays " + ids, () -> {
            if (ids.equals(playing) && LinkState.connected()) {
                trigger("resync");
                return;
            }
            restart(s, jobs);
        });
        s.waitUntil("connected, holding the full state seq 1 with " + ids, () -> {
            if (LinkState.connected() && OverlayClient.state().seq() == 0 && s.mc().level.getGameTime() - lastResync[0] > 40) {
                lastResync[0] = s.mc().level.getGameTime();
                trigger("resync");
            }
            java.util.List<String> held = OverlayClient.state().jobs().stream().map(j -> j.id()).toList();
            ClientTestSuite.check(LinkState.connected() && OverlayClient.state().seq() == 1 && held.equals(ids),
                    "link " + LinkState.get() + ", seq " + OverlayClient.state().seq() + ", jobs " + held);
            return true;
        }, 1200);
    }

    /** Stops the overlay MCP (inside a step). */
    static void stop(ClientTestSuite s) {
        playing = null;
        s.stopMcp();
    }

    /** Starts an overlay MCP playing {@code jobs} (inside a step or cleanup). */
    static void restart(ClientTestSuite s, JsonObject... jobs) throws java.io.IOException {
        playing = java.util.Arrays.stream(jobs).map(j -> j.get("id").getAsString()).toList();
        s.startMcp(script(s, jobs));
    }

    /** Sends a trigger request (see the class comment); the answer is ignored. */
    static void trigger(String kind) {
        dev.autosketch.mod.client.ui.UiClient.request(kind, new JsonObject(), r -> {});
    }

    /** Binds an unbound mapping to a keypad key for the test (restore with {@link #unbind}). */
    static void bind(KeyMapping k, int glfwKey) {
        k.setKey(InputConstants.Type.KEYSYM.getOrCreate(glfwKey));
        KeyMapping.resetMapping();
    }

    static void unbind(KeyMapping k) {
        k.setKey(InputConstants.UNKNOWN);
        KeyMapping.resetMapping();
    }
}
