package dev.autosketch.mod.gametest.client.screen;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.google.gson.JsonObject;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.gui.screens.Screen;

/** Helpers shared by the screen suite's tests. */
final class Ui {
    private Ui() {}

    /** Clicks a widget of the open screen at its centre, through the screen's mouse handling. */
    static void click(AbstractWidget w) {
        Screen screen = Minecraft.getInstance().screen;
        check(screen != null, "no screen open");
        check(w.visible && w.active, "widget \"" + w.getMessage().getString() + "\" isn't clickable");
        double x = w.getX() + w.getWidth() / 2.0, y = w.getY() + w.getHeight() / 2.0;
        screen.mouseClicked(x, y, 0);
        if (Minecraft.getInstance().screen != null) Minecraft.getInstance().screen.mouseReleased(x, y, 0);
    }

    /** The open screen's widget labelled {@code label} on the same row as {@code near} (within 4 px), to its right. */
    static AbstractWidget onRow(AbstractWidget near, String label) {
        Screen screen = Minecraft.getInstance().screen;
        check(screen != null, "no screen open");
        for (GuiEventListener l : screen.children())
            if (l instanceof AbstractWidget w && w.getMessage().getString().equals(label) && Math.abs(w.getY() - near.getY()) <= 4 && w.getX() > near.getX()) return w;
        throw new ClientTestSuite.Failure("no \"" + label + "\" on the row of \"" + near.getMessage().getString() + "\"");
    }

    /** The screen if it is a {@code type}, else a failed check. */
    static <T extends Screen> T screen(Class<T> type) {
        Screen s = Minecraft.getInstance().screen;
        check(type.isInstance(s), "screen is " + (s == null ? "none" : s.getClass().getSimpleName()) + ", want " + type.getSimpleName());
        return type.cast(s);
    }

    /** The {@code ui.request}s of a kind the fake MCP received, oldest first. */
    static List<JsonObject> requests(ClientTestSuite s, String kind) {
        return s.mcp().received("ui.request").stream().filter(r -> r.get("kind").getAsString().equals(kind)).toList();
    }

    /** Waits until one more {@code ui.request} of {@code kind} than {@code before} arrived, and returns its args. */
    static JsonObject lastArgs(ClientTestSuite s, String kind) {
        List<JsonObject> rs = requests(s, kind);
        check(!rs.isEmpty(), "no " + kind + " request yet");
        return rs.get(rs.size() - 1).getAsJsonObject("args");
    }

    static ClientTestSuite.Condition connected() {
        return () -> {
            check(LinkState.connected(), "link state " + LinkState.get());
            return true;
        };
    }

    /** The suite's own fake MCP script, to restart it. */
    static String script() {
        try (InputStream in = Ui.class.getResourceAsStream("/clienttest/screen.json")) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * A wait condition: true once the widget {@code get} returns is visible, scrolling the pane at
     * {@code (x, y)} down a notch each tick until it is (screens rebuild on scroll, so {@code get}
     * looks the widget up again).
     */
    static ClientTestSuite.Condition reveal(java.util.function.Supplier<AbstractWidget> get, int x, int y) {
        return () -> {
            AbstractWidget w = get.get();
            check(w != null, "no such widget yet");
            if (w.visible) return true;
            Minecraft.getInstance().screen.mouseScrolled(x, y, 0, w.getY() < y ? 1 : -1);
            check(false, "widget at y " + w.getY() + " is scrolled out of view");
            return false;
        };
    }
}
