package dev.autosketch.mod.gametest.client.screen;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.google.gson.JsonObject;
import dev.autosketch.mod.client.ui.screen.SettingsScreen;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import java.util.List;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.EditBox;

/**
 * The settings screen (16, *Settings screen*; briefs/ui/S): one control per row of the fake MCP's
 * {@code settings.list} (select, toggle, number, list, text: {@code clienttest/screen.json}), saving
 * sends {@code settings.set} with the hash it read and reloads, and a {@code conflict} (the script
 * answers {@code settings.unset} with one) reloads the rows and says so on the row.
 */
public final class SettingsClientTests {
    private SettingsClientTests() {}

    private static SettingsScreen screen() {
        return Ui.screen(SettingsScreen.class);
    }

    private static void open(ClientTestSuite s) {
        s.waitUntil("connected", Ui.connected(), 400);
        s.step("open the settings screen", () -> s.mc().setScreen(new SettingsScreen(null)));
        s.waitUntil("the rows arrived", () -> {
            check(screen().controls().size() == 5, "controls " + screen().controls().keySet());
            return true;
        }, 200);
    }

    @ClientTest("screen")
    public static void oneWidgetPerRow(ClientTestSuite s) {
        open(s);
        s.step("each row has the control its row names, in row order", () -> {
            var c = screen().controls();
            check(List.copyOf(c.keySet()).equals(List.of("observe.snapshots", "observe.deltas", "scope.maxDepth", "library.roots", "assets.instance")), "order " + c.keySet());
            check(c.get("observe.snapshots") instanceof Button b && b.getMessage().getString().equals("merge"), "select " + c.get("observe.snapshots").getMessage().getString());
            check(c.get("observe.deltas") instanceof Button b && b.getMessage().getString().equals("on"), "toggle " + c.get("observe.deltas").getMessage().getString());
            check(c.get("scope.maxDepth") instanceof EditBox e && e.getValue().equals("2"), "number field");
            check(c.get("library.roots") instanceof EditBox e && e.getValue().equals("~/autosketch/library"), "list editor's first item");
            check(c.get("assets.instance") instanceof EditBox e && e.getValue().isEmpty(), "text field");
            check(screen().hash().equals("hash-1"), "hash " + screen().hash());
        });
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    @ClientTest("screen")
    public static void savingSendsTheHashAndReloads(ClientTestSuite s) {
        open(s);
        int[] before = new int[2];
        s.step("click the toggle (observe.deltas is on)", () -> {
            before[0] = Ui.requests(s, "settings.set").size();
            before[1] = screen().loads();
            Ui.click(screen().controls().get("observe.deltas"));
        });
        s.waitUntil("settings.set sent with the value and the hash read", () -> {
            check(Ui.requests(s, "settings.set").size() > before[0], "no settings.set yet");
            JsonObject a = Ui.lastArgs(s, "settings.set");
            check(a.get("key").getAsString().equals("observe.deltas") && a.get("value").getAsString().equals("false") && a.get("hash").getAsString().equals("hash-1"), "args " + a);
            return true;
        }, 100);
        s.waitUntil("the rows reloaded and the row says it saved", () -> {
            check(screen().loads() > before[1], "loads " + screen().loads());
            var m = screen().message("observe.deltas");
            check(m != null && m.getString().equals("saved to config.toml"), "message " + m);
            return true;
        }, 100);
        s.waitUntil("the number field is in view", Ui.reveal(() -> screen().controls().get("scope.maxDepth"), 40, 100), 100);
        s.step("type 3 into the number field and click its Save", () -> {
            before[0] = Ui.requests(s, "settings.set").size();
            AbstractWidget box = screen().controls().get("scope.maxDepth");
            ((EditBox) box).setValue("3");
            Ui.click(Ui.onRow(box, "Save"));
        });
        s.waitUntil("settings.set sends the typed text", () -> {
            check(Ui.requests(s, "settings.set").size() > before[0], "no settings.set yet");
            JsonObject a = Ui.lastArgs(s, "settings.set");
            check(a.get("key").getAsString().equals("scope.maxDepth") && a.get("value").getAsString().equals("3"), "args " + a);
            return true;
        }, 100);
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    @ClientTest("screen")
    public static void aConflictReloadsAndSaysSo(ClientTestSuite s) {
        open(s);
        int[] before = new int[2];
        s.waitUntil("the number row is in view", Ui.reveal(() -> screen().controls().get("scope.maxDepth"), 40, 100), 100);
        s.step("Reset scope.maxDepth (the fake MCP answers conflict)", () -> {
            before[0] = Ui.requests(s, "settings.unset").size();
            before[1] = screen().loads();
            Ui.click(Ui.onRow(screen().controls().get("scope.maxDepth"), "Reset"));
        });
        s.waitUntil("settings.unset sent with the hash", () -> {
            check(Ui.requests(s, "settings.unset").size() > before[0], "no settings.unset yet");
            JsonObject a = Ui.lastArgs(s, "settings.unset");
            check(a.get("key").getAsString().equals("scope.maxDepth") && a.get("hash").getAsString().equals("hash-1"), "args " + a);
            return true;
        }, 100);
        s.waitUntil("the rows reloaded and the row tells the player", () -> {
            check(screen().loads() > before[1], "loads " + screen().loads());
            var m = screen().message("scope.maxDepth");
            check(m != null && m.getString().contains("changed elsewhere"), "message " + m);
            return true;
        }, 100);
        s.cleanup("close", () -> s.mc().setScreen(null));
    }
}
