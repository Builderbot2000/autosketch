package dev.autosketch.mod.prompt;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import org.jetbrains.annotations.Nullable;

/**
 * Who sees a {@code chat} line and how it is cut (13, *Prompting from the game*, "Which requests
 * stream"; *Wire format*, {@code chat}). The MCP sends every line to everyone linked; the mod filters
 * by each player's {@code /autosketch log} setting and the line's player.
 */
public final class ChatRules {
    private ChatRules() {}

    /** {@code /autosketch log off|mine|all}. */
    public enum LogMode {
        /** Nothing but replies to their own requests. */
        OFF,
        /** Activity following their own requests, and replies to them (the default). */
        MINE,
        /** Everything the agent does on the linked document, including work prompted from the terminal. */
        ALL;

        public String id() {
            return name().toLowerCase(Locale.ROOT);
        }

        public static @Nullable LogMode parse(@Nullable String s) {
            if (s == null) return null;
            for (LogMode m : values()) if (m.id().equals(s)) return m;
            return null;
        }
    }

    /** Longest line shown in one chat message; longer lines wrap at a space where there is one. */
    public static final int WRAP = 100;

    /**
     * Whether a viewer sees a {@code chat} of this kind addressed to {@code target} (null: no requesting
     * player): the named player sees a reply always and activity unless their log is {@code off};
     * everyone else only with log {@code all}.
     */
    public static boolean visible(LogMode viewerMode, UUID viewer, @Nullable UUID target, boolean reply) {
        if (viewer.equals(target)) return reply || viewerMode != LogMode.OFF;
        return viewerMode == LogMode.ALL;
    }

    /** Splits a line into pieces of at most {@code width} characters, breaking at the last space when possible. */
    public static List<String> wrap(String line, int width) {
        List<String> out = new ArrayList<>();
        String rest = line;
        while (rest.length() > width) {
            int cut = rest.lastIndexOf(' ', width);
            if (cut <= 0) cut = width;
            out.add(rest.substring(0, cut));
            rest = rest.substring(cut).stripLeading();
        }
        out.add(rest);
        return out;
    }

    /** The action-bar text for a {@code prompt.result} (13: "delivered, or why not"). */
    public static String resultText(boolean delivered, @Nullable String reason) {
        if (delivered) return "Autosketch: request delivered to the agent";
        if (reason == null) return "Autosketch: request not delivered";
        return switch (reason) {
            case "no_link" -> "Autosketch: not delivered: no linked world document (set a work volume and link it from the agent)";
            case "not_allowed" -> "Autosketch: not delivered: you are not on the agent's allowed players (world.promptPlayers)";
            case "no_listener" -> "Autosketch: not delivered: no agent session is listening";
            default -> "Autosketch: not delivered: " + reason;
        };
    }
}
