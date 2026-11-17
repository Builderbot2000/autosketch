package dev.autosketch.mod.gametest.client.screen;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.autosketch.mod.client.ui.AutosketchKeys;
import dev.autosketch.mod.client.ui.UiToggles;
import dev.autosketch.mod.client.ui.screen.LibraryScreen;
import dev.autosketch.mod.client.ui.screen.LogListScreen;
import dev.autosketch.mod.client.ui.screen.MenuScreen;
import dev.autosketch.mod.client.ui.screen.SettingsScreen;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import java.util.function.BooleanSupplier;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.gui.screens.Screen;
import org.lwjgl.glfw.GLFW;

/**
 * The Autosketch menu and its keys (16, *Autosketch menu and key bindings*; briefs/ui/S): {@code Home}
 * opens the menu, each toggle flips its {@link UiToggles} field, each button opens its screen (Ghost
 * here sends {@code ghost.anchor}), the unbound open keys open their screens once bound, and nothing
 * opens while the MCP is offline.
 */
public final class MenuClientTests {
    private MenuClientTests() {}

    private static void openMenu(ClientTestSuite s) {
        s.waitUntil("connected", Ui.connected(), 400);
        s.step("close any screen, press Home", () -> {
            s.mc().setScreen(null);
            s.click(AutosketchKeys.OPEN_MENU);
        });
        s.waitUntil("the menu is open", () -> Ui.screen(MenuScreen.class) != null, 100);
    }

    private static void toggle(ClientTestSuite s, String name, BooleanSupplier field) {
        boolean[] before = new boolean[1];
        s.step(name + ": click its toggle", () -> {
            before[0] = field.getAsBoolean();
            s.clickWidget(name + ": " + (before[0] ? "on" : "off"));
        });
        s.waitUntil(name + " flipped, and its button says so", () -> {
            check(field.getAsBoolean() == !before[0], name + " is still " + before[0]);
            s.widget(name + ": " + (before[0] ? "off" : "on"));
            return true;
        }, 20);
        s.step(name + ": flip it back", () -> s.clickWidget(name + ": " + (before[0] ? "off" : "on")));
        s.waitUntil(name + " is back", () -> field.getAsBoolean() == before[0], 20);
    }

    @ClientTest("screen")
    public static void homeOpensTheMenuAndEachToggleFlips(ClientTestSuite s) {
        openMenu(s);
        toggle(s, "HUD", () -> UiToggles.hud);
        toggle(s, "Job volumes", () -> UiToggles.volumes);
        toggle(s, "Change flashes", () -> UiToggles.flashes);
        toggle(s, "Ghosts", () -> UiToggles.ghosts);
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    private static void button(ClientTestSuite s, String label, Class<? extends Screen> opens) {
        openMenu(s);
        s.step("click " + label, () -> s.clickWidget(label));
        s.waitUntil(label + " opens " + opens.getSimpleName(), () -> Ui.screen(opens) != null, 100);
    }

    @ClientTest("screen")
    public static void menuButtonsOpenTheirScreens(ClientTestSuite s) {
        button(s, "Settings", SettingsScreen.class);
        s.step("Esc on the settings screen", () -> Ui.screen(SettingsScreen.class).onClose());
        s.waitUntil("back on the menu", () -> Ui.screen(MenuScreen.class) != null, 20);
        button(s, "Library", LibraryScreen.class);
        button(s, "Replay", LogListScreen.class);
        s.waitUntil("the log list shows the MCP's logs in its order", () -> {
            var logs = Ui.screen(LogListScreen.class).logs();
            check(logs != null && logs.size() == 2, "logs " + logs);
            check(logs.get(0).get("id").getAsString().equals("log-2"), "first log " + logs.get(0));
            return true;
        }, 100);
        int[] before = new int[1];
        s.step("Open the live log", () -> {
            before[0] = Ui.requests(s, "replay.open").size();
            s.clickWidget("Open");
        });
        s.waitUntil("the replay client asks for it (through /autosketch replay live)", () -> {
            check(Ui.requests(s, "replay.open").size() > before[0], "no replay.open yet");
            check(s.mc().screen == null, "the list should close");
            return true;
        }, 200);
        s.step("close any replay", () -> s.command("autosketch replay close"));
        openMenu(s);
        s.step("click Ghost here", () -> {
            before[0] = Ui.requests(s, "ghost.anchor").size();
            s.clickWidget("Ghost here");
        });
        s.waitUntil("ghost.anchor is sent with the player's dimension and position", () -> {
            check(Ui.requests(s, "ghost.anchor").size() > before[0], "no ghost.anchor yet");
            JsonObject a = Ui.lastArgs(s, "ghost.anchor");
            check(a.get("dimension").getAsString().equals(s.player().level().dimension().location().toString()), "args " + a);
            var p = a.getAsJsonArray("pos");
            var bp = s.player().blockPosition();
            check(p.get(0).getAsInt() == bp.getX() && p.get(1).getAsInt() == bp.getY() && p.get(2).getAsInt() == bp.getZ(), "pos " + p + ", player at " + bp);
            check(s.mc().screen == null, "the menu should close");
            return true;
        }, 100);
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    @ClientTest("screen")
    public static void modConfigOpensTheClothConfigScreen(ClientTestSuite s) {
        openMenu(s);
        s.step("click Mod config", () -> s.clickWidget("Mod config"));
        s.waitUntil("the mod's config screen opens", () -> {
            Screen sc = s.mc().screen;
            check(sc != null && !(sc instanceof MenuScreen), "screen " + sc);
            return true;
        }, 100);
        s.step("back, and the mod list's config entry", () -> {
            s.mc().setScreen(null);
            var container = net.neoforged.fml.ModList.get().getModContainerById("autosketch").orElseThrow();
            var factory = container.getCustomExtension(net.neoforged.neoforge.client.gui.IConfigScreenFactory.class).orElseThrow();
            s.mc().setScreen(factory.createScreen(container, null));
        });
        s.waitUntil("its screen opens too", () -> {
            Screen sc = s.mc().screen;
            check(sc != null && !(sc instanceof MenuScreen), "screen " + sc);
            return true;
        }, 100);
        s.cleanup("close", () -> s.mc().setScreen(null));
    }

    private static void bound(ClientTestSuite s, KeyMapping key, int glfw, Class<? extends Screen> opens) {
        s.waitUntil("connected", Ui.connected(), 400);
        s.step("bind " + key.getName() + " and press it", () -> {
            s.mc().setScreen(null);
            key.setKey(InputConstants.Type.KEYSYM.getOrCreate(glfw));
            KeyMapping.resetMapping();
            s.click(key);
        });
        s.waitUntil(key.getName() + " opens " + opens.getSimpleName(), () -> Ui.screen(opens) != null, 100);
        s.cleanup("unbind " + key.getName(), () -> {
            key.setKey(InputConstants.UNKNOWN);
            KeyMapping.resetMapping();
            s.mc().setScreen(null);
        });
    }

    @ClientTest("screen")
    public static void openKeysOpenTheirScreensOnceBound(ClientTestSuite s) {
        bound(s, AutosketchKeys.OPEN_SETTINGS, GLFW.GLFW_KEY_F6, SettingsScreen.class);
        bound(s, AutosketchKeys.OPEN_LIBRARY, GLFW.GLFW_KEY_F7, LibraryScreen.class);
        bound(s, AutosketchKeys.OPEN_REPLAY, GLFW.GLFW_KEY_F8, LogListScreen.class);
    }

    @ClientTest("screen")
    public static void offlineTheMenuClosesAndDoesntOpen(ClientTestSuite s) {
        openMenu(s);
        s.step("the MCP goes away", s::stopMcp);
        s.waitUntil("the open menu closes", () -> s.mc().screen == null, 200);
        s.step("press Home offline", () -> s.click(AutosketchKeys.OPEN_MENU));
        s.waitFrames("a few frames", 5);
        s.step("nothing opened", () -> check(s.mc().screen == null, "screen " + s.mc().screen));
        s.cleanup("the MCP comes back", () -> s.startMcp(Ui.script()));
        s.waitUntil("connected again", Ui.connected(), 400);
    }
}
