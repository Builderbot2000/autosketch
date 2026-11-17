package dev.autosketch.mod.client.ui.blocks;

import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.VertexBuffer;
import com.mojang.math.Axis;
import java.util.Collection;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.renderer.GameRenderer;
import net.minecraft.client.renderer.ShaderInstance;
import net.minecraft.world.inventory.InventoryMenu;
import org.joml.Matrix4f;
import org.lwjgl.opengl.GL11;

/**
 * Draws {@link BlockMesh}es (16, *Ghost blocks*, *Library screen*'s 3D preview) with the game's
 * cutout block shader, its block atlas and lightmap, a tint and an alpha: the tint multiplies every
 * texel ({@code 0xffffff} leaves the blocks as they are), and an alpha below 1 draws translucent.
 *
 * <p>Translucent drawing is two passes: depth only, then colour where the depth matches, so only the
 * front-most ghost surface shows, once, whatever order the meshes come in (no sorting; inner faces
 * never double the alpha). Texels whose alpha falls below 0.1 after the alpha is applied are
 * discarded, as the cutout layer does.
 *
 * <p>Usable in the world (from {@code RenderLevelStageEvent}, with its model-view and projection
 * matrices and the region's origin relative to the camera) and inside a screen
 * ({@link #drawInScreen}). Render thread. Restores the state it changes.
 *
 * <p>1.21.x: {@code GameRenderer.getRendertypeCutoutShader}, {@code VertexBuffer.drawWithShader},
 * {@code LightTexture.turnOnLightLayer} and the GUI's projection are what a port checks.
 */
public final class BlockDrawer {
    private BlockDrawer() {}

    /** A tint {@code amount} of the way from white to {@code rgb}: a ghost keeps its textures readable. */
    public static int towardWhite(int rgb, float amount) {
        int r = (rgb >> 16) & 0xff, g = (rgb >> 8) & 0xff, b = rgb & 0xff;
        r = Math.round(255 + (r - 255) * amount);
        g = Math.round(255 + (g - 255) * amount);
        b = Math.round(255 + (b - 255) * amount);
        return (r << 16) | (g << 8) | b;
    }

    /**
     * Draws meshes of one region.
     *
     * @param modelView the camera's model-view (not changed)
     * @param projection the projection
     * @param ox the region's local {@code [0,0,0]} in the model-view's space (in the world: origin minus camera position)
     * @param rgb the tint, {@code 0xrrggbb}
     * @param alpha 1 for opaque, below 1 for translucent
     */
    public static void draw(Collection<BlockMesh> meshes, Matrix4f modelView, Matrix4f projection, double ox, double oy, double oz, int rgb, float alpha) {
        if (meshes.isEmpty()) return;
        ShaderInstance shader = GameRenderer.getRendertypeCutoutShader();
        if (shader == null) return;
        RenderSystem.assertOnRenderThread();
        Minecraft mc = Minecraft.getInstance();
        RenderSystem.setShaderTexture(0, InventoryMenu.BLOCK_ATLAS);
        mc.gameRenderer.lightTexture().turnOnLightLayer();
        RenderSystem.enableDepthTest();
        RenderSystem.depthFunc(GL11.GL_LEQUAL);
        float r = ((rgb >> 16) & 0xff) / 255f, g = ((rgb >> 8) & 0xff) / 255f, b = (rgb & 0xff) / 255f;
        Matrix4f mv = new Matrix4f();
        try {
            if (alpha < 1f) {
                RenderSystem.colorMask(false, false, false, false);
                RenderSystem.depthMask(true);
                RenderSystem.setShaderColor(1f, 1f, 1f, 1f);
                pass(meshes, modelView, projection, ox, oy, oz, shader, mv);
                RenderSystem.colorMask(true, true, true, true);
                RenderSystem.enableBlend();
                RenderSystem.defaultBlendFunc();
                RenderSystem.depthMask(false);
            }
            RenderSystem.setShaderColor(r, g, b, alpha);
            pass(meshes, modelView, projection, ox, oy, oz, shader, mv);
        } finally {
            RenderSystem.setShaderColor(1f, 1f, 1f, 1f);
            RenderSystem.colorMask(true, true, true, true);
            RenderSystem.depthMask(true);
            RenderSystem.disableBlend();
            mc.gameRenderer.lightTexture().turnOffLightLayer();
            VertexBuffer.unbind();
        }
    }

    private static void pass(Collection<BlockMesh> meshes, Matrix4f modelView, Matrix4f projection, double ox, double oy, double oz, ShaderInstance shader,
            Matrix4f mv) {
        for (BlockMesh m : meshes) {
            if (m.closed()) continue;
            mv.set(modelView).translate((float) (ox + m.x()), (float) (oy + m.y()), (float) (oz + m.z()));
            m.buffer().bind();
            m.buffer().drawWithShader(mv, projection, shader);
        }
    }

    /**
     * Draws a region's meshes in a screen, opaque and untinted: centred on {@code (centerX, centerY)}
     * (GUI pixels), {@code scale} pixels per block, turned {@code yaw} degrees about the vertical
     * axis and tilted {@code pitch} degrees toward the viewer (an orbit camera). The region turns
     * about its centre, {@code size} being its size in blocks. Flushes the GUI's pending batches
     * first, so the blocks draw over whatever the screen drew before.
     */
    public static void drawInScreen(GuiGraphics graphics, Collection<BlockMesh> meshes, int sizeX, int sizeY, int sizeZ, float centerX, float centerY,
            float scale, float yaw, float pitch) {
        graphics.flush();
        Matrix4f mv = new Matrix4f(RenderSystem.getModelViewMatrix()).mul(graphics.pose().last().pose());
        // GUI y points down; z toward the viewer. Mid-depth keeps the region inside the GUI's depth range.
        mv.translate(centerX, centerY, 400f).scale(scale, -scale, scale).rotate(Axis.XP.rotationDegrees(pitch)).rotate(Axis.YP.rotationDegrees(yaw));
        RenderSystem.disableCull(); // the y flip reverses the winding
        try {
            draw(meshes, mv, RenderSystem.getProjectionMatrix(), -sizeX / 2.0, -sizeY / 2.0, -sizeZ / 2.0, 0xffffff, 1f);
        } finally {
            RenderSystem.enableCull();
        }
    }
}
