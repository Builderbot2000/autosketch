package dev.autosketch.mod.gametest.client.candidates;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.ghost.Ghosts;
import dev.autosketch.mod.client.ui.screen.CandidatesScreen;
import dev.autosketch.mod.client.ui.screen.MenuScreen;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.prompt.InGamePrompts;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Checkbox;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import org.jetbrains.annotations.Nullable;

/**
 * The candidates screen (17, piece 4, *Testing*, client half) against the fake MCP
 * ({@code clienttest/candidates.json}: three candidates B2, C2, A3 for the question "show me a
 * tower", one thumbnail PNG and the screen suite's 4×3×4 preview for all, and {@code candidates.submit}
 * answered with request 12). The reply line arrives through the mod's own {@code chat} handler; the
 * click runs the line's command as the chat screen does.
 */
public final class CandidatesClientTests {
    private CandidatesClientTests() {}

    static final String LINE = "[Show candidates (3)]";

    private static CandidatesScreen screen(ClientTestSuite s) {
        check(s.mc().screen instanceof CandidatesScreen, "screen is " + (s.mc().screen == null ? "none" : s.mc().screen.getClass().getSimpleName()));
        return (CandidatesScreen) s.mc().screen;
    }

    private static ClientTestSuite.Condition connected() {
        return () -> {
            check(LinkState.connected(), "link state " + LinkState.get());
            return true;
        };
    }

    private static List<JsonObject> requests(ClientTestSuite s, String kind) {
        return s.mcp().received("ui.request").stream().filter(r -> r.get("kind").getAsString().equals(kind)).toList();
    }

    /** The click command of a chat line, or null. */
    static @Nullable String click(Component c) {
        String[] found = {null};
        c.visit((Style style, String text) -> {
            ClickEvent e = style.getClickEvent();
            if (e != null && e.getAction() == ClickEvent.Action.RUN_COMMAND) found[0] = e.getValue();
            return Optional.empty();
        }, Style.EMPTY);
        return found[0];
    }

    private static <T extends AbstractWidget> T widget(ClientTestSuite s, Class<T> type, String label) {
        check(s.mc().screen != null, "no screen open");
        for (GuiEventListener l : s.mc().screen.children())
            if (type.isInstance(l) && ((AbstractWidget) l).getMessage().getString().equals(label)) return type.cast(l);
        throw new ClientTestSuite.Failure("no " + type.getSimpleName() + " \"" + label + "\"");
    }

    /** Sends the reply with its clickable line through the mod's chat handler, to this player. */
    private static void reply(ClientTestSuite s) throws Exception {
        java.util.UUID me = s.player().getUUID();
        JsonObject args = new JsonObject();
        args.addProperty("id", "c1");
        s.onServer(server -> InGamePrompts.onChat(new Messages.Chat(12L, me, Messages.Chat.REPLY,
                List.of("Three towers in your library match.", LINE), new Messages.ChatAction(1, "candidates.open", args)), server));
    }

    /** Waits for the reply line, checks it is clickable, and clicks it (the chat screen's own path). */
    private static void clickLine(ClientTestSuite s) {
        String[] command = {null};
        s.waitUntil("the reply line arrived, clickable", () -> {
            List<Component> lines = s.chatComponents();
            Component line = lines.stream().filter(c -> c.getString().contains(LINE)).reduce((a, b) -> b).orElse(null);
            check(line != null, "chat " + s.chat());
            command[0] = click(line);
            check(command[0] != null && command[0].startsWith("/autosketch action "), "the line runs " + command[0]);
            Component own = lines.stream().filter(c -> c.getString().contains("Three towers")).reduce((a, b) -> b).orElse(null);
            check(own != null && click(own) == null, "the agent's own line isn't clickable");
            return true;
        }, 200);
        s.step("click it", () -> check(s.player().connection.sendUnsignedCommand(command[0].substring(1)), "the command needs signing"));
    }

    @ClientTest("candidates")
    public static void replyLineOpensTheScreenAndSubmitSendsThePicks(ClientTestSuite s) {
        s.waitUntil("connected", connected(), 400);
        s.step("clear chat", s::clearMessages);
        s.step("the agent replies with candidates", () -> reply(s));
        clickLine(s);
        s.waitUntil("the screen opened and sent candidates.open {id: c1}", () -> {
            screen(s);
            List<JsonObject> rs = requests(s, "candidates.open");
            check(!rs.isEmpty(), "no candidates.open");
            check(rs.get(rs.size() - 1).getAsJsonObject("args").toString().equals("{\"id\":\"c1\"}"), "args " + rs.get(rs.size() - 1));
            return true;
        }, 200);
        s.waitUntil("the question line and a grid labelled by cell", () -> {
            CandidatesScreen c = screen(s);
            check(c.cells().equals(List.of("B2", "C2", "A3")), "cells " + c.cells());
            check(c.question().equals("Agent's question: show me a tower"), "question " + c.question());
            return true;
        }, 200);
        s.waitUntil("the thumbnails loaded", () -> {
            check(screen(s).texturesLoaded() == 3, "textures " + screen(s).texturesLoaded());
            return true;
        }, 200);
        s.step("nothing ticked: Submit is off", () -> check(!widget(s, AbstractWidget.class, "Submit").active, "Submit is active"));
        s.step("select B2", () -> s.clickWidget("gothic_tower_a"));
        s.waitUntil("its preview, size, tags and notes", () -> {
            CandidatesScreen c = screen(s);
            check("B2".equals(c.selected()), "selected " + c.selected());
            check(c.previewQuads() == 78, "quads " + c.previewQuads());
            check(c.detailLines().equals(List.of("B2  gothic_tower_a", "user", "Size 7×24×7", "Tags gothic, tower", "Notes corner piece, door on the south face")), "detail " + c.detailLines());
            JsonObject a = requests(s, "library.preview").get(requests(s, "library.preview").size() - 1).getAsJsonObject("args");
            check(a.get("root").getAsString().equals("user") && a.get("name").getAsString().equals("gothic_tower_a"), "preview args " + a);
            return true;
        }, 200);
        s.step("tick B2 and label it", () -> {
            s.clickWidget("Pick B2");
            check(screen(s).ticked().equals(List.of("B2")), "ticked " + screen(s).ticked());
            widget(s, EditBox.class, "label:B2").setValue("corner tower");
        });
        s.step("select A3 and type a label: that ticks it", () -> s.clickWidget("gate_small"));
        s.waitUntil("A3 selected", () -> "A3".equals(screen(s).selected()), 100);
        s.step("label A3, then untick it", () -> {
            widget(s, EditBox.class, "label:A3").setValue("gatehouse");
            check(screen(s).ticked().equals(List.of("B2", "A3")), "a label ticks: " + screen(s).ticked());
            check(widget(s, Checkbox.class, "Pick A3").selected(), "the tick box shows it");
            s.clickWidget("Pick A3");
            check(screen(s).ticked().equals(List.of("B2")), "unticked: " + screen(s).ticked());
            s.clickWidget("Pick A3");
            widget(s, EditBox.class, "label:A3").setValue("");
        });
        s.waitFrames("drawn", 3);
        s.step("screenshot for review (not compared)", () -> s.screenshot("candidates-picked").close());
        s.step("a note, then Submit", () -> {
            widget(s, EditBox.class, "note").setValue("smaller if possible");
            check(widget(s, AbstractWidget.class, "Submit").active, "Submit is off");
            s.clickWidget("Submit");
        });
        s.waitUntil("candidates.submit sent the ticked picks in the list's order, and the screen closed", () -> {
            List<JsonObject> rs = requests(s, "candidates.submit");
            check(rs.size() == 1, rs.size() + " submits");
            String want = "{\"id\":\"c1\",\"picks\":[{\"prefab\":\"gothic_tower_a\",\"cell\":\"B2\",\"label\":\"corner tower\"},{\"prefab\":\"gate_small\",\"cell\":\"A3\"}],\"note\":\"smaller if possible\"}";
            check(rs.get(0).getAsJsonObject("args").toString().equals(want), "args " + rs.get(0).getAsJsonObject("args"));
            check(s.mc().screen == null, "screen " + s.mc().screen);
            String bar = overlay(s);
            check(bar.equals("Autosketch: picks sent to the agent (request 12)"), "action bar " + bar);
            return true;
        }, 200);
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    /** The action bar's text the client set itself (not a server message, so the suite doesn't record it). Dev runtime names are Mojang's. */
    static String overlay(ClientTestSuite s) throws ReflectiveOperationException {
        java.lang.reflect.Field f = net.minecraft.client.gui.Gui.class.getDeclaredField("overlayMessageString");
        f.setAccessible(true);
        Object c = f.get(s.mc().gui);
        return c == null ? "" : ((Component) c).getString();
    }

    /** The suite's script with {@code candidates.open} answering {@code answered}, as the MCP does after a submit. */
    static String answeredScript() {
        try (InputStream in = CandidatesClientTests.class.getResourceAsStream("/clienttest/candidates.json")) {
            JsonObject o = JsonParser.parseString(new String(in.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
            JsonObject err = new JsonObject();
            err.addProperty("ok", false);
            err.addProperty("error", "answered");
            err.addProperty("message", "You already answered these candidates.");
            o.getAsJsonObject("results").add("candidates.open", err);
            return o.toString();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    static String script() {
        try (InputStream in = CandidatesClientTests.class.getResourceAsStream("/clienttest/candidates.json")) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    @ClientTest("candidates")
    public static void reopeningAfterSubmitShowsAnswered(ClientTestSuite s) {
        s.waitUntil("connected", connected(), 400);
        s.step("the MCP has had the answer", s::stopMcp);
        s.waitUntil("offline", () -> !LinkState.connected(), 400);
        s.step("it comes back answering candidates.open with answered", () -> s.startMcp(answeredScript()));
        s.waitUntil("connected again", connected(), 400);
        s.step("clear chat", s::clearMessages);
        s.step("the reply again", () -> reply(s));
        clickLine(s);
        s.waitUntil("the screen says it was answered, with no list to pick from", () -> {
            CandidatesScreen c = screen(s);
            check(c.loads() == 1 && c.answered(), "loads " + c.loads() + ", answered " + c.answered());
            check(c.loadError() != null && c.loadError().getString().equals("These candidates were already answered."), "line " + c.loadError());
            check(c.cells().isEmpty(), "cells " + c.cells());
            for (GuiEventListener l : s.mc().screen.children())
                check(!(l instanceof AbstractWidget w) || !w.getMessage().getString().equals("Submit"), "a Submit button");
            return true;
        }, 200);
        s.step("the link drops", s::stopMcp);
        s.waitUntil("the screen closes offline", () -> s.mc().screen == null, 200);
        s.cleanup("the suite's MCP comes back", () -> {
            if (s.mc().screen != null) s.mc().setScreen(null);
            s.startMcp(script());
        });
        s.waitUntil("connected again", connected(), 400);
    }

    // ── Preview here and Clear candidate ghost ───────────────────────────────────────────────

    static JsonArray vec(int... v) {
        JsonArray a = new JsonArray();
        for (int x : v) a.add(x);
        return a;
    }

    static JsonArray vec(BlockPos p) {
        return vec(p.getX(), p.getY(), p.getZ());
    }

    static String dimension(ClientTestSuite s) {
        return s.player().level().dimension().location().toString();
    }

    /** The MCP's candidate ghost at {@code origin}: {@code sections} (section coordinates) filled with {@code state}. */
    static JsonObject candidateGhost(ClientTestSuite s, BlockPos origin, String state, List<List<Integer>> sections) {
        JsonObject g = new JsonObject();
        g.addProperty("type", "ui.ghost");
        g.add("players", vec());
        g.getAsJsonArray("players").add(s.player().getUUID().toString());
        g.addProperty("ghost", "candidate");
        g.addProperty("dimension", dimension(s));
        g.add("origin", vec(origin));
        g.addProperty("tint", "#ffffff");
        g.addProperty("full", true);
        JsonArray palette = new JsonArray();
        palette.add(state);
        g.add("palette", palette);
        JsonArray secs = new JsonArray();
        for (List<Integer> sec : sections) {
            JsonObject o = new JsonObject();
            o.add("section", vec(sec.get(0), sec.get(1), sec.get(2)));
            o.addProperty("fill", state);
            secs.add(o);
        }
        g.add("sections", secs);
        return g;
    }

    static JsonObject okResult(JsonObject result) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "ui.result");
        o.addProperty("ok", true);
        o.add("result", result);
        return o;
    }

    static JsonObject clearCandidate(ClientTestSuite s) {
        JsonObject o = new JsonObject();
        o.addProperty("type", "ui.ghost.clear");
        o.add("players", new JsonArray());
        o.getAsJsonArray("players").add(s.player().getUUID().toString());
        o.addProperty("ghost", "candidate");
        return o;
    }

    static JsonObject reply(String kind, @Nullable JsonObject args, JsonObject... send) {
        JsonObject r = new JsonObject();
        r.addProperty("on", "ui.request");
        r.addProperty("kind", kind);
        if (args != null) r.add("args", args);
        JsonArray a = new JsonArray();
        for (JsonObject m : send) a.add(m);
        r.add("send", a);
        return r;
    }

    /**
     * The suite's script, plus what the MCP does for the candidate ghost (17, *Candidate ghost*):
     * {@code candidates.ghost} at {@code a} answers with one stone section there, at {@code b} with two
     * glass sections there (each a full {@code ui.ghost candidate} after the result, so the second
     * replaces the first); {@code candidates.ghost.clear} and {@code candidates.submit} are followed by
     * {@code ui.ghost.clear candidate}.
     */
    static String previewScript(ClientTestSuite s, BlockPos a, BlockPos b) {
        JsonObject o = JsonParser.parseString(script()).getAsJsonObject();
        JsonObject ghost = new JsonObject();
        ghost.addProperty("ghost", "candidate");
        JsonObject atA = new JsonObject();
        atA.add("at", vec(a));
        JsonObject atB = new JsonObject();
        atB.add("at", vec(b));
        JsonObject submitted = new JsonObject();
        submitted.addProperty("request", 12);
        JsonArray replies = new JsonArray();
        replies.add(reply("candidates.ghost", atA, okResult(ghost), candidateGhost(s, a, "minecraft:stone", List.of(List.of(0, 0, 0)))));
        replies.add(reply("candidates.ghost", atB, okResult(ghost), candidateGhost(s, b, "minecraft:glass", List.of(List.of(0, 0, 0), List.of(1, 0, 0)))));
        replies.add(reply("candidates.ghost.clear", null, okResult(new JsonObject()), clearCandidate(s)));
        replies.add(reply("candidates.submit", null, okResult(submitted), clearCandidate(s)));
        o.add("replies", replies);
        return o.toString();
    }

    /** Turns the player south at {@code pitch} and waits until the crosshair rests on a block, which it returns in {@code out}. */
    static void look(ClientTestSuite s, float pitch, BlockPos[] out) {
        s.step("look south, " + pitch + "° down", () -> {
            s.player().setYRot(0f);
            s.player().setXRot(pitch);
            s.player().yRotO = 0f;
            s.player().xRotO = pitch;
        });
        s.waitFrames("the crosshair moved", 3);
        s.waitUntil("the crosshair is on a block", () -> {
            HitResult h = s.mc().hitResult;
            check(h instanceof BlockHitResult && h.getType() == HitResult.Type.BLOCK, "crosshair on " + (h == null ? "nothing" : h.getType()));
            out[0] = ((BlockHitResult) h).getBlockPos();
            return true;
        }, 100);
    }

    private static void openFromTheLine(ClientTestSuite s) throws Exception {
        s.clearMessages();
        reply(s);
    }

    @ClientTest("candidates")
    public static void previewHereDrawsTheGhostAtTheCrosshairAndTheMenuClearsIt(ClientTestSuite s) {
        BlockPos[] a = {null}, b = {null}, at = {null};
        s.waitUntil("connected", connected(), 400);
        look(s, 75f, a);
        look(s, 40f, b);
        s.step("two different blocks to look at", () -> check(!a[0].equals(b[0]), "both " + a[0]));
        s.step("an MCP that answers the candidate ghost", s::stopMcp);
        s.waitUntil("offline", () -> !LinkState.connected(), 400);
        s.step("start it", () -> s.startMcp(previewScript(s, a[0], b[0])));
        s.waitUntil("connected again", connected(), 400);

        look(s, 75f, at);
        s.step("looking at the first block", () -> check(at[0].equals(a[0]), "crosshair " + at[0] + ", not " + a[0]));
        s.step("the agent replies with candidates", () -> openFromTheLine(s));
        clickLine(s);
        s.waitUntil("the list loaded", () -> screen(s).cells().size() == 3, 200);
        s.step("select B2", () -> s.clickWidget("gothic_tower_a"));
        s.waitUntil("B2 selected", () -> "B2".equals(screen(s).selected()), 100);
        s.step("tick it, then Preview here", () -> {
            s.clickWidget("Pick B2");
            s.clickWidget("Preview here");
        });
        s.waitUntil("candidates.ghost at the crosshair, the screen closed, the ghost drawn there", () -> {
            List<JsonObject> rs = requests(s, "candidates.ghost");
            check(rs.size() == 1, rs.size() + " candidates.ghost");
            String want = "{\"id\":\"c1\",\"prefab\":\"gothic_tower_a\",\"dimension\":\"" + dimension(s) + "\",\"at\":" + vec(a[0]) + "}";
            check(rs.get(0).getAsJsonObject("args").toString().equals(want), "args " + rs.get(0).getAsJsonObject("args"));
            check(s.mc().screen == null, "screen " + s.mc().screen);
            check(Ghosts.ids().equals(List.of("candidate")), "ghosts " + Ghosts.ids());
            String origin = dimension(s) + " " + a[0].getX() + " " + a[0].getY() + " " + a[0].getZ() + " #ffffff";
            check(origin.equals(Ghosts.describe("candidate")), "ghost " + Ghosts.describe("candidate"));
            check(Ghosts.sections("candidate").equals(Set.of(List.of(0, 0, 0))), "sections " + Ghosts.sections("candidate"));
            check(Ghosts.pending() == 0 && Ghosts.drawnSections() > 0, "pending " + Ghosts.pending() + ", drawn " + Ghosts.drawnSections());
            check(overlay(s).equals("Autosketch: previewing B2 gothic_tower_a here (clear it from the Autosketch menu)"), "action bar " + overlay(s));
            return true;
        }, 400);

        look(s, 40f, at);
        s.step("looking at the second block", () -> check(at[0].equals(b[0]), "crosshair " + at[0] + ", not " + b[0]));
        s.step("reopen from the line", () -> openFromTheLine(s));
        clickLine(s);
        s.waitUntil("the screen kept the selection and the tick", () -> {
            CandidatesScreen c = screen(s);
            check(c.cells().size() == 3, "cells " + c.cells());
            check("B2".equals(c.selected()) && c.ticked().equals(List.of("B2")), "selected " + c.selected() + ", ticked " + c.ticked());
            return true;
        }, 200);
        s.step("select C2", () -> s.clickWidget("round_keep_tower"));
        s.waitUntil("C2 selected", () -> "C2".equals(screen(s).selected()), 100);
        s.step("Preview here", () -> s.clickWidget("Preview here"));
        s.waitUntil("the second preview replaced the first: one candidate ghost, at the new crosshair", () -> {
            List<JsonObject> rs = requests(s, "candidates.ghost");
            check(rs.size() == 2, rs.size() + " candidates.ghost");
            String want = "{\"id\":\"c1\",\"prefab\":\"round_keep_tower\",\"dimension\":\"" + dimension(s) + "\",\"at\":" + vec(b[0]) + "}";
            check(rs.get(1).getAsJsonObject("args").toString().equals(want), "args " + rs.get(1).getAsJsonObject("args"));
            check(s.mc().screen == null, "screen " + s.mc().screen);
            check(Ghosts.ids().equals(List.of("candidate")), "ghosts " + Ghosts.ids());
            String origin = dimension(s) + " " + b[0].getX() + " " + b[0].getY() + " " + b[0].getZ() + " #ffffff";
            check(origin.equals(Ghosts.describe("candidate")), "ghost " + Ghosts.describe("candidate"));
            check(Ghosts.sections("candidate").equals(Set.of(List.of(0, 0, 0), List.of(1, 0, 0))), "sections " + Ghosts.sections("candidate"));
            check(Ghosts.pending() == 0, "pending " + Ghosts.pending());
            return true;
        }, 400);
        s.waitFrames("drawn", 3);
        s.step("screenshot for review (not compared)", () -> s.screenshot("candidates-preview").close());

        s.step("Clear candidate ghost in the Autosketch menu", () -> {
            s.mc().setScreen(new MenuScreen(null));
            s.clickWidget("Clear candidate ghost");
        });
        s.waitUntil("candidates.ghost.clear sent, the menu closed, the ghost gone", () -> {
            List<JsonObject> rs = requests(s, "candidates.ghost.clear");
            check(rs.size() == 1 && rs.get(0).getAsJsonObject("args").toString().equals("{}"), "clears " + rs);
            check(s.mc().screen == null, "screen " + s.mc().screen);
            check(Ghosts.ids().isEmpty() && Ghosts.meshBytes() == 0, "ghosts " + Ghosts.ids());
            check(overlay(s).equals("Autosketch: candidate ghost cleared"), "action bar " + overlay(s));
            return true;
        }, 400);

        s.step("reopen and preview C2 again", () -> openFromTheLine(s));
        clickLine(s);
        s.waitUntil("C2 still selected", () -> "C2".equals(screen(s).selected()) && screen(s).loads() == 1, 200);
        s.step("Preview here", () -> s.clickWidget("Preview here"));
        s.waitUntil("shown again", () -> Ghosts.ids().equals(List.of("candidate")) && s.mc().screen == null, 400);
        s.step("reopen and Submit", () -> openFromTheLine(s));
        clickLine(s);
        s.waitUntil("loaded with B2 ticked", () -> screen(s).ticked().equals(List.of("B2")), 200);
        s.step("Submit", () -> s.clickWidget("Submit"));
        s.waitUntil("submitted, the screen closed, the candidate ghost cleared", () -> {
            check(requests(s, "candidates.submit").size() == 1, "submits " + requests(s, "candidates.submit").size());
            check(s.mc().screen == null, "screen " + s.mc().screen);
            check(Ghosts.ids().isEmpty(), "ghosts " + Ghosts.ids());
            return true;
        }, 400);
        s.step("a list submitted starts fresh", () -> {
            openFromTheLine(s);
        });
        clickLine(s);
        s.waitUntil("nothing kept", () -> screen(s).loads() == 1 && screen(s).selected() == null && screen(s).ticked().isEmpty(), 200);

        s.cleanup("the suite's MCP comes back", () -> {
            if (s.mc().screen != null) s.mc().setScreen(null);
            s.startMcp(script());
        });
        s.waitUntil("connected again", connected(), 400);
    }
}
