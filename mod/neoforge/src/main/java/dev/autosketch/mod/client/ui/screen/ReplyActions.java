package dev.autosketch.mod.client.ui.screen;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.logging.LogUtils;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.UiClient;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;

/**
 * The client half of a clickable reply line (17, piece 3; 13, {@code chat}): the click runs
 * {@code /autosketch action <n>}, and the server half hands back the client action
 * {@code chat.action <kind> <args JSON>}, as replay's log lines do. This sends that {@code ui.request}:
 * {@code candidates.open} opens the {@link CandidatesScreen}, which sends it and shows its answer;
 * any other kind is sent as it is, with a refusal on the action bar ({@code choices.pick}, a choice
 * line, 18 piece 7, also says on the action bar that the answer went out). Nothing is sent unless
 * {@link LinkState} is connected. Client thread.
 */
final class ReplyActions {
    private ReplyActions() {}

    private static final Logger LOG = LogUtils.getLogger();

    /** The client action's name (the server half's {@code ReplyActionCommand.ACTION}). */
    static final String ACTION = "chat.action";

    /** A choice line's kind (18, piece 7): {@code {id, index}}, answered {@code {request}} or {@code answered}. */
    static final String CHOICE = "choices.pick";

    /** The action bar once a choice reached the agent. */
    static final String CHOICE_SENT = "Autosketch: answer sent to the agent";

    static void attach() {
        UiClient.onAction(ACTION, ReplyActions::run);
    }

    static void run(String text) {
        if (!LinkState.connected()) return;
        int space = text.indexOf(' ');
        String kind = space < 0 ? text.strip() : text.substring(0, space);
        JsonObject args;
        try {
            JsonElement e = space < 0 ? new JsonObject() : JsonParser.parseString(text.substring(space + 1));
            if (!e.isJsonObject()) throw new IllegalArgumentException("args aren't an object");
            args = e.getAsJsonObject();
        } catch (RuntimeException ex) {
            LOG.warn("Autosketch: ignoring a reply-line action with bad arguments: {}", ex.toString());
            return;
        }
        if (kind.isEmpty()) return;
        Minecraft mc = Minecraft.getInstance();
        if (kind.equals("candidates.open") && args.has("id") && args.get("id").isJsonPrimitive()) {
            mc.setScreen(new CandidatesScreen(null, args.get("id").getAsString()));
            return;
        }
        boolean choice = kind.equals(CHOICE);
        Requests.send(kind, args, r -> {
            if (mc.player == null) return;
            if (!r.ok()) mc.player.displayClientMessage(Component.literal("Autosketch: " + r.message()), true);
            else if (choice) mc.player.displayClientMessage(Component.literal(CHOICE_SENT), true);
        });
    }
}
