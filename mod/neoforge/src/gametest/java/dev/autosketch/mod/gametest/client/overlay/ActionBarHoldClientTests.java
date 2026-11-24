package dev.autosketch.mod.gametest.client.overlay;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.client.ui.AutosketchKeys;
import dev.autosketch.mod.client.ui.UiToggles;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import dev.autosketch.mod.volume.Wand;
import net.minecraft.network.chat.Component;
import org.lwjgl.glfw.GLFW;

/**
 * The client half's own action-bar lines outlast the wand's mode line (18, C5; client
 * {@code ActionBarHold}): with the wand in hand the server re-sends {@code Autosketch wand: work mode}
 * every second, and a line the client wrote (here the flashes key's) must still be on screen after
 * more than a second, the mode line coming back once its time is up.
 */
public final class ActionBarHoldClientTests {
    private ActionBarHoldClientTests() {}

    static final String MODE_LINE = "Autosketch wand: work mode";
    static final String CLIENT_LINE = "Autosketch: change flashes off";

    @ClientTest("overlay")
    public static void aClientLineStaysUpWhileTheWandIsHeld(ClientTestSuite s) {
        OverlayScript.connect(s, OverlayScript.shared());
        s.step("wand in the main hand, work mode", () -> {
            // By slot, as the air-mode setup does: the server learns of the new slot a tick after the command.
            s.player().getInventory().selected = 0;
            s.command("item replace entity @s hotbar.0 with minecraft:blaze_rod");
            s.command("autosketch mode work");
        });
        s.waitUntil("the server sees the wand in hand", () -> s.onServer(server -> Wand.isWand(s.serverPlayer(server).getMainHandItem())), 100);
        // The mode command's own line holds the server's repeat back for 60 ticks; wait that out, so the
        // repeated mode line is what's on the action bar and nothing on the server holds it back.
        s.waitUntil("the server's notice hold is over", () -> s.onServer(server -> {
            var p = s.serverPlayer(server);
            return p.serverLevel().getGameTime() > AutosketchMod.internals().players().get(p.getUUID()).actionBarBusyUntil + 20;
        }), 200);
        s.waitUntil("the wand's mode line is on the action bar", () -> overlay(s).equals(MODE_LINE), 100);
        s.step("flashes key", () -> {
            OverlayScript.bind(AutosketchKeys.TOGGLE_FLASHES, GLFW.GLFW_KEY_KP_2);
            check(UiToggles.flashes, "flashes start on");
            s.click(AutosketchKeys.TOGGLE_FLASHES);
        });
        s.waitUntil("the client's line is on the action bar", () -> overlay(s).equals(CLIENT_LINE), 20);
        // 40 ticks (2 s): two of the server's mode-line periods, within the action bar's 60-tick life.
        int[] ticks = new int[1];
        String[] other = new String[1];
        s.waitUntil("the client's line stays for 2 s", () -> {
            String now = overlay(s);
            if (!now.equals(CLIENT_LINE) && other[0] == null) other[0] = now;
            return ++ticks[0] >= 40;
        }, 60);
        s.step("nothing replaced it", () -> check(other[0] == null, "the action bar showed \"" + other[0] + "\" within 2 s"));
        s.waitUntil("the mode line returns after the hold", () -> overlay(s).equals(MODE_LINE), 100);
        s.cleanup("unbind, flashes on, wand away", () -> {
            OverlayScript.unbind(AutosketchKeys.TOGGLE_FLASHES);
            UiToggles.flashes = true;
            s.player().getInventory().selected = 8;
        });
    }

    /** The action bar's text now (the client's own lines and the server's alike). Dev runtime names are Mojang's. */
    static String overlay(ClientTestSuite s) throws ReflectiveOperationException {
        java.lang.reflect.Field f = net.minecraft.client.gui.Gui.class.getDeclaredField("overlayMessageString");
        f.setAccessible(true);
        Object c = f.get(s.mc().gui);
        return c == null ? "" : ((Component) c).getString();
    }
}
