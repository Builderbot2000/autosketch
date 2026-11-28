package dev.autosketch.mod.prompt;

import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/**
 * Folding answered choices, server half (18, piece 7, *Folding*; feature {@code choices.fold}). A
 * {@code chat} reply tagged with a {@code question} goes whole to a player whose client runs the
 * client half, as a relay frame, instead of being printed: the client adds the lines itself, so it
 * owns them and can fold them. The frame carries the {@code /autosketch action} number the server
 * half kept for the line's action in {@link #ACTION_ID}, as status lines carry theirs. Everyone else
 * gets the printed lines as before, and nothing folds for them. {@code choices.answered} is relayed
 * to every op whose client has the channel; a client that never showed the question ignores it.
 *
 * <p>Server thread only.
 */
public final class ChoiceLines {
    private ChoiceLines() {}

    /** Header key the server half adds to a relayed choice line: its action's number. Relay-internal (both halves ship in one jar). */
    public static final String ACTION_ID = "actionId";

    private static volatile StatusLines.Relay relay = (p, f) -> false;

    /** Installs the relay (the loader's channel; tests). Returns the previous one. */
    public static StatusLines.Relay setRelay(StatusLines.Relay r) {
        StatusLines.Relay prev = relay;
        relay = r;
        return prev;
    }

    /** Hands one question's chat to a player's client half; false when their client lacks the channel (the caller prints it). */
    static boolean relay(ServerPlayer p, Messages.Chat chat, long actionId) {
        Frame f = chat.encode();
        if (chat.action() != null) f.header().addProperty(ACTION_ID, actionId);
        return relay.relay(p, f);
    }

    /** Handles {@code choices.answered}: relayed to each op's client half. Returns how many it reached. */
    public static int onAnswered(Messages.ChoicesAnswered a, MinecraftServer server) {
        Frame f = a.encode();
        int reached = 0;
        for (ServerPlayer p : server.getPlayerList().getPlayers())
            if (p.hasPermissions(CommandExtension.OP_LEVEL) && relay.relay(p, f)) reached++;
        return reached;
    }
}
