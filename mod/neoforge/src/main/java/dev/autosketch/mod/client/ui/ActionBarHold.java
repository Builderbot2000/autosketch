package dev.autosketch.mod.client.ui;

import dev.autosketch.mod.feedback.Feedback;
import net.minecraft.Util;
import net.neoforged.neoforge.client.event.ClientChatReceivedEvent;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.common.NeoForge;

/**
 * Keeps any other action-bar line up for its normal time before the wand's repeated mode line
 * ({@code Autosketch wand: work mode}) takes the action bar again (18, *Implementation status*, C5).
 * While the wand is held, the server's {@link Feedback} re-sends the mode line every second, holding
 * back only for its own notices; the client half's own lines (answer sent, picks sent, previewing,
 * candidate ghost cleared, key toggles…) and any other mod's would vanish within a second.
 *
 * <p>Every action-bar line, the client's own and the server's alike, passes NeoForge's system chat
 * event ({@code ChatListener.handleSystemMessage}), so this needs no change where lines are written:
 * a line that isn't a mode line starts a hold of {@link #HOLD_MS} (the action bar's own 60 ticks);
 * during it, a mode line identical to the last mode line seen (the periodic repeat) is dropped. A
 * mode line that differs (the player switched modes) is shown at once.
 */
public final class ActionBarHold {
    private ActionBarHold() {}

    /** How long another line keeps the repeated mode line off: the action bar's 60 ticks. */
    public static final long HOLD_MS = 3000;

    private static long holdUntil;
    private static String lastModeLine;

    static void init() {
        NeoForge.EVENT_BUS.addListener(ActionBarHold::onSystemChat);
        NeoForge.EVENT_BUS.addListener((ClientPlayerNetworkEvent.LoggingOut e) -> reset());
    }

    private static void onSystemChat(ClientChatReceivedEvent.System e) {
        if (!e.isOverlay()) return;
        if (!accept(e.getMessage().getString(), Util.getMillis())) e.setCanceled(true);
    }

    /** Whether the action-bar line {@code text} arriving at {@code now} (ms) is shown; records it either way. */
    static synchronized boolean accept(String text, long now) {
        if (!text.startsWith(Feedback.MODE_LINE_PREFIX)) {
            holdUntil = now + HOLD_MS;
            return true;
        }
        boolean repeat = text.equals(lastModeLine);
        lastModeLine = text;
        return !(repeat && now < holdUntil);
    }

    static synchronized void reset() {
        holdUntil = 0;
        lastModeLine = null;
    }
}
