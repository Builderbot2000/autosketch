package dev.autosketch.mod.client.ui.chat;

import com.google.gson.JsonElement;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.UiClient;
import dev.autosketch.mod.client.ui.chat.mixin.ChatComponentAccess;
import dev.autosketch.mod.prompt.ChoiceLines;
import dev.autosketch.mod.prompt.InGamePrompts;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import java.util.ArrayList;
import java.util.Collections;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.ChatFormatting;
import net.minecraft.client.GuiMessage;
import net.minecraft.client.GuiMessageTag;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.ChatComponent;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;

/**
 * Folding answered choices, client half (18, piece 7, *Folding*; {@link ChoiceLines} is the server
 * half). A question's choice lines and its closing "or type your own answer" line arrive as relayed
 * {@code chat} frames tagged with the question; this adds them to chat, formatted as the server half
 * would print them (the clickable line runs the {@code /autosketch action} number the frame
 * carries), and keeps their chat messages. When {@code choices.answered} names the question, the
 * oldest of them still in chat becomes one dimmed line, {@code ✔ [2] ruin 180 blocks west}, and the
 * rest are removed, so the answered question reads as its answer. Lines that scrolled out of chat's
 * history are simply gone; the question's own text (its first message) is not touched.
 *
 * <p>Forgotten when the link leaves {@code connected} or the player leaves the server (the MCP
 * numbers questions per session). Client thread only.
 */
public final class ChoiceLinesClient {
    private ChoiceLinesClient() {}

    /** Questions kept for folding; older ones are forgotten (their lines stay as they are). */
    static final int KEPT = 32;

    /** One message of a question: its choice index (-1 for the closing line), its text and its chat messages (one per wrapped piece). */
    private record Part(int index, String text, List<GuiMessage> messages) {}

    private static final Map<String, List<Part>> QUESTIONS = new LinkedHashMap<>() {
        @Override
        protected boolean removeEldestEntry(Map.Entry<String, List<Part>> eldest) {
            return size() > KEPT;
        }
    };

    public static void init() {
        UiClient.register("chat", ChoiceLinesClient::onChat);
        UiClient.register("choices.answered", ChoiceLinesClient::onAnswered);
        LinkState.addListener(s -> {
            if (s != LinkState.State.CONNECTED) reset();
        });
        net.neoforged.neoforge.common.NeoForge.EVENT_BUS.addListener((net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent.LoggingOut e) -> reset());
    }

    static void onChat(Frame f, Record m) {
        if (!(m instanceof Messages.Chat c) || c.question() == null) return;
        JsonElement id = f.header().get(ChoiceLines.ACTION_ID);
        long actionId = id != null && id.isJsonPrimitive() && id.getAsJsonPrimitive().isNumber() ? id.getAsLong() : 0;
        show(c, actionId);
    }

    /** Adds a question's chat as the server half would print it, and keeps its messages. */
    static void show(Messages.Chat c, long actionId) {
        Messages.ChatAction a = c.action();
        List<Component> lines = InGamePrompts.format(c.lines(), c.reply(), a == null ? -1 : a.line(), actionId, a == null ? InGamePrompts.ACTION_HOVER : InGamePrompts.actionHover(a.kind()));
        Minecraft mc = Minecraft.getInstance();
        ChatComponent chat = mc.gui.getChat();
        List<GuiMessage> all = ((ChatComponentAccess) chat).autosketch$allMessages();
        List<GuiMessage> added = new ArrayList<>();
        for (Component line : lines) {
            chat.addMessage(line, null, mc.isSingleplayer() ? GuiMessageTag.systemSinglePlayer() : GuiMessageTag.system());
            if (!all.isEmpty()) added.add(all.get(0));
        }
        QUESTIONS.computeIfAbsent(c.question(), k -> new ArrayList<>()).add(new Part(choiceIndex(a), String.join(" ", c.lines()), added));
    }

    private static int choiceIndex(Messages.@Nullable ChatAction a) {
        if (a == null || !a.kind().equals("choices.pick")) return -1;
        JsonElement i = a.args().get("index");
        return i != null && i.isJsonPrimitive() && i.getAsJsonPrimitive().isNumber() ? i.getAsInt() : -1;
    }

    static void onAnswered(Frame f, Record m) {
        if (m instanceof Messages.ChoicesAnswered a) fold(a.question(), a.index());
    }

    /** Folds a question's lines to the taken choice's; false when it isn't known or none of its lines is still in chat. */
    static boolean fold(String question, int index) {
        List<Part> parts = QUESTIONS.remove(question);
        if (parts == null) return false;
        Set<GuiMessage> mine = Collections.newSetFromMap(new IdentityHashMap<>());
        String taken = "[" + (index + 1) + "]";
        for (Part p : parts) {
            mine.addAll(p.messages());
            if (p.index() == index) taken = p.text();
        }
        Minecraft mc = Minecraft.getInstance();
        ChatComponent chat = mc.gui.getChat();
        List<GuiMessage> all = ((ChatComponentAccess) chat).autosketch$allMessages();
        // Newest first: the highest index is the question's first line still in chat.
        int keep = -1;
        for (int i = all.size() - 1; i >= 0 && keep < 0; i--) if (mine.contains(all.get(i))) keep = i;
        if (keep < 0) return false;
        GuiMessage old = all.get(keep);
        all.set(keep, new GuiMessage(mc.gui.getGuiTicks(), folded(taken), null, old.tag()));
        for (int i = keep - 1; i >= 0; i--) if (mine.contains(all.get(i))) all.remove(i);
        ((ChatComponentAccess) chat).autosketch$refreshTrimmedMessages();
        return true;
    }

    /** The folded line: the agent's prefix, a check and the taken choice's text, dimmed. */
    public static Component folded(String text) {
        return Component.literal("Agent: ").withStyle(ChatFormatting.AQUA, ChatFormatting.BOLD)
                .append(Component.literal("✔ ").withStyle(ChatFormatting.GREEN))
                .append(Component.literal(text).withStyle(ChatFormatting.GRAY));
    }

    /** Whether a question's lines are kept (for tests). */
    public static boolean tracked(String question) {
        return QUESTIONS.containsKey(question);
    }

    public static void reset() {
        QUESTIONS.clear();
    }
}
