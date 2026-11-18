package dev.autosketch.mod.gametest.client.candidates;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.screen.CandidatesScreen;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.prompt.InGamePrompts;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Checkbox;
import net.minecraft.client.gui.components.EditBox;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.Style;
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
}
