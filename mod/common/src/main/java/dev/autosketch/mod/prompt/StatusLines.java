package dev.autosketch.mod.prompt;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.command.RequestCommands;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.RequestMessages.Status;
import dev.autosketch.mod.protocol.RequestMessages.StatusAction;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.ChatFormatting;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.jetbrains.annotations.Nullable;

/**
 * Status lines, server half (19, *Status line*; 13, {@code chat} kind {@code status}, *Relay to the
 * client*). A status line goes to its own player only, and only when they may use
 * {@code /autosketch} (op level 2, as all agent output); the log setting doesn't apply.
 *
 * <ul>
 *   <li><b>With the client half</b> the frame is relayed whole (relay op 0) and not printed, so the
 *       client replaces its line in place by {@code request}. Each button is kept as a reply-line
 *       action ({@link InGamePrompts#remember}) and the relayed copy carries their numbers in
 *       {@link #ACTION_IDS}, so a click runs {@code /autosketch action <n>} as a reply line's does
 *       (17, piece 3).
 *   <li><b>Without it</b> {@code lines[0]} is printed as a new plain line only when the state differs
 *       from the last one printed for that request, followed by the command for the buttons a vanilla
 *       client can't show ({@code /autosketch stop}, {@code /autosketch queue cancel <n>}), clickable
 *       as a vanilla run-command.
 * </ul>
 *
 * Server thread only.
 */
public final class StatusLines {
    private StatusLines() {}

    /**
     * Header key the server half adds to a relayed status line: the {@code /autosketch action} number
     * of each button, in {@code actions} order. Relay-internal (both halves ship in one jar).
     */
    public static final String ACTION_IDS = "actionIds";

    /** Requests whose last printed state is kept for the plain fallback; older ones are forgotten. */
    static final int KEPT = 256;

    /** Hands a frame to a player's client half; false when their client lacks the channel. */
    @FunctionalInterface
    public interface Relay {
        boolean relay(ServerPlayer player, Frame frame);
    }

    private static volatile Relay relay = (p, f) -> false;

    /** Installs the relay (the loader's channel; tests). Returns the previous one. */
    public static Relay setRelay(Relay r) {
        Relay prev = relay;
        relay = r;
        return prev;
    }

    private static final Map<Long, String> PRINTED = Collections.synchronizedMap(new LinkedHashMap<>() {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Long, String> eldest) {
            return size() > KEPT;
        }
    });

    /** Forgets the printed states (the bridge disconnected: the MCP's request ids start again). */
    public static void reset() {
        PRINTED.clear();
    }

    /**
     * Handles one status line. Returns {@code "relayed"}, {@code "printed"} or {@code "skipped"} (no
     * such player online, not an op, or the plain line's state unchanged).
     */
    public static String onStatus(Status s, MinecraftServer server) {
        ServerPlayer p = server.getPlayerList().getPlayer(s.player());
        if (p == null || !p.hasPermissions(CommandExtension.OP_LEVEL)) return "skipped";
        if (relay.relay(p, relayed(s))) return "relayed";
        String last = PRINTED.put(s.request(), s.state());
        if (s.state().equals(last)) return "skipped";
        InGamePrompts.output().chat(p, plain(s));
        return "printed";
    }

    /** The frame sent to the client half: the status line with each button's action number. */
    static Frame relayed(Status s) {
        Frame f = s.encode();
        JsonObject h = f.header();
        JsonArray ids = new JsonArray();
        for (StatusAction a : s.actions()) ids.add(InGamePrompts.remember(new Messages.ChatAction(0, a.kind(), a.args())));
        h.add(ACTION_IDS, ids);
        return new Frame(h);
    }

    /** The plain line for a client without the client half: {@code lines[0]}, then the command hint. */
    public static Component plain(Status s) {
        MutableComponent c = Component.literal(s.line()).withStyle(colour(s.state()));
        String command = hint(s);
        if (command != null)
            c.append(Component.literal("  " + command).withStyle(st -> st.withColor(ChatFormatting.AQUA).withUnderlined(true)
                    .withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, command))
                    .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Component.literal("Click to run " + command)))));
        return c;
    }

    /** The command standing in for the buttons a vanilla client can't show, or null. */
    public static @Nullable String hint(Status s) {
        return switch (s.state()) {
            case "working" -> RequestCommands.STOP_COMMAND;
            case "queued" -> s.queuePos() == null ? null : RequestCommands.cancelCommand(s.queuePos());
            default -> null;
        };
    }

    /** The colour of a status line by state (shared with the client half). */
    public static ChatFormatting colour(String state) {
        return switch (state) {
            case "working" -> ChatFormatting.GOLD;
            case "stopping", "stopped" -> ChatFormatting.RED;
            case "done" -> ChatFormatting.GREEN;
            default -> ChatFormatting.GRAY;
        };
    }

    /** For tests: the request ids with a printed state. */
    static Map<Long, String> printed() {
        return Map.copyOf(PRINTED);
    }
}
