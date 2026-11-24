package dev.autosketch.mod.gametest.client.overlay;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.mojang.blaze3d.platform.NativeImage;
import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.client.ui.overlay.DrawList;
import dev.autosketch.mod.client.ui.overlay.OverlayClient;
import dev.autosketch.mod.feedback.Feedback;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.volume.Wand;
import java.util.List;
import net.minecraft.client.CloudStatus;
import net.minecraft.world.phys.Vec3;

/**
 * The player's own work and context volumes on the overlay (18, piece 8, *Testing*, client suite;
 * briefs/select/C, C3): with the client half and the link {@code connected}, the server half sends
 * them as relay op {@code 4} and the overlay draws them, with no dust particles sent; they stay drawn
 * from far off and go when {@code /autosketch show} is turned off. The vanilla-client fallback (the
 * particles) is the server GameTest {@code FeedbackGameTests}.
 */
public final class VolumeOverlayClientTests {
    private VolumeOverlayClientTests() {}

    static final Box WORK = new Box(0, -60, 0, 15, -53, 15), CONTEXT = WORK.grow(3);
    static final int WORK_COLOUR = 0x33e05a, CONTEXT_COLOUR = 0x3a8dff;

    static List<DrawList.Volume> volumes() {
        return OverlayClient.drawList().volumes();
    }

    static boolean drawn(Box b, int colour) {
        return volumes().stream().anyMatch(v -> v.box().equals(b) && v.colour() == colour);
    }

    /**
     * Steps: selects a hotbar slot that doesn't hold the wand and waits until the server sees it, so
     * neither the wand's outlines nor its mode line on the action bar get in a test's way. Returns
     * the slot that was selected before, for the cleanup.
     */
    public static int[] awayFromTheWand(ClientTestSuite s) {
        int[] before = {-1};
        s.step("a hotbar slot without the wand", () -> {
            before[0] = s.player().getInventory().selected;
            for (int i = 8; i >= 0; i--)
                if (!Wand.isWand(s.player().getInventory().getItem(i))) {
                    s.player().getInventory().selected = i;
                    return;
                }
            s.command("item replace entity @s hotbar.8 with minecraft:air");
            s.player().getInventory().selected = 8;
        });
        s.waitUntil("the server sees no wand in hand", () -> s.onServer(server -> !Wand.isWand(s.serverPlayer(server).getMainHandItem())), 100);
        return before;
    }

    static int particles(ClientTestSuite s) throws Exception {
        return s.onServer(server -> AutosketchMod.internals().feedback().particlesSent(s.player().getUUID()));
    }

    @ClientTest("overlay")
    public static void volumesDrawnWithoutParticles(ClientTestSuite s) {
        Vec3[] start = {null};
        int[] particles = {0};
        long[] shownAt = {0};
        NativeImage[] shots = new NativeImage[2];
        OverlayScript.connect(s, OverlayScript.shared());
        int[] slot = awayFromTheWand(s);
        s.step("work 16x8x16 at the origin, context by default, outlines shown", () -> {
            start[0] = s.player().position();
            check(volumes().isEmpty(), "volumes before " + volumes());
            s.command("autosketch mode work");
            s.command("autosketch pos1 0 -60 0");
            s.command("autosketch pos2 15 -53 15");
            s.command("autosketch show");
            particles[0] = particles(s);
            shownAt[0] = s.mc().level.getGameTime();
        });
        // The work mode outlines the marked corners' box too (WandMode.outline), here the work volume again.
        s.waitUntil("the overlay draws work in green and the context in blue, nothing else", () -> {
            check(drawn(WORK, WORK_COLOUR) && drawn(CONTEXT, CONTEXT_COLOUR) && volumes().stream().map(v -> v.box()).distinct().count() == 2, "volumes " + volumes());
            return true;
        }, 200);
        s.waitUntil("no particles after two outline periods", () -> {
            if (s.mc().level.getGameTime() - shownAt[0] < 2 * Feedback.OUTLINE_PERIOD + 2) return false;
            check(particles(s) == particles[0], "particles sent: " + (particles(s) - particles[0]));
            return true;
        }, 200);
        CandidateOverlayClientTests.tp(s, 8.5, 120.5, 180f);
        s.step("hide the GUI and clouds", () -> {
            s.hideGui(true);
            s.mc().options.cloudStatus().set(CloudStatus.OFF);
        });
        s.waitUntil("still drawn from 105 blocks off", () -> drawn(WORK, WORK_COLOUR) && drawn(CONTEXT, CONTEXT_COLOUR), 100);
        s.waitFrames("frames with the volumes", 5);
        s.step("screenshot with the volumes; show off", () -> {
            shots[0] = s.screenshot("volumes-on");
            s.command("autosketch show");
        });
        s.waitUntil("show off: nothing drawn", () -> volumes().isEmpty(), 100);
        s.waitFrames("frames without", 5);
        s.step("screenshot without", () -> shots[1] = s.screenshot("volumes-off"));
        s.step("green and blue line pixels only with the volumes", () -> {
            NativeImage on = shots[0], off = shots[1];
            int lines = 0;
            for (int y = 0; y < on.getHeight(); y++)
                for (int x = 0; x < on.getWidth(); x++) {
                    int p = on.getPixelRGBA(x, y); // ABGR
                    if (p == off.getPixelRGBA(x, y)) continue;
                    int r = p & 0xFF, g = (p >> 8) & 0xFF, b = (p >> 16) & 0xFF;
                    if ((g - r > 40 && g - b > 20) || (b - r > 60 && b - g > 20)) lines++;
                }
            check(lines >= 100, "line pixels: " + lines + " (changed pixels: " + ClientTestSuite.changedPixels(on, off, 8) + ")");
        });
        s.cleanup("outlines off, volumes cleared, the player and the slot back", () -> {
            for (NativeImage i : shots)
                if (i != null) i.close();
            s.onServer(server -> {
                AutosketchMod.internals().players().get(s.player().getUUID()).show = false;
                return null;
            });
            s.command("autosketch clear");
            s.hideGui(false);
            s.mc().options.cloudStatus().set(CloudStatus.FANCY);
            if (slot[0] >= 0) s.player().getInventory().selected = slot[0];
            if (start[0] != null) s.command("tp @s " + start[0].x + " " + start[0].y + " " + start[0].z);
        });
    }
}
