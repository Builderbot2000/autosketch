package dev.autosketch.mod.gametest.client.basics;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import java.io.File;
import java.nio.charset.StandardCharsets;
import net.minecraft.client.gui.screens.ChatScreen;

/**
 * The one test with true OS input (16, *Testing*, *Input*): {@code xdotool} focuses the game's window
 * on the (virtual) X display and types the chat key, which must reach the game through GLFW like a
 * real keyboard. Skipped with a warning when {@code xdotool} isn't installed.
 */
public final class OsInputClientTests {
    private OsInputClientTests() {}

    static boolean xdotoolInstalled() {
        String path = System.getenv("PATH");
        if (path == null) return false;
        for (String dir : path.split(File.pathSeparator))
            if (new File(dir, "xdotool").canExecute()) return true;
        return false;
    }

    @ClientTest("basics")
    public static void xdotoolKeyOpensChat(ClientTestSuite s) {
        if (!xdotoolInstalled()) {
            s.step("skipped: xdotool is not installed (apt install xdotool)", () -> s.warn("xdotoolKeyOpensChat skipped: xdotool is not installed"));
            return;
        }
        Process[] xdotool = new Process[1];
        s.step("no screen open, xdotool presses T in the game's window", () -> {
            check(s.mc().screen == null, "a screen is open: " + s.mc().screen);
            // The window GLFW created for this process (GLFW sets _NET_WM_PID). Focus it, then type
            // through XTEST, so the key arrives as real input (not a synthetic XSendEvent).
            String pid = Long.toString(ProcessHandle.current().pid());
            Process search = new ProcessBuilder("xdotool", "search", "--pid", pid).redirectErrorStream(true).start();
            String ids = new String(search.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
            check(search.waitFor() == 0 && !ids.isEmpty(), "xdotool found no window of pid " + pid + ": " + ids);
            String window = ids.lines().reduce((a, b) -> b).orElseThrow();
            xdotool[0] = new ProcessBuilder("xdotool", "windowfocus", window, "key", "--clearmodifiers", "t").redirectErrorStream(true).start();
        });
        s.waitUntil("the chat screen opens", () -> {
            Process p = xdotool[0];
            if (!p.isAlive() && p.exitValue() != 0)
                throw new ClientTestSuite.Failure("xdotool exited " + p.exitValue() + ": " + new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim());
            check(s.mc().screen instanceof ChatScreen, "screen: " + s.mc().screen);
            return true;
        }, 200);
        s.cleanup("close the chat screen", () -> {
            if (xdotool[0] != null) xdotool[0].destroy();
            s.mc().setScreen(null);
        });
    }
}
