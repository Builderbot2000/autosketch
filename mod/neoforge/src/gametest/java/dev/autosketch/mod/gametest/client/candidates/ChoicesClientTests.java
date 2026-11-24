package dev.autosketch.mod.gametest.client.candidates;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.google.gson.JsonObject;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import dev.autosketch.mod.gametest.client.overlay.VolumeOverlayClientTests;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.prompt.InGamePrompts;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import org.jetbrains.annotations.Nullable;

/**
 * Choice lines (18, piece 7, *Testing*, client suite; briefs/select/C, the click C1 left for C2): the
 * agent's question, one {@code chat} reply per choice with the action {@code choices.pick}, and the
 * free-text line, sent through the mod's own {@code chat} handler; a click runs the line's
 * {@code /autosketch action <n>} as the chat screen does, and the client half sends
 * {@code choices.pick {id, index}}. The suite's fake MCP ({@code clienttest/candidates.json}) answers
 * choice 0 with request 21 and choice 1 with {@code answered}.
 */
public final class ChoicesClientTests {
    private ChoicesClientTests() {}

    static final List<String> CHOICES = List.of("[1] mossy stone brick house, 40 blocks north-east", "[2] the ruin by the river");
    static final String QUESTION = "Which one do you mean?", FREE = "or type your own answer";

    static @Nullable String hover(Component c) {
        String[] found = {null};
        c.visit((style, text) -> {
            HoverEvent h = style.getHoverEvent();
            if (h != null && h.getValue(HoverEvent.Action.SHOW_TEXT) != null) found[0] = h.getValue(HoverEvent.Action.SHOW_TEXT).getString();
            return Optional.empty();
        }, net.minecraft.network.chat.Style.EMPTY);
        return found[0];
    }

    private static void plain(ClientTestSuite s, UUID me, String line) throws Exception {
        s.onServer(server -> InGamePrompts.onChat(new Messages.Chat(21L, me, Messages.Chat.REPLY, List.of(line), null), server));
    }

    private static List<JsonObject> picks(ClientTestSuite s) {
        return s.mcp().received("ui.request").stream().filter(r -> r.get("kind").getAsString().equals("choices.pick")).toList();
    }

    @ClientTest("candidates")
    public static void choiceLinesSendTheirIndexOnClick(ClientTestSuite s) {
        String[] commands = new String[CHOICES.size()];
        ActionBar bar = new ActionBar();
        s.waitUntil("connected", () -> LinkState.connected(), 400);
        int[] slot = VolumeOverlayClientTests.awayFromTheWand(s);
        s.step("clear chat", s::clearMessages);
        s.step("the agent asks, one reply per choice, then the free-text line", () -> {
            UUID me = s.player().getUUID();
            plain(s, me, QUESTION);
            for (int i = 0; i < CHOICES.size(); i++) {
                JsonObject args = new JsonObject();
                args.addProperty("id", "q1");
                args.addProperty("index", i);
                Messages.Chat c = new Messages.Chat(21L, me, Messages.Chat.REPLY, List.of(CHOICES.get(i)), new Messages.ChatAction(0, "choices.pick", args));
                s.onServer(server -> InGamePrompts.onChat(c, server));
            }
            plain(s, me, FREE);
        });
        s.waitUntil("each choice is its own clickable line; the question and the free-text line aren't", () -> {
            List<Component> lines = s.chatComponents();
            Component q = last(lines, QUESTION), f = last(lines, FREE);
            check(q != null && f != null, "chat " + s.chat());
            check(CandidatesClientTests.click(q) == null && CandidatesClientTests.click(f) == null, "the question or the free-text line is clickable");
            for (int i = 0; i < CHOICES.size(); i++) {
                Component c = last(lines, CHOICES.get(i));
                check(c != null, "choice " + i + " missing: " + s.chat());
                commands[i] = CandidatesClientTests.click(c);
                check(commands[i] != null && commands[i].startsWith("/autosketch action "), "choice " + i + " runs " + commands[i]);
                check(InGamePrompts.CHOICE_HOVER.equals(hover(c)), "choice " + i + " hover " + hover(c));
            }
            check(!commands[0].equals(commands[1]), "both choices run " + commands[0]);
            return true;
        }, 200);
        s.step("record the action bar from here", () -> bar.reset(s));
        s.step("click the first choice", () -> check(s.player().connection.sendUnsignedCommand(commands[0].substring(1)), "the command needs signing"));
        s.waitUntil("choices.pick {id: q1, index: 0} sent, and the action bar says the answer went out", () -> {
            List<String> seen = bar.seen(s);
            List<JsonObject> rs = picks(s);
            check(rs.size() == 1, rs.size() + " choices.pick");
            check(rs.get(0).getAsJsonObject("args").toString().equals("{\"id\":\"q1\",\"index\":0}"), "args " + rs.get(0).getAsJsonObject("args"));
            check(seen.contains("Autosketch: answer sent to the agent"), "action bar since the click " + seen);
            return true;
        }, 200);
        s.step("record the action bar from here", () -> bar.reset(s));
        s.step("click the second choice", () -> check(s.player().connection.sendUnsignedCommand(commands[1].substring(1)), "the command needs signing"));
        s.waitUntil("choices.pick {id: q1, index: 1} sent, and the refusal on the action bar", () -> {
            List<String> seen = bar.seen(s);
            List<JsonObject> rs = picks(s);
            check(rs.size() == 2, rs.size() + " choices.pick");
            check(rs.get(1).getAsJsonObject("args").toString().equals("{\"id\":\"q1\",\"index\":1}"), "args " + rs.get(1).getAsJsonObject("args"));
            check(seen.contains("Autosketch: You already answered this question."), "action bar since the click " + seen);
            return true;
        }, 200);
        s.cleanup("the hotbar slot back", () -> {
            if (slot[0] >= 0) s.player().getInventory().selected = slot[0];
        });
    }

    /**
     * The action-bar texts shown since {@link #reset}, recorded as they change: the client half's own
     * messages never pass the chat event the suite records, and a later one (the wand's mode line, a
     * notice) may overwrite the one a check waits for, so a check reads this list rather than the
     * text on screen now. Polled from the wait's condition, every tick.
     */
    static final class ActionBar {
        private Object last;
        private final List<String> seen = new java.util.ArrayList<>();

        void reset(ClientTestSuite s) throws ReflectiveOperationException {
            last = current(s);
            seen.clear();
        }

        List<String> seen(ClientTestSuite s) throws ReflectiveOperationException {
            Object c = current(s);
            if (c != null && c != last) seen.add(((Component) c).getString());
            last = c;
            return List.copyOf(seen);
        }

        private static Object current(ClientTestSuite s) throws ReflectiveOperationException {
            java.lang.reflect.Field f = net.minecraft.client.gui.Gui.class.getDeclaredField("overlayMessageString");
            f.setAccessible(true);
            return f.get(s.mc().gui);
        }
    }

    private static @Nullable Component last(List<Component> lines, String text) {
        return lines.stream().filter(c -> c.getString().contains(text)).reduce((a, b) -> b).orElse(null);
    }
}
