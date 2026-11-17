package dev.autosketch.mod.client.ui.overlay;

import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.blaze3d.vertex.DefaultVertexFormat;
import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import com.mojang.blaze3d.vertex.VertexFormat;
import dev.autosketch.mod.protocol.Box;
import java.util.OptionalDouble;
import net.minecraft.client.Camera;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.renderer.LightTexture;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.world.phys.Vec3;
import org.joml.Matrix4f;

/**
 * Draws a {@link DrawList} into the world (16, *Overlays in the world*): outlines and pulses twice,
 * once faint and through blocks (no depth test, so a job behind a wall is still seen), once at full
 * strength where they're in view; labels as camera-facing text, also through blocks. Version
 * sensitive: render types, {@code RenderLevelStageEvent} and {@code Font.drawInBatch} are where a port
 * to another Minecraft version looks first (1.21 changed vertex building to {@code addVertex}/
 * {@code setColor}/{@code setNormal}).
 */
public final class OverlayRenderer {
    private OverlayRenderer() {}

    /** Length of a dash and of the gap after it on a context box's edges, in blocks. */
    static final double DASH = 0.5;
    /** Alpha of the through-blocks pass, against 1 for the pass in view. */
    static final float XRAY_ALPHA = 0.35f;
    /** Strongest alpha of a pulse's faces. */
    static final float PULSE_ALPHA = 0.45f;

    /**
     * The render types. A subclass of {@link RenderType} only to reach its protected state shards;
     * never instantiated. 1.21.1: {@code RenderType.create} and the shard names.
     */
    private abstract static class Types extends RenderType {
        private Types() {
            super("", DefaultVertexFormat.POSITION, VertexFormat.Mode.QUADS, 0, false, false, () -> {}, () -> {});
        }

        /**
         * Depth test off for the through-blocks passes. Vanilla's {@code NO_DEPTH_TEST} only leaves the
         * depth test as it found it (off by default), but the level render has it on at this stage, so
         * it is switched off here and back on after. Carried as a texturing shard, the one shard type
         * that takes its own setup and clear actions.
         */
        static final TexturingStateShard DEPTH_OFF = new TexturingStateShard("autosketch_depth_off", RenderSystem::disableDepthTest, RenderSystem::enableDepthTest);

        static final RenderType LINES = create("autosketch_overlay_lines", DefaultVertexFormat.POSITION_COLOR_NORMAL, VertexFormat.Mode.LINES, 1536, false, false,
                CompositeState.builder()
                        .setShaderState(RENDERTYPE_LINES_SHADER)
                        .setLineState(new LineStateShard(OptionalDouble.of(2.5)))
                        .setLayeringState(VIEW_OFFSET_Z_LAYERING)
                        .setTransparencyState(TRANSLUCENT_TRANSPARENCY)
                        .setOutputState(ITEM_ENTITY_TARGET)
                        .setWriteMaskState(COLOR_WRITE)
                        .setCullState(NO_CULL)
                        .createCompositeState(false));

        static final RenderType XRAY_LINES = create("autosketch_overlay_xray_lines", DefaultVertexFormat.POSITION_COLOR_NORMAL, VertexFormat.Mode.LINES, 1536, false, false,
                CompositeState.builder()
                        .setShaderState(RENDERTYPE_LINES_SHADER)
                        .setLineState(new LineStateShard(OptionalDouble.of(2.0)))
                        .setLayeringState(VIEW_OFFSET_Z_LAYERING)
                        .setTransparencyState(TRANSLUCENT_TRANSPARENCY)
                        .setOutputState(ITEM_ENTITY_TARGET)
                        .setWriteMaskState(COLOR_WRITE)
                        .setDepthTestState(NO_DEPTH_TEST)
                        .setTexturingState(DEPTH_OFF)
                        .setCullState(NO_CULL)
                        .createCompositeState(false));

        static final RenderType XRAY_QUADS = create("autosketch_overlay_xray_quads", DefaultVertexFormat.POSITION_COLOR, VertexFormat.Mode.QUADS, 1536, false, true,
                CompositeState.builder()
                        .setShaderState(POSITION_COLOR_SHADER)
                        .setTransparencyState(TRANSLUCENT_TRANSPARENCY)
                        .setWriteMaskState(COLOR_WRITE)
                        .setDepthTestState(NO_DEPTH_TEST)
                        .setTexturingState(DEPTH_OFF)
                        .setCullState(NO_CULL)
                        .createCompositeState(false));
    }

    /** Draws {@code list} relative to the camera. Called from the level render event. */
    public static void render(DrawList list, PoseStack pose, Camera camera, MultiBufferSource.BufferSource buffers) {
        if (list.isEmpty()) return;
        Vec3 cam = camera.getPosition();
        pose.pushPose();
        pose.translate(-cam.x, -cam.y, -cam.z);
        Matrix4f m = pose.last().pose();

        VertexConsumer quads = buffers.getBuffer(Types.XRAY_QUADS);
        for (DrawList.Pulse p : list.pulses()) faces(quads, m, p.box(), 0.01, p.colour(), PULSE_ALPHA * p.strength());
        buffers.endBatch(Types.XRAY_QUADS);

        for (int pass = 0; pass < 2; pass++) {
            RenderType type = pass == 0 ? Types.XRAY_LINES : Types.LINES;
            float alpha = pass == 0 ? XRAY_ALPHA : 1f;
            VertexConsumer lines = buffers.getBuffer(type);
            for (DrawList.Outline o : list.outlines()) edges(lines, m, o.box(), o.dashed() ? 0.03 : 0.02, o.colour(), alpha, o.dashed());
            for (DrawList.Pulse p : list.pulses()) edges(lines, m, p.box(), 0.015, p.colour(), alpha * p.strength(), false);
            buffers.endBatch(type);
        }

        Font font = Minecraft.getInstance().font;
        for (DrawList.Label l : list.labels()) label(font, pose, camera, buffers, l);
        buffers.endBatch();
        pose.popPose();
    }

    private static void label(Font font, PoseStack pose, Camera camera, MultiBufferSource buffers, DrawList.Label l) {
        pose.pushPose();
        pose.translate(l.x(), l.y(), l.z());
        pose.mulPose(camera.rotation()); // faces the camera, as name tags do
        float scale = 0.04f;
        pose.scale(scale, -scale, scale);
        String text = font.plainSubstrByWidth(l.text(), 320);
        if (text.length() < l.text().length()) text = font.plainSubstrByWidth(l.text(), 320 - font.width("…")) + "…";
        float x = -font.width(text) / 2f;
        int background = (int) (Minecraft.getInstance().options.getBackgroundOpacity(0.25f) * 255f) << 24;
        // As name tags: faint through blocks, then full strength where in view.
        font.drawInBatch(text, x, 0, 0x60000000 | l.colour(), false, pose.last().pose(), buffers, Font.DisplayMode.SEE_THROUGH, background, LightTexture.FULL_BRIGHT);
        font.drawInBatch(text, x, 0, 0xFF000000 | l.colour(), false, pose.last().pose(), buffers, Font.DisplayMode.NORMAL, 0, LightTexture.FULL_BRIGHT);
        pose.popPose();
    }

    /** The 12 edges of an inclusive block box, grown by {@code grow}; dashed edges as dash, gap, dash. */
    static void edges(VertexConsumer c, Matrix4f m, Box b, double grow, int rgb, float alpha, boolean dashed) {
        double x0 = b.minX() - grow, y0 = b.minY() - grow, z0 = b.minZ() - grow;
        double x1 = b.maxX() + 1 + grow, y1 = b.maxY() + 1 + grow, z1 = b.maxZ() + 1 + grow;
        double[][] e = {
                {x0, y0, z0, x1, y0, z0}, {x0, y1, z0, x1, y1, z0}, {x0, y0, z1, x1, y0, z1}, {x0, y1, z1, x1, y1, z1},
                {x0, y0, z0, x0, y1, z0}, {x1, y0, z0, x1, y1, z0}, {x0, y0, z1, x0, y1, z1}, {x1, y0, z1, x1, y1, z1},
                {x0, y0, z0, x0, y0, z1}, {x1, y0, z0, x1, y0, z1}, {x0, y1, z0, x0, y1, z1}, {x1, y1, z0, x1, y1, z1}};
        for (double[] s : e) {
            if (!dashed) {
                line(c, m, s[0], s[1], s[2], s[3], s[4], s[5], rgb, alpha);
                continue;
            }
            double len = Math.abs(s[3] - s[0]) + Math.abs(s[4] - s[1]) + Math.abs(s[5] - s[2]);
            for (double t = 0; t < len; t += 2 * DASH) {
                double a = t / len, z = Math.min(t + DASH, len) / len;
                line(c, m, s[0] + (s[3] - s[0]) * a, s[1] + (s[4] - s[1]) * a, s[2] + (s[5] - s[2]) * a,
                        s[0] + (s[3] - s[0]) * z, s[1] + (s[4] - s[1]) * z, s[2] + (s[5] - s[2]) * z, rgb, alpha);
            }
        }
    }

    private static void line(VertexConsumer c, Matrix4f m, double ax, double ay, double az, double bx, double by, double bz, int rgb, float alpha) {
        float dx = (float) (bx - ax), dy = (float) (by - ay), dz = (float) (bz - az);
        float n = (float) Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (n == 0) return;
        dx /= n;
        dy /= n;
        dz /= n;
        int r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, bl = rgb & 0xFF, a = Math.round(alpha * 255);
        c.addVertex(m, (float) ax, (float) ay, (float) az).setColor(r, g, bl, a).setNormal(dx, dy, dz);
        c.addVertex(m, (float) bx, (float) by, (float) bz).setColor(r, g, bl, a).setNormal(dx, dy, dz);
    }

    /** The six faces of an inclusive block box, grown by {@code grow}. */
    private static void faces(VertexConsumer c, Matrix4f m, Box b, double grow, int rgb, float alpha) {
        float x0 = (float) (b.minX() - grow), y0 = (float) (b.minY() - grow), z0 = (float) (b.minZ() - grow);
        float x1 = (float) (b.maxX() + 1 + grow), y1 = (float) (b.maxY() + 1 + grow), z1 = (float) (b.maxZ() + 1 + grow);
        int r = (rgb >> 16) & 0xFF, g = (rgb >> 8) & 0xFF, bl = rgb & 0xFF, a = Math.round(alpha * 255);
        float[][] q = {
                {x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1}, {x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0},
                {x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0}, {x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1},
                {x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0}, {x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1}};
        for (float[] f : q)
            for (int i = 0; i < 12; i += 3) c.addVertex(m, f[i], f[i + 1], f[i + 2]).setColor(r, g, bl, a);
    }
}
