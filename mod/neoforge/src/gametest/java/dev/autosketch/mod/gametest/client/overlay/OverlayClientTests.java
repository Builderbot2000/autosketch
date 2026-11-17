package dev.autosketch.mod.gametest.client.overlay;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;
import static dev.autosketch.mod.gametest.client.overlay.OverlayScript.J1_BRIEF;
import static dev.autosketch.mod.gametest.client.overlay.OverlayScript.J1_COLOUR;
import static dev.autosketch.mod.gametest.client.overlay.OverlayScript.J2_BRIEF;
import static dev.autosketch.mod.gametest.client.overlay.OverlayScript.J2_COLOUR;

import com.mojang.blaze3d.platform.NativeImage;
import dev.autosketch.mod.client.ui.AutosketchKeys;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.UiToggles;
import dev.autosketch.mod.client.ui.overlay.DrawList;
import dev.autosketch.mod.client.ui.overlay.OverlayClient;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import dev.autosketch.mod.protocol.Box;
import java.util.List;
import net.minecraft.client.CloudStatus;
import org.lwjgl.glfw.GLFW;

/**
 * Job volumes and change flashes in the world (16, *Overlays in the world*; briefs/ui/O), against
 * a fake MCP's {@code ui.state} and {@code ui.flash} ({@link OverlayScript}). Assertions are on the
 * draw list ({@link OverlayClient#drawList()}); one pixel check shows an outline through a wall.
 */
public final class OverlayClientTests {
    private OverlayClientTests() {}

    static DrawList draw() {
        return OverlayClient.drawList();
    }

    static List<DrawList.Outline> outlines(String job, boolean dashed) {
        return draw().outlines().stream().filter(o -> o.job().equals(job) && o.dashed() == dashed).toList();
    }

    /** Two jobs: two solid boxes, their context boxes dashed, two labels; removing j2 removes its boxes. */
    @ClientTest("overlay")
    public static void jobVolumesFollowTheState(ClientTestSuite s) {
        OverlayScript.connect(s, OverlayScript.shared());
        s.step("two solid boxes, three dashed, two labels, in the jobs' colours", () -> {
            DrawList d = draw();
            check(d.outlines().stream().filter(o -> !o.dashed()).count() == 2, "solid outlines " + d.outlines());
            List<DrawList.Outline> j1 = outlines("j1", false), j2 = outlines("j2", false);
            check(j1.size() == 1 && j1.get(0).box().equals(new Box(4, -60, 4, 8, -56, 8)) && j1.get(0).colour() == J1_COLOUR, "j1 " + j1);
            check(j2.size() == 1 && j2.get(0).box().equals(new Box(-8, -60, 4, -4, -60, 8)) && j2.get(0).colour() == J2_COLOUR, "j2 " + j2);
            List<DrawList.Outline> c1 = outlines("j1", true), c2 = outlines("j2", true);
            check(c1.size() == 1 && c1.get(0).box().equals(new Box(3, -61, 3, 9, -55, 9)), "j1 context " + c1);
            check(c2.size() == 2 && c2.stream().allMatch(o -> o.colour() == J2_COLOUR), "j2 context " + c2);
            check(d.labels().size() == 2, "labels " + d.labels());
            check(d.labels().get(0).text().equals(J1_BRIEF) && d.labels().get(1).text().equals(J2_BRIEF), "labels " + d.labels());
            DrawList.Label l = d.labels().get(0);
            check(l.x() == 6.5 && l.z() == 6.5 && l.y() > -55, "j1 label above its box's top centre: " + l);
            check(d.outlines().stream().noneMatch(o -> o.job().equals("jn")), "the nether job is kept but not drawn");
            check(OverlayClient.state().jobs().size() == 3, "held jobs " + OverlayClient.state().jobs());
        });
        s.step("the MCP removes j2 (change seq 2)", () -> OverlayScript.trigger("logs.list"));
        s.waitUntil("j2's boxes and label are gone, j1's stay", () -> {
            DrawList d = draw();
            check(OverlayClient.state().seq() == 2, "seq " + OverlayClient.state().seq());
            check(d.outlines().stream().noneMatch(o -> o.job().equals("j2")), "outlines " + d.outlines());
            check(outlines("j1", false).size() == 1 && outlines("j1", true).size() == 1, "j1 " + d.outlines());
            check(d.labels().size() == 1 && d.labels().get(0).job().equals("j1"), "labels " + d.labels());
            return true;
        }, 200);
    }

    /** A {@code ui.flash} adds a pulse in the job's colour that expires; another dimension's isn't drawn. */
    @ClientTest("overlay")
    public static void flashPulsesThenExpires(ClientTestSuite s) {
        OverlayScript.connect(s, OverlayScript.shared());
        s.step("no pulse yet; the MCP flashes j1's boxes", () -> {
            check(draw().pulses().isEmpty(), "pulses " + draw().pulses());
            OverlayScript.trigger("library.list");
        });
        s.waitUntil("two pulses in j1's colour", () -> {
            List<DrawList.Pulse> p = draw().pulses();
            check(p.size() == 2 && p.stream().allMatch(x -> x.job().equals("j1") && x.colour() == J1_COLOUR && x.strength() > 0), "pulses " + p);
            check(p.get(0).box().equals(new Box(5, -60, 5, 5, -60, 5)), "first box " + p.get(0).box());
            return true;
        }, 200);
        s.waitUntil("the pulses expire", () -> {
            check(draw().pulses().isEmpty(), "pulses " + draw().pulses());
            return true;
        }, 200);
    }

    /** A change that doesn't follow the held seq is dropped, and the client asks for a resync. */
    @ClientTest("overlay")
    public static void gapResyncs(ClientTestSuite s) {
        int[] before = new int[2];
        OverlayScript.connect(s, OverlayScript.shared());
        s.step("the MCP sends a change with seq 9", () -> {
            before[0] = OverlayClient.resyncs();
            before[1] = resyncsReceived(s);
            OverlayScript.trigger("settings.list");
        });
        s.waitUntil("the client sent one resync and the MCP received it", () -> {
            check(OverlayClient.resyncs() == before[0] + 1, "resyncs " + OverlayClient.resyncs());
            check(resyncsReceived(s) == before[1] + 1, "resync requests at the MCP " + resyncsReceived(s));
            return true;
        }, 200);
        s.waitUntil("back on the full state seq 1, without the dropped j3", () -> {
            check(OverlayClient.state().seq() == 1, "seq " + OverlayClient.state().seq());
            check(OverlayClient.state().jobs().stream().map(j -> j.id()).toList().equals(List.of("j1", "j2", "jn")), "jobs " + OverlayClient.state().jobs());
            check(draw().outlines().stream().noneMatch(o -> o.job().equals("j3")), "outlines " + draw().outlines());
            return true;
        }, 200);
    }

    static int resyncsReceived(ClientTestSuite s) {
        return (int) s.mcp().received("ui.request").stream().filter(m -> m.get("kind").getAsString().equals("resync")).count();
    }

    /** The volume and flash keys each empty and refill their part of the draw list. */
    @ClientTest("overlay")
    public static void keysToggleVolumesAndFlashes(ClientTestSuite s) {
        OverlayScript.connect(s, OverlayScript.shared());
        s.step("bind the toggles to keypad keys", () -> {
            OverlayScript.bind(AutosketchKeys.TOGGLE_VOLUMES, GLFW.GLFW_KEY_KP_1);
            OverlayScript.bind(AutosketchKeys.TOGGLE_FLASHES, GLFW.GLFW_KEY_KP_2);
            check(UiToggles.volumes && UiToggles.flashes, "toggles start on");
            s.clearMessages();
            s.click(AutosketchKeys.TOGGLE_VOLUMES);
        });
        s.waitUntil("volumes off: no outlines, no labels", () -> {
            check(!UiToggles.volumes && draw().outlines().isEmpty() && draw().labels().isEmpty(), "draw " + draw());
            check(s.actionBarHas("job volumes off"), "action bar " + s.actionBar());
            return true;
        }, 100);
        s.step("volumes key again", () -> s.click(AutosketchKeys.TOGGLE_VOLUMES));
        s.waitUntil("volumes on: outlines and labels back", () -> {
            check(UiToggles.volumes && draw().outlines().size() == 5 && draw().labels().size() == 2, "draw " + draw());
            return true;
        }, 100);
        s.step("flashes key, then a flash", () -> s.click(AutosketchKeys.TOGGLE_FLASHES));
        s.waitUntil("flashes off", () -> !UiToggles.flashes, 100);
        s.step("the MCP flashes", () -> OverlayScript.trigger("library.list"));
        s.waitUntil("the flash is held but no pulse is drawn", () -> {
            check(!OverlayClient.state().flashes(net.minecraft.Util.getMillis()).isEmpty(), "no flash arrived");
            check(draw().pulses().isEmpty() && draw().outlines().size() == 5, "draw " + draw());
            return true;
        }, 200);
        s.step("flashes key again", () -> s.click(AutosketchKeys.TOGGLE_FLASHES));
        s.waitUntil("the pulses are drawn again", () -> {
            check(UiToggles.flashes && draw().pulses().size() == 2, "pulses " + draw().pulses());
            return true;
        }, 20);
        s.cleanup("unbind, toggles on", () -> {
            OverlayScript.unbind(AutosketchKeys.TOGGLE_VOLUMES);
            OverlayScript.unbind(AutosketchKeys.TOGGLE_FLASHES);
            UiToggles.volumes = true;
            UiToggles.flashes = true;
        });
    }

    /** Nothing is drawn while the link is offline, and the held state is forgotten. */
    @ClientTest("overlay")
    public static void nothingDrawnOffline(ClientTestSuite s) {
        OverlayScript.connect(s, OverlayScript.shared());
        s.step("something is drawn while connected", () -> check(!draw().isEmpty(), "empty draw list"));
        s.step("the MCP goes away", () -> OverlayScript.stop(s));
        s.waitUntil("offline: an empty draw list and no held jobs", () -> {
            check(LinkState.get() == LinkState.State.OFFLINE, "link " + LinkState.get());
            check(draw().isEmpty() && OverlayClient.state().jobs().isEmpty() && OverlayClient.state().seq() == 0, "draw " + draw());
            return true;
        }, 1200);
        s.step("the toggle key is locked offline", () -> {
            OverlayScript.bind(AutosketchKeys.TOGGLE_VOLUMES, GLFW.GLFW_KEY_KP_1);
            s.clearMessages();
            s.click(AutosketchKeys.TOGGLE_VOLUMES);
        });
        s.waitUntil("the lock's line, the toggle unchanged", () -> {
            check(s.actionBarHas("isn't connected") && UiToggles.volumes, "action bar " + s.actionBar() + ", volumes " + UiToggles.volumes);
            return true;
        }, 100);
        s.cleanup("unbind, MCP back", () -> {
            OverlayScript.unbind(AutosketchKeys.TOGGLE_VOLUMES);
            UiToggles.volumes = true;
            OverlayScript.restart(s, OverlayScript.shared());
        });
    }

    /**
     * A job's outline is visible through a wall (a pixel check, 16, *Testing*: state can't prove a
     * line draws through blocks). The work box stands fully behind a stone wall; the frames with job
     * volumes on and off differ by pixels in the job's magenta, where only wall was.
     */
    @ClientTest("overlay")
    public static void outlineVisibleThroughAWall(ClientTestSuite s) {
        NativeImage[] shots = new NativeImage[2];
        OverlayScript.connect(s, OverlayScript.job("jw", 0xff00ff, "", OverlayScript.OVERWORLD,
                OverlayScript.box(-2, -59, 9, 2, -56, 12), new com.google.gson.JsonArray()));
        s.step("a stone wall between the player and the job, the player facing it", () -> {
            s.command("fill -8 -60 3 8 -48 3 minecraft:stone");
            s.command("tp @s 0.5 -60 -2.5 0 0");
            s.hideGui(true);
            s.mc().options.cloudStatus().set(CloudStatus.OFF);
        });
        s.waitUntil("the wall is in the client's world and the player faces south", () -> {
            var level = s.mc().level;
            return level.getBlockState(new net.minecraft.core.BlockPos(0, -58, 3)).is(net.minecraft.world.level.block.Blocks.STONE)
                    && Math.abs(s.player().getYRot()) < 0.01f && Math.abs(s.player().getZ() + 2.5) < 0.01;
        }, 200);
        s.waitFrames("frames with the outline", 5);
        s.step("screenshot with job volumes on", () -> {
            check(draw().outlines().size() == 1, "outlines " + draw().outlines());
            shots[0] = s.screenshot("overlay-through-wall-on");
            UiToggles.volumes = false;
        });
        s.waitFrames("frames without", 5);
        s.step("screenshot with job volumes off", () -> shots[1] = s.screenshot("overlay-through-wall-off"));
        s.step("magenta pixels only with volumes on", () -> {
            NativeImage on = shots[0], off = shots[1];
            int magenta = 0;
            for (int y = 0; y < on.getHeight(); y++)
                for (int x = 0; x < on.getWidth(); x++) {
                    int p = on.getPixelRGBA(x, y); // ABGR
                    if (p == off.getPixelRGBA(x, y)) continue;
                    int r = p & 0xFF, g = (p >> 8) & 0xFF, b = (p >> 16) & 0xFF;
                    if (r - g > 30 && b - g > 30) magenta++;
                }
            check(magenta >= 50, "magenta outline pixels: " + magenta + " (changed pixels: " + ClientTestSuite.changedPixels(on, off, 8) + ")");
        });
        s.cleanup("wall gone, screenshots closed", () -> {
            for (NativeImage i : shots)
                if (i != null) i.close();
            UiToggles.volumes = true;
            s.hideGui(false);
            s.mc().options.cloudStatus().set(CloudStatus.FANCY);
            s.command("fill -8 -60 3 8 -48 3 minecraft:air");
        });
    }
}
