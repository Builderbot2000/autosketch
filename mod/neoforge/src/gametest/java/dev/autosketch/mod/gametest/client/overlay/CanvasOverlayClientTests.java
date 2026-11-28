package dev.autosketch.mod.gametest.client.overlay;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.mojang.blaze3d.platform.NativeImage;
import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.client.ui.overlay.DrawList;
import dev.autosketch.mod.client.ui.overlay.OverlayClient;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.volume.CanvasMode;
import dev.autosketch.mod.volume.Wand;
import java.util.List;

/**
 * The canvas on the overlay (19, *Placing and moving the brush*; briefs/canvas/K, K1): with the client
 * half and the link {@code connected}, {@code /autosketch canvas here 1} and {@code show} draw the
 * canvas as a faint box (3×3 chunks, full build height) and no chunk grid; with the wand in hand the
 * chunk grid is drawn on the ground too, a line on every chunk boundary of the canvas; with the wand
 * away it goes again, and clearing the canvas removes the box.
 */
public final class CanvasOverlayClientTests {
    private CanvasOverlayClientTests() {}

    static List<DrawList.Volume> canvasBoxes() {
        return OverlayClient.drawList().volumes().stream().filter(DrawList.Volume::faint).toList();
    }

    static List<DrawList.GridLine> grid() {
        return OverlayClient.drawList().grid();
    }

    @ClientTest("overlay")
    public static void canvasFaintWithAChunkGridWhileTheWandIsHeld(ClientTestSuite s) {
        Box[] expected = {null};
        NativeImage[] shots = new NativeImage[2];
        OverlayScript.connect(s, OverlayScript.shared());
        s.step("canvas here 1 around the player, outlines shown", () -> {
            check(canvasBoxes().isEmpty() && grid().isEmpty(), "canvas drawn before: " + canvasBoxes() + " " + grid());
            int cx = s.player().getBlockX() >> 4, cz = s.player().getBlockZ() >> 4;
            expected[0] = new Box((cx - 1) << 4, s.mc().level.getMinBuildHeight(), (cz - 1) << 4, ((cx + 1) << 4) + 15, s.mc().level.getMaxBuildHeight() - 1, ((cz + 1) << 4) + 15);
            s.command("autosketch canvas here 1");
            s.command("autosketch show");
        });
        s.waitUntil("the canvas is drawn faint, without a grid", () -> {
            List<DrawList.Volume> c = canvasBoxes();
            if (c.isEmpty()) return false;
            check(c.size() == 1 && c.get(0).box().equals(expected[0]) && c.get(0).colour() == CanvasMode.COLOUR, "canvas " + c + ", expected " + expected[0]);
            check(grid().isEmpty(), "no grid without the wand: " + grid());
            return true;
        }, 200);
        s.waitFrames("frames without the grid", 5);
        s.step("screenshot without the grid; wand in the main hand", () -> {
            s.hideGui(true);
            shots[0] = s.screenshot("canvas-no-grid");
            s.player().getInventory().selected = 0;
            s.command("item replace entity @s hotbar.0 with minecraft:blaze_rod");
        });
        s.waitUntil("the server sees the wand in hand", () -> s.onServer(server -> Wand.isWand(s.serverPlayer(server).getMainHandItem())), 100);
        s.waitUntil("a grid line on every chunk boundary of the canvas", () -> {
            List<DrawList.GridLine> g = grid();
            if (g.isEmpty()) return false;
            Box b = expected[0];
            List<DrawList.GridLine> alongZ = g.stream().filter(l -> l.x0() == l.x1()).toList(), alongX = g.stream().filter(l -> l.z0() == l.z1()).toList();
            check(alongZ.size() == 4 && alongX.size() == 4, "4 lines each way over 3×3 chunks: " + g);
            for (int i = 0; i < 4; i++) {
                check(alongZ.get(i).x0() == b.minX() + 16 * i && alongZ.get(i).z0() == b.minZ() && alongZ.get(i).z1() == b.maxZ() + 1, "x line " + i + ": " + alongZ.get(i));
                check(alongX.get(i).z0() == b.minZ() + 16 * i && alongX.get(i).x0() == b.minX() && alongX.get(i).x1() == b.maxX() + 1, "z line " + i + ": " + alongX.get(i));
            }
            check(g.stream().allMatch(l -> l.y() == s.player().getBlockY() + 0.02 && l.colour() == CanvasMode.COLOUR), "on the ground, in the canvas colour: " + g);
            return true;
        }, 200);
        s.waitFrames("frames with the grid", 5);
        s.step("screenshot with the grid", () -> shots[1] = s.screenshot("canvas-grid"));
        s.step("the grid changes the picture", () -> {
            long changed = ClientTestSuite.changedPixels(shots[1], shots[0], 8);
            check(changed >= 50, "changed pixels: " + changed);
        });
        s.step("wand away", () -> s.player().getInventory().selected = 8);
        s.waitUntil("the grid goes with the wand, the faint box stays", () -> grid().isEmpty() && canvasBoxes().size() == 1, 200);
        s.step("canvas clear", () -> s.command("autosketch canvas clear"));
        s.waitUntil("no canvas drawn", () -> canvasBoxes().isEmpty(), 200);
        s.cleanup("canvas cleared, outlines off, wand away", () -> {
            for (NativeImage i : shots)
                if (i != null) i.close();
            s.player().getInventory().selected = 8;
            s.hideGui(false);
            s.onServer(server -> {
                AutosketchMod.internals().canvas().clear();
                AutosketchMod.internals().players().get(s.player().getUUID()).show = false;
                return null;
            });
        });
    }
}
