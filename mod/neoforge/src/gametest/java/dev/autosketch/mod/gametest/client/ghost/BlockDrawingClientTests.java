package dev.autosketch.mod.gametest.client.ghost;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.mojang.blaze3d.platform.NativeImage;
import dev.autosketch.mod.client.ui.blocks.BlockDrawer;
import dev.autosketch.mod.client.ui.blocks.BlockMesh;
import dev.autosketch.mod.client.ui.blocks.BlockMesher;
import dev.autosketch.mod.client.ui.blocks.PaletteRegion;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/**
 * The shared block drawing (16, *Ghost blocks*; S's 3D preview uses it): a palette-plus-indices
 * region meshed with the game's block renderer, exact face counts proving faces between drawn blocks
 * are culled, unknown states drawing nothing, and meshes freed on close.
 */
public final class BlockDrawingClientTests {
    private BlockDrawingClientTests() {}

    /** A 3×3×3 stone cube meshes to its 54 outer faces; the hidden ones are culled. */
    @ClientTest("ghost")
    public static void aCubeMeshesToItsOuterFaces(ClientTestSuite s) {
        BlockMesh[] mesh = new BlockMesh[1];
        s.step("mesh a 3×3×3 stone cube", () -> {
            int[] idx = new int[27];
            Arrays.fill(idx, 1);
            PaletteRegion r = PaletteRegion.of(List.of("minecraft:air", "minecraft:stone"), 3, 3, 3, idx);
            mesh[0] = BlockMesher.section(r, 0, 0, 0, null, 0, 0, 0);
            check(mesh[0] != null, "no mesh");
            check(mesh[0].quads() == 54, "quads " + mesh[0].quads() + ", want 54");
            check(mesh[0].bytes() == 54L * 4 * 32, "bytes " + mesh[0].bytes());
        });
        s.step("close frees it", () -> {
            mesh[0].close();
            check(mesh[0].closed(), "still open");
            mesh[0].close();
        });
    }

    /**
     * In a screen ({@link BlockDrawer#drawInScreen}, as S's preview draws): a gold cube appears at the
     * screen's centre. Compares frames of the same screen with and without the blocks.
     */
    @ClientTest("ghost")
    public static void drawsInAScreen(ClientTestSuite s) {
        List<BlockMesh> meshes = new ArrayList<>();
        boolean[] show = {false};
        NativeImage[] shots = new NativeImage[2];
        s.step("open a screen drawing a 4×4×4 gold cube", () -> {
            int[] idx = new int[64];
            Arrays.fill(idx, 0);
            meshes.addAll(BlockMesher.all(PaletteRegion.of(List.of("minecraft:gold_block"), 4, 4, 4, idx)));
            check(meshes.size() == 1 && meshes.get(0).quads() == 96, "meshes " + meshes);
            s.mc().setScreen(new Screen(Component.literal("blocks")) {
                @Override
                public void render(GuiGraphics g, int mouseX, int mouseY, float partial) {
                    g.fill(0, 0, width, height, 0xff202020);
                    if (show[0]) BlockDrawer.drawInScreen(g, meshes, 4, 4, 4, width / 2f, height / 2f, 20f, 30f, 25f);
                }
            });
        });
        s.waitFrames("a frame without blocks", 3);
        s.step("screenshot without", () -> shots[0] = s.screenshot("screen-blocks-off"));
        s.step("show the blocks", () -> show[0] = true);
        s.waitFrames("a frame with blocks", 3);
        s.step("gold pixels at the centre", () -> {
            shots[1] = s.screenshot("screen-blocks-on");
            NativeImage on = shots[1];
            int cx = on.getWidth() / 2, cy = on.getHeight() / 2, gold = 0;
            for (int y = cy - 20; y < cy + 20; y++)
                for (int x = cx - 20; x < cx + 20; x++) {
                    int p = on.getPixelRGBA(x, y); // ABGR
                    int r = p & 0xff, gr = (p >> 8) & 0xff, b = (p >> 16) & 0xff;
                    if (r > 120 && gr > 80 && b < gr) gold++;
                }
            check(gold > 800, "gold pixels near the centre: " + gold + " (changed " + ClientTestSuite.changedPixels(shots[0], on, 8) + ")");
        });
        s.cleanup("close the screen and meshes", () -> {
            s.mc().setScreen(null);
            meshes.forEach(BlockMesh::close);
            for (NativeImage i : shots)
                if (i != null) i.close();
        });
    }

    /** Air, positions past the region and unknown states draw nothing; a single block draws six faces. */
    @ClientTest("ghost")
    public static void unknownAndAirDrawNothing(ClientTestSuite s) {
        s.step("an all-air or unknown section has no mesh", () -> {
            PaletteRegion r = PaletteRegion.of(List.of("minecraft:air", "nomod:nothing"), 2, 1, 1, new int[] {0, 1});
            check(r.unknown().equals(List.of("nomod:nothing")), "unknown " + r.unknown());
            check(BlockMesher.section(r, 0, 0, 0, null, 0, 0, 0) == null, "a mesh for nothing");
            check(BlockMesher.section(r, 1, 0, 0, null, 0, 0, 0) == null, "a mesh past the region");
        });
        s.step("one glass block: six faces; a stair: more", () -> {
            PaletteRegion r = PaletteRegion.of(List.of("minecraft:glass", "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]"),
                    3, 1, 1, new int[] {0, 0, 1});
            List<BlockMesh> all = BlockMesher.all(r);
            check(all.size() == 1, "meshes " + all.size());
            // Two glass blocks share a face (glass culls glass): 10 faces; the stair has 10 or more.
            int q = all.get(0).quads();
            check(q >= 20, "quads " + q);
            all.forEach(BlockMesh::close);
        });
    }
}
