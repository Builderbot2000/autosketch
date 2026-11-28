package dev.autosketch.mod.gametest.client.requests;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.google.gson.JsonObject;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.chat.StatusLineClient;
import dev.autosketch.mod.client.ui.chat.mixin.ChatComponentAccess;
import dev.autosketch.mod.client.ui.hud.HudOverlay;
import dev.autosketch.mod.gametest.RequestGameTests;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import dev.autosketch.mod.prompt.StatusLines;
import dev.autosketch.mod.protocol.RequestMessages.Status;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import net.minecraft.client.GuiMessage;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;

/**
 * Request control in game, client half (19, *Status line*, *Stop*, *Queueing*; briefs/canvas/G,
 * deliverable 5). Status lines go through the server half's own handler ({@link StatusLines#onStatus})
 * and the real relay to the client half, which keeps one chat line per request and rewrites it in
 * place ({@code working → stopping → stopped}); its buttons run {@code /autosketch action <n>} and the
 * client sends that button's {@code ui.request}; the HUD shows the running request's line and the
 * queue length. {@code /autosketch stop} and {@code queue cancel <n>} reach the suite's fake MCP
 * ({@code clienttest/requests.json}, hello listing {@code requests}) as {@code request.control}.
 */
public final class RequestClientTests {
    private RequestClientTests() {}

    static final long REQ = 7001, QUEUED = 7002;
    static final String TEXT = "build a gatehouse on the east wall";

    /** Every click command in a line, in order. */
    static List<String> clicks(Component c) {
        List<String> out = new ArrayList<>();
        c.visit((style, text) -> {
            ClickEvent e = style.getClickEvent();
            if (e != null && e.getAction() == ClickEvent.Action.RUN_COMMAND && !text.isEmpty()) out.add(e.getValue());
            return Optional.empty();
        }, Style.EMPTY);
        return out;
    }

    /** Chat's lines (newest first) that belong to the test request's text. */
    static List<GuiMessage> requestLines(ClientTestSuite s) {
        List<GuiMessage> all = ((ChatComponentAccess) s.mc().gui.getChat()).autosketch$allMessages();
        return all.stream().filter(m -> m.content().getString().contains(TEXT)).toList();
    }

    static String relay(ClientTestSuite s, Status st) throws Exception {
        return s.onServer(server -> StatusLines.onStatus(st, server));
    }

    static List<JsonObject> uiRequests(ClientTestSuite s, String kind) {
        return s.mcp().received("ui.request").stream().filter(r -> r.get("kind").getAsString().equals(kind)).toList();
    }

    /**
     * One line goes {@code working → stopping → stopped} in place: chat keeps one line for the request
     * throughout, its text is each status's {@code lines[0]} with the state's buttons; clicking
     * {@code [Stop]} sends {@code request.stop {request}}; the HUD shows the running line, then the
     * queue length; a queued prompt gets its own line with {@code [Send now]} and {@code [Cancel]}.
     */
    @ClientTest("requests")
    public static void statusLineIsRewrittenInPlace(ClientTestSuite s) {
        UUID[] me = new UUID[1];
        String[] stop = new String[1];
        s.waitUntil("connected", () -> LinkState.connected(), 400);
        s.step("working, through the server half", () -> {
            me[0] = s.player().getUUID();
            StatusLineClient.reset();
            check(requestLines(s).isEmpty(), "no request line yet");
            check(relay(s, RequestGameTests.status(REQ, me[0], "working", 3, null)).equals("relayed"), "relayed to the client half");
        });
        s.waitUntil("one line, working, with [Stop]", () -> {
            List<GuiMessage> lines = requestLines(s);
            check(lines.size() == 1, "lines " + lines.stream().map(m -> m.content().getString()).toList());
            Component c = lines.get(0).content();
            check(c.getString().equals("⏳ Working · \"" + TEXT + "\" · 3 calls · 0:42  [Stop]"), "text " + c.getString());
            List<String> cs = clicks(c);
            check(cs.size() == 1 && cs.get(0).startsWith("/autosketch action "), "clicks " + cs);
            stop[0] = cs.get(0);
            check(StatusLineClient.message(REQ) == lines.get(0), "the kept message is the one shown");
            return true;
        }, 200);
        s.step("the HUD shows the running line", () -> {
            List<String> hud = HudOverlay.lines();
            check(hud.contains("⏳ Working · \"" + TEXT + "\" · 3 calls · 0:42"), "hud " + hud);
        });
        s.step("click [Stop]", () -> check(s.player().connection.sendUnsignedCommand(stop[0].substring(1)), "the command needs signing"));
        s.waitUntil("request.stop {request: 7001} reaches the MCP", () -> {
            List<JsonObject> rs = uiRequests(s, "request.stop");
            check(rs.size() == 1, rs.size() + " request.stop");
            check(rs.get(0).getAsJsonObject("args").toString().equals("{\"request\":7001}"), "args " + rs.get(0).getAsJsonObject("args"));
            return true;
        }, 200);
        s.step("stopping", () -> check(relay(s, RequestGameTests.status(REQ, me[0], "stopping", 4, null)).equals("relayed"), "relayed"));
        s.waitUntil("the same line, now stopping, no buttons", () -> {
            List<GuiMessage> lines = requestLines(s);
            check(lines.size() == 1, "lines " + lines.stream().map(m -> m.content().getString()).toList());
            check(lines.get(0).content().getString().equals("■ Stopping… · \"" + TEXT + "\" · 4 calls · 0:44"), "text " + lines.get(0).content().getString());
            check(clicks(lines.get(0).content()).isEmpty(), "no buttons");
            check(HudOverlay.lines().contains("■ Stopping… · \"" + TEXT + "\" · 4 calls · 0:44"), "hud " + HudOverlay.lines());
            return true;
        }, 200);
        s.step("stopped", () -> check(relay(s, RequestGameTests.status(REQ, me[0], "stopped", 4, null)).equals("relayed"), "relayed"));
        s.waitUntil("the same line, now stopped, with [Undo request]; the HUD has no running request", () -> {
            List<GuiMessage> lines = requestLines(s);
            check(lines.size() == 1, "lines " + lines.stream().map(m -> m.content().getString()).toList());
            check(lines.get(0).content().getString().equals("■ Stopped · \"" + TEXT + "\" · 4 calls · 0:47  [Undo request]"), "text " + lines.get(0).content().getString());
            check(clicks(lines.get(0).content()).size() == 1, "one button");
            check(HudOverlay.lines().stream().noneMatch(l -> l.contains(TEXT)), "hud " + HudOverlay.lines());
            return true;
        }, 200);
        s.step("a queued prompt", () -> check(relay(s, RequestGameTests.status(QUEUED, me[0], "queued", 0, 1)).equals("relayed"), "relayed"));
        s.waitUntil("its own line with [Send now] [Cancel]; the HUD counts it", () -> {
            List<GuiMessage> lines = requestLines(s);
            check(lines.size() == 2, "lines " + lines.stream().map(m -> m.content().getString()).toList());
            check(lines.get(0).content().getString().equals("⧗ Queued · \"" + TEXT + "\"  [Send now]  [Cancel]"), "text " + lines.get(0).content().getString());
            check(clicks(lines.get(0).content()).size() == 2, "two buttons");
            check(StatusLineClient.queued() == 1, "queued " + StatusLineClient.queued());
            check(HudOverlay.lines().contains("Request: none running · 1 queued"), "hud " + HudOverlay.lines());
            return true;
        }, 200);
        s.step("click [Cancel]", () -> {
            String cancel = clicks(requestLines(s).get(0).content()).get(1);
            check(s.player().connection.sendUnsignedCommand(cancel.substring(1)), "the command needs signing");
        });
        s.waitUntil("queue.cancel {request: 7002} reaches the MCP", () -> {
            List<JsonObject> rs = uiRequests(s, "queue.cancel");
            check(rs.size() == 1 && rs.get(0).getAsJsonObject("args").toString().equals("{\"request\":7002}"), "queue.cancel " + rs);
            return true;
        }, 200);
        s.cleanup("forget the lines", StatusLineClient::reset);
    }

    /** {@code /autosketch stop} and {@code /autosketch queue cancel 2}, typed: {@code request.control} naming the player. */
    @ClientTest("requests")
    public static void commandsSendRequestControl(ClientTestSuite s) {
        int[] before = new int[1];
        s.waitUntil("connected", () -> LinkState.connected(), 400);
        s.step("/autosketch stop, then queue cancel 2", () -> {
            s.command("autosketch notices on");
            before[0] = s.mcp().received("request.control").size();
            s.clearMessages();
            s.command("autosketch stop");
            s.command("autosketch queue cancel 2");
        });
        s.waitUntil("both reach the MCP, naming the player", () -> {
            List<JsonObject> cs = s.mcp().received("request.control");
            check(cs.size() == before[0] + 2, "request.control " + cs);
            JsonObject a = cs.get(before[0]), b = cs.get(before[0] + 1);
            String me = s.player().getUUID().toString();
            check(a.get("action").getAsString().equals("stop") && !a.has("position"), "stop " + a);
            check(b.get("action").getAsString().equals("queue.cancel") && b.get("position").getAsInt() == 2, "cancel " + b);
            check(a.getAsJsonObject("player").get("uuid").getAsString().equals(me) && b.getAsJsonObject("player").get("uuid").getAsString().equals(me), "players");
            return true;
        }, 200);
        s.waitUntil("the MCP's notice is shown", () -> {
            check(s.actionBarHas("the fake MCP got your request control") || s.chat().stream().anyMatch(l -> l.contains("the fake MCP got your request control")),
                    "action bar " + s.actionBar() + " chat " + s.chat());
            return true;
        }, 200);
    }
}
