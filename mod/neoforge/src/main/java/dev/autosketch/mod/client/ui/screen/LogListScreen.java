package dev.autosketch.mod.client.ui.screen;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;

/**
 * The replay log list behind the menu's Replay button (16, *Replay in the world*, *Open*): the
 * workspace's session logs from {@code logs.list}, in the order the MCP sends them (newest first),
 * each with an Open button. Opening hands the log's id to {@link #setOpener the opener} the replay
 * feature installs (silo R: replay mode, frames, controls), and closes the screen; until one is
 * installed it sends {@code replay.open} itself.
 */
public final class LogListScreen extends PaneScreen {
    private static Consumer<String> opener = id -> Requests.send("replay.open", Requests.args("log", id), r -> {});

    /** Replaces what Open does with a log id (silo R). */
    public static void setOpener(Consumer<String> open) {
        opener = open;
    }

    private @Nullable List<JsonObject> logs;
    private @Nullable Component message;

    public LogListScreen(@Nullable Screen parent) {
        super(tr("logs.title"), parent);
        Requests.send("logs.list", new JsonObject(), r -> {
            if (r.ok()) {
                List<JsonObject> out = new ArrayList<>();
                for (JsonElement e : r.result().getAsJsonArray("logs")) out.add(e.getAsJsonObject());
                logs = out;
            } else message = Component.literal(r.message());
            refresh();
        });
    }

    /** The logs as listed (for tests); null until the result arrived. */
    public @Nullable List<JsonObject> logs() {
        return logs;
    }

    @Override
    protected void layout() {
        Pane p = pane("logs", 12, 30, width - 24, height - 62);
        if (message != null) wrap(p, 0, 0, message, BAD);
        else if (logs == null) text(p, 0, 0, tr("loading"), DIM);
        else if (logs.isEmpty()) text(p, 0, 0, tr("logs.none"), DIM);
        else {
            int y = 0;
            for (JsonObject l : logs) {
                String id = str(l, "id");
                boolean live = l.has("live") && l.get("live").getAsBoolean();
                put(p, Button.builder(tr("logs.open"), b -> {
                    minecraft.setScreen(null);
                    opener.accept(id);
                }).size(50, 20).build(), 0, y);
                text(p, 56, y + 1, Component.literal(str(l, "doc")).append(live ? Component.literal(" ").append(tr("logs.live")) : Component.empty()), live ? GOOD : TEXT);
                text(p, 56, y + 11, Component.literal(str(l, "modified") + "  " + str(l, "session")), DIM);
                y += 24;
            }
        }
        addRenderableWidget(Button.builder(tr("done"), b -> onClose()).bounds(width / 2 - 50, height - 26, 100, 20).build());
    }

    static String str(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? "" : e.isJsonPrimitive() ? e.getAsString() : e.toString();
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        super.render(g, mouseX, mouseY, partialTick);
        g.drawCenteredString(font, title, width / 2, 12, TEXT);
    }
}
