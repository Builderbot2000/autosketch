package dev.autosketch.mod.client.ui.chat;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.UiClient;
import dev.autosketch.mod.client.ui.chat.mixin.ChatComponentAccess;
import dev.autosketch.mod.prompt.InGamePrompts;
import dev.autosketch.mod.prompt.StatusLines;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.RequestMessages.Status;
import dev.autosketch.mod.protocol.RequestMessages.StatusAction;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.ChatFormatting;
import net.minecraft.client.GuiMessage;
import net.minecraft.client.GuiMessageTag;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.ChatComponent;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.common.NeoForge;
import org.jetbrains.annotations.Nullable;

/**
 * Status lines, client half (19, *Status line*; 13, *Relay to the client*): one chat line per
 * request id, added on its first status and replaced in place by every later one, so a request reads
 * {@code working → stopping → stopped} on one line. The text is the MCP's {@code lines[0]} as sent;
 * each button is {@code [label]} after it, running {@code /autosketch action <n>} with the number the
 * server half kept for it ({@link StatusLines#ACTION_IDS}), so the click goes out as that
 * {@code ui.request} the way a reply line's action does (17, piece 3). A line that has scrolled out
 * of chat's history is added again at the bottom.
 *
 * <p>Also the HUD's source (16, *HUD*): the latest {@code working} or {@code stopping} status and the
 * count of {@code queued} ones. Forgotten when the link leaves {@code connected} or the player leaves
 * the server (the MCP numbers requests per connection). Client thread only.
 */
public final class StatusLineClient {
    private StatusLineClient() {}

    /** Requests kept for rewriting; older ones are forgotten (their lines stay as they are). */
    static final int KEPT = 64;

    /** The hover text of a status-line button. */
    public static final String BUTTON_HOVER = "Click to send";

    private static final class Entry {
        Status status;
        @Nullable GuiMessage message;
        long seq;
    }

    private static final Map<Long, Entry> ENTRIES = new LinkedHashMap<>() {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Long, Entry> eldest) {
            return size() > KEPT;
        }
    };
    private static long seq;

    public static void init() {
        UiClient.register("chat", StatusLineClient::onFrame);
        LinkState.addListener(s -> {
            if (s != LinkState.State.CONNECTED) reset();
        });
        NeoForge.EVENT_BUS.addListener((ClientPlayerNetworkEvent.LoggingOut e) -> reset());
    }

    static void onFrame(Frame f, Record m) {
        if (!(m instanceof Status s)) return;
        List<Long> ids = new ArrayList<>();
        JsonElement e = f.header().get(StatusLines.ACTION_IDS);
        if (e != null && e.isJsonArray())
            for (JsonElement x : (JsonArray) e)
                if (x.isJsonPrimitive() && x.getAsJsonPrimitive().isNumber()) ids.add(x.getAsLong());
        show(s, ids);
    }

    /** Adds or replaces the request's line. */
    static void show(Status s, List<Long> actionIds) {
        Minecraft mc = Minecraft.getInstance();
        Component line = component(s, actionIds);
        Entry entry = ENTRIES.computeIfAbsent(s.request(), k -> new Entry());
        entry.status = s;
        entry.seq = ++seq;
        ChatComponent chat = mc.gui.getChat();
        List<GuiMessage> all = ((ChatComponentAccess) chat).autosketch$allMessages();
        int at = entry.message == null ? -1 : indexOf(all, entry.message);
        if (at >= 0) {
            GuiMessage old = all.get(at);
            GuiMessage next = new GuiMessage(mc.gui.getGuiTicks(), line, null, old.tag());
            all.set(at, next);
            entry.message = next;
            ((ChatComponentAccess) chat).autosketch$refreshTrimmedMessages();
            return;
        }
        chat.addMessage(line, null, mc.isSingleplayer() ? GuiMessageTag.systemSinglePlayer() : GuiMessageTag.system());
        entry.message = all.isEmpty() ? null : all.get(0);
    }

    private static int indexOf(List<GuiMessage> all, GuiMessage m) {
        for (int i = 0; i < all.size(); i++) if (all.get(i) == m) return i;
        return -1;
    }

    /** The line: {@code lines[0]} in the state's colour, then {@code [label]} per button. */
    public static Component component(Status s, List<Long> actionIds) {
        MutableComponent c = Component.literal(s.line()).withStyle(StatusLines.colour(s.state()));
        List<StatusAction> actions = s.actions();
        for (int i = 0; i < actions.size(); i++) {
            String label = "[" + actions.get(i).label() + "]";
            c.append(Component.literal("  "));
            if (i < actionIds.size()) {
                String command = InGamePrompts.actionCommand(actionIds.get(i));
                c.append(Component.literal(label).withStyle(st -> st.withColor(ChatFormatting.AQUA).withUnderlined(true)
                        .withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, command))
                        .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Component.literal(BUTTON_HOVER)))));
            } else c.append(Component.literal(label).withStyle(ChatFormatting.DARK_GRAY));
        }
        return c;
    }

    /** The status kept for a request, or null. */
    public static @Nullable Status status(long request) {
        Entry e = ENTRIES.get(request);
        return e == null ? null : e.status;
    }

    /** The chat message now showing a request's line, or null (for tests). */
    public static @Nullable GuiMessage message(long request) {
        Entry e = ENTRIES.get(request);
        return e == null ? null : e.message;
    }

    /** The HUD's request line: the latest {@code working} or {@code stopping} status, or null. */
    public static @Nullable Status active() {
        Entry best = null;
        for (Entry e : ENTRIES.values())
            if ((e.status.state().equals("working") || e.status.state().equals("stopping")) && (best == null || e.seq > best.seq)) best = e;
        return best == null ? null : best.status;
    }

    /** How many of the player's prompts are queued now. */
    public static int queued() {
        int n = 0;
        for (Entry e : ENTRIES.values()) if (e.status.state().equals("queued")) n++;
        return n;
    }

    public static void reset() {
        ENTRIES.clear();
    }
}
