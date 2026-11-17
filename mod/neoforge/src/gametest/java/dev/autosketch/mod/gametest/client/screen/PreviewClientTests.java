package dev.autosketch.mod.gametest.client.screen;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.mojang.blaze3d.platform.NativeImage;
import dev.autosketch.mod.client.ui.screen.LibraryScreen;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;

/**
 * The library's 3D preview (16, *Library screen*; briefs/ui/S deliverable 4): selecting a prefab asks
 * for {@code library.preview}, meshes the voxels it was sent with the ghosts' block drawing and draws
 * them in the detail pane; dragging turns the orbit camera. The fake MCP's preview
 * ({@code clienttest/screen.json}) is a synthetic 4×3×4 prefab: a gold floor, a stone ring on it and
 * one emerald block above the ring's hole, which shows 78 faces (floor 16 below, 4 on top inside the
 * ring, 16 around; ring 12 on top, 16 outside, 8 inside; the emerald all 6).
 */
public final class PreviewClientTests {
    private PreviewClientTests() {}

    private static LibraryScreen screen() {
        return Ui.screen(LibraryScreen.class);
    }

    @ClientTest("screen")
    public static void previewDrawsTheVoxelsItWasSent(ClientTestSuite s) {
        NativeImage[] shots = new NativeImage[2];
        int[] draws = new int[1];
        s.waitUntil("connected", Ui.connected(), 400);
        s.step("open the library", () -> s.mc().setScreen(new LibraryScreen(null)));
        s.waitUntil("the list arrived", () -> !screen().shown().isEmpty(), 200);
        s.step("screenshot before selecting", () -> shots[0] = s.screenshot("preview-none"));
        s.step("select tower", () -> s.clickWidget("tower"));
        s.waitUntil("library.preview sent for it", () -> {
            check(!Ui.requests(s, "library.preview").isEmpty(), "no library.preview");
            var a = Ui.lastArgs(s, "library.preview");
            check(a.get("root").getAsString().equals("user") && a.get("name").getAsString().equals("tower"), "args " + a);
            return true;
        }, 100);
        s.waitUntil("the voxels are meshed: 78 faces", () -> {
            check(screen().previewQuads() == 78, "quads " + screen().previewQuads());
            return true;
        }, 200);
        s.waitUntil("and drawn", () -> draws[0] = screen().previewDraws(), () -> screen().previewDraws() > draws[0] + 2, 200);
        s.step("the preview square has the blocks' colours", () -> {
            shots[1] = s.screenshot("preview");
            int[] c = screen().previewCentre();
            check(c != null, "no preview square");
            double k = s.mc().getWindow().getGuiScale();
            int cx = (int) (c[0] * k), cy = (int) (c[1] * k), r = (int) (20 * k), gold = 0, green = 0, grey = 0;
            for (int y = Math.max(0, cy - r); y < Math.min(shots[1].getHeight(), cy + r); y++)
                for (int x = Math.max(0, cx - r); x < Math.min(shots[1].getWidth(), cx + r); x++) {
                    int p = shots[1].getPixelRGBA(x, y); // ABGR
                    int red = p & 0xff, gr = (p >> 8) & 0xff, b = (p >> 16) & 0xff;
                    if (red > 120 && gr > 80 && b < gr - 30) gold++;
                    else if (gr > red + 40 && gr > b) green++;
                    else if (Math.abs(red - gr) < 12 && Math.abs(gr - b) < 12 && red > 70) grey++;
                }
            check(gold > 50 && green > 10 && grey > 50, "gold " + gold + ", emerald " + green + ", stone " + grey);
            check(ClientTestSuite.changedPixels(shots[0], shots[1], 24) > 1000, "the screen hardly changed");
        });
        float[] before = new float[2];
        s.step("drag across the preview", () -> {
            before[0] = screen().previewAngles()[0];
            before[1] = screen().previewAngles()[1];
            int[] c = screen().previewCentre();
            screen().mouseClicked(c[0], c[1], 0);
            screen().mouseDragged(c[0] + 20, c[1] + 10, 0, 20, 10);
            screen().mouseReleased(c[0] + 20, c[1] + 10, 0);
        });
        s.step("the camera turned and tilted", () -> {
            float[] a = screen().previewAngles();
            check(a[0] != before[0] && a[1] != before[1], "angles " + a[0] + ", " + a[1]);
        });
        s.step("select another prefab: the old meshes go", () -> s.clickWidget("hut"));
        s.waitUntil("the new preview replaced the old", () -> Ui.requests(s, "library.preview").size() >= 2 && screen().previewQuads() == 78, 200);
        s.cleanup("close", () -> {
            for (NativeImage i : shots) if (i != null) i.close();
            s.mc().setScreen(null);
        });
    }
}
