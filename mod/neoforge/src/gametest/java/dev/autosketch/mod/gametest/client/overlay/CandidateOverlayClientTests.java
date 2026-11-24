package dev.autosketch.mod.gametest.client.overlay;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;
import static dev.autosketch.mod.gametest.client.overlay.OverlayScript.CANDIDATE_ALPHA;
import static dev.autosketch.mod.gametest.client.overlay.OverlayScript.CANDIDATE_COLOUR;
import static dev.autosketch.mod.gametest.client.overlay.OverlayScript.EDGES_A;
import static dev.autosketch.mod.gametest.client.overlay.OverlayScript.EDGES_B;
import static dev.autosketch.mod.gametest.client.overlay.OverlayScript.FACES_A;
import static dev.autosketch.mod.gametest.client.overlay.OverlayScript.FACES_B;

import com.mojang.blaze3d.platform.NativeImage;
import dev.autosketch.mod.client.ui.UiToggles;
import dev.autosketch.mod.client.ui.overlay.DrawList;
import dev.autosketch.mod.client.ui.overlay.OverlayClient;
import dev.autosketch.mod.client.ui.overlay.OverlayState;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import dev.autosketch.mod.protocol.Box;
import java.util.Arrays;
import java.util.List;
import net.minecraft.Util;
import net.minecraft.client.CloudStatus;
import net.minecraft.world.phys.Vec3;

/**
 * The select candidate in the world (18, piece 8, *Testing*, client suite; briefs/select/C, C2): the
 * steady fill record drawn as its edges near and its shell far, exactly as sent (a replaced record
 * leaves no faces behind, so the tint never doubles), and proposed hits pulsed for longer than a
 * change flash. Against {@link OverlayScript}'s fill and hit triggers; assertions on the draw list,
 * one pixel check for the shell through the ground.
 */
public final class CandidateOverlayClientTests {
    private CandidateOverlayClientTests() {}

    static List<DrawList.Steady> fills() {
        return OverlayClient.drawList().fills();
    }

    static boolean same(List<int[]> a, int[][] b) {
        return Arrays.deepEquals(a.toArray(), b);
    }

    static void tp(ClientTestSuite s, double x, double z, float yaw) {
        s.step("the player at " + x + ", " + z, () -> s.command("tp @s " + x + " -60 " + z + " " + yaw + " 0"));
        s.waitUntil("the camera moved", () -> {
            Vec3 c = s.mc().gameRenderer.getMainCamera().getPosition();
            return Math.abs(c.x - x) < 0.01 && Math.abs(c.z - z) < 0.01;
        }, 200);
    }

    /** Near: the twelve edges, no faces. Far: the six faces, no edges. A replace by id; a removal; the nether's never drawn. */
    @ClientTest("overlay")
    public static void candidateEdgesNearShellFar(ClientTestSuite s) {
        Vec3[] start = {null};
        OverlayScript.connect(s, OverlayScript.shared());
        s.step("no fill yet; remember where the player stands", () -> {
            check(fills().isEmpty(), "fills " + fills());
            start[0] = s.player().position();
        });
        tp(s, 0.5, 0.5, 0f);
        s.step("the MCP sends the candidate (change seq 2)", () -> OverlayScript.trigger("library.entry"));
        s.waitUntil("near: the candidate's edges in its colour, no faces; the nether's fill held, not drawn", () -> {
            check(OverlayClient.state().seq() == 2 && OverlayClient.state().fills().size() == 2, "held " + OverlayClient.state().fills());
            List<DrawList.Steady> f = fills();
            check(f.size() == 1, "fills " + f);
            DrawList.Steady c = f.get(0);
            check(c.id().equals("candidate") && c.colour() == CANDIDATE_COLOUR && c.alpha() == CANDIDATE_ALPHA && c.near(), "fill " + c);
            check(same(c.edges(), EDGES_A) && c.faces().isEmpty(), "near drawing " + c);
            return true;
        }, 200);
        tp(s, 0.5, 120.5, 180f);
        s.waitUntil("far: the section's six faces, no edges", () -> {
            DrawList.Steady c = fills().get(0);
            check(!c.near() && same(c.faces(), FACES_A) && c.edges().isEmpty(), "far drawing " + c);
            return true;
        }, 100);
        s.step("the MCP replaces it by two sections (change seq 3)", () -> OverlayScript.trigger("library.thumbnail"));
        s.waitUntil("only the new shell: six merged faces, none left from the first", () -> {
            check(OverlayClient.state().seq() == 3, "seq " + OverlayClient.state().seq());
            List<DrawList.Steady> f = fills();
            check(f.size() == 1 && same(f.get(0).faces(), FACES_B), "fills " + f);
            check(f.get(0).faces().stream().noneMatch(x -> x[0] == 16 && x[3] == 16), "a face between the two sections");
            return true;
        }, 200);
        tp(s, 0.5, 0.5, 0f);
        s.waitUntil("near again: the new edges", () -> {
            DrawList.Steady c = fills().get(0);
            check(c.near() && same(c.edges(), EDGES_B) && c.faces().isEmpty(), "near drawing " + c);
            return true;
        }, 100);
        s.step("the volumes toggle hides it", () -> {
            UiToggles.volumes = false;
            check(fills().isEmpty(), "fills " + fills());
            UiToggles.volumes = true;
        });
        s.step("the MCP removes it (change seq 4)", () -> OverlayScript.trigger("library.preview"));
        s.waitUntil("no candidate held or drawn; the nether's kept", () -> {
            check(OverlayClient.state().seq() == 4, "seq " + OverlayClient.state().seq());
            check(fills().isEmpty(), "fills " + fills());
            check(OverlayClient.state().fills().stream().map(x -> x.id()).toList().equals(List.of("elsewhere")), "held " + OverlayClient.state().fills());
            return true;
        }, 200);
        s.step("a full state replaces the fills too", () -> OverlayScript.trigger("resync"));
        s.waitUntil("back on seq 1 with no fills", () -> OverlayClient.state().seq() == 1 && OverlayClient.state().fills().isEmpty(), 200);
        s.cleanup("the player back", () -> {
            UiToggles.volumes = true;
            if (start[0] != null) s.command("tp @s " + start[0].x + " " + start[0].y + " " + start[0].z);
        });
    }

    /** The shell is drawn: frames with the candidate on and off differ by its magenta tint, seen from 104 blocks off. */
    @ClientTest("overlay")
    public static void shellVisibleFromAfar(ClientTestSuite s) {
        NativeImage[] shots = new NativeImage[2];
        Vec3[] start = {null};
        OverlayScript.connect(s, OverlayScript.shared());
        s.step("remember where the player stands; hide the GUI and clouds", () -> {
            start[0] = s.player().position();
            s.hideGui(true);
            s.mc().options.cloudStatus().set(CloudStatus.OFF);
        });
        tp(s, 8.5, 120.5, 180f);
        s.step("the MCP sends the candidate", () -> OverlayScript.trigger("library.entry"));
        s.waitUntil("the shell is the far drawing", () -> fills().size() == 1 && !fills().get(0).near(), 200);
        s.waitFrames("frames with the shell", 5);
        s.step("screenshot with the shell", () -> {
            shots[0] = s.screenshot("candidate-shell-on");
            UiToggles.volumes = false;
        });
        s.waitFrames("frames without", 5);
        s.step("screenshot without", () -> shots[1] = s.screenshot("candidate-shell-off"));
        s.step("magenta-tinted pixels only with the shell", () -> {
            NativeImage on = shots[0], off = shots[1];
            int tinted = 0;
            for (int y = 0; y < on.getHeight(); y++)
                for (int x = 0; x < on.getWidth(); x++) {
                    int p = on.getPixelRGBA(x, y); // ABGR
                    if (p == off.getPixelRGBA(x, y)) continue;
                    int r = p & 0xFF, g = (p >> 8) & 0xFF, b = (p >> 16) & 0xFF;
                    if (r - g > 30 && b - g > 30) tinted++;
                }
            check(tinted >= 200, "tinted pixels: " + tinted + " (changed pixels: " + ClientTestSuite.changedPixels(on, off, 8) + ")");
        });
        s.cleanup("shell off, the player back, screenshots closed", () -> {
            for (NativeImage i : shots)
                if (i != null) i.close();
            UiToggles.volumes = true;
            s.hideGui(false);
            s.mc().options.cloudStatus().set(CloudStatus.FANCY);
            if (start[0] != null) s.command("tp @s " + start[0].x + " " + start[0].y + " " + start[0].z);
        });
    }

    /** Proposed hits (a flash with job {@code candidate}) pulse past a change flash's life, then expire. */
    @ClientTest("overlay")
    public static void proposedHitsPulseLonger(ClientTestSuite s) {
        long[] arrived = {0};
        OverlayScript.connect(s, OverlayScript.shared());
        s.step("the MCP pulses two hits", () -> OverlayScript.trigger("library.rename"));
        s.waitUntil("two pulses with job candidate in its colour", () -> {
            List<DrawList.Pulse> p = OverlayClient.drawList().pulses();
            check(p.size() == 2 && p.stream().allMatch(x -> x.job().equals("candidate") && x.colour() == CANDIDATE_COLOUR), "pulses " + p);
            check(p.get(0).box().equals(new Box(-40, -61, 0, -25, -50, 15)), "first box " + p.get(0).box());
            arrived[0] = OverlayClient.state().flashes(Util.getMillis()).stream().filter(a -> a.hit()).findFirst().orElseThrow().start();
            return true;
        }, 200);
        s.waitUntil("still pulsing after a change flash would have expired", () -> {
            long t = Util.getMillis() - arrived[0];
            if (t < 2 * OverlayState.FLASH_MS + 200) return false;
            check(t < OverlayState.HIT_PULSES * OverlayState.FLASH_MS, "too late to check: " + t + " ms");
            List<DrawList.Pulse> p = OverlayClient.drawList().pulses();
            check(p.size() == 2 && p.stream().allMatch(x -> x.strength() > 0f), "pulses " + p);
            return true;
        }, 200);
        s.waitUntil("the hits expire", () -> OverlayClient.drawList().pulses().isEmpty(), 400);
    }
}
