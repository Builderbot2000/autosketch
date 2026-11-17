package dev.autosketch.mod.client.ui.replay;

import com.mojang.blaze3d.vertex.PoseStack;
import com.mojang.blaze3d.vertex.VertexConsumer;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.client.ui.UiToggles;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.UiMessages.Flash;
import dev.autosketch.mod.protocol.UiMessages.Job;
import dev.autosketch.mod.protocol.UiMessages.Marker;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.renderer.LevelRenderer;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.world.phys.Vec3;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.client.event.RenderGuiEvent;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent;

/**
 * What a replay draws besides the blocks (16, *Replay in the world*, *Controls* and *The scope tree
 * in space*): a strip at the top of the screen with the step's time, the step and play state, the
 * tool call, the job's brief and any gap note, over a bar with a tick per marker; and in the world,
 * the open jobs' work volumes (context dimmer) and the step's edits pulsing in their job's colour.
 * Everything is the frame's text and boxes, nothing computed. Minimal line boxes until silo O's
 * overlay drawing can be reused; they follow the job-volume and flash toggles.
 *
 * <p>1.21.x: {@code RenderGuiEvent}, {@code RenderLevelStageEvent} and {@code LevelRenderer.renderLineBox}
 * changed shape across 1.21; a port looks here.
 */
@EventBusSubscriber(modid = Autosketch.MOD_ID, value = Dist.CLIENT)
public final class ReplayHud {
    private ReplayHud() {}

    /** How long a step's flash pulses, in milliseconds. */
    static final long FLASH_MS = 1200;

    /** The strip's lines as drawn (for tests): status, call, then brief and note when present. */
    public static List<String> lines() {
        ReplayView v = ReplayClient.view();
        List<String> out = new ArrayList<>();
        if (v == null) {
            if (ReplayClient.isOpen()) out.add("Replay: opening…");
            return out;
        }
        String speed = ReplayClient.speed() == Math.floor(ReplayClient.speed()) ? String.valueOf((long) ReplayClient.speed()) : String.valueOf(ReplayClient.speed());
        out.add("Replay  step " + Math.max(v.step, 0) + "/" + v.steps + "  " + v.time + "  " + (ReplayClient.playing() ? "playing" : "paused") + " " + speed + "/s");
        out.add(v.hud.call());
        if (v.hud.brief() != null) out.add(v.hud.brief());
        if (v.hud.note() != null) out.add(v.hud.note());
        return out;
    }

    @SubscribeEvent
    static void gui(RenderGuiEvent.Post e) {
        Minecraft mc = Minecraft.getInstance();
        if (!ReplayClient.isOpen() || mc.options.hideGui) return;
        GuiGraphics g = e.getGuiGraphics();
        Font font = mc.font;
        List<String> lines = lines();
        int w = g.guiWidth();
        int width = Math.min(w - 16, 360);
        int x0 = (w - width) / 2, y = 4;
        int height = lines.size() * 10 + 12;
        g.fill(x0 - 4, y - 2, x0 + width + 4, y + height, 0xA0000000);
        for (int i = 0; i < lines.size(); i++) {
            String s = font.plainSubstrByWidth(lines.get(i), width);
            g.drawString(font, s, x0, y + i * 10, i == 0 ? 0xFFFFFF : i == lines.size() - 1 && lines.size() > 3 ? 0xFFD060 : 0xC0C0C0, false);
        }
        ReplayView v = ReplayClient.view();
        if (v == null || v.steps <= 0) return;
        int barY = y + lines.size() * 10 + 3;
        g.fill(x0, barY + 2, x0 + width, barY + 4, 0xFF606060);
        for (Marker m : v.markers) {
            int mx = x0 + (int) (width * m.step() / v.steps);
            g.fill(mx, barY, mx + 1, barY + 6, markerColour(m.kind()));
        }
        int cx = x0 + (int) (width * Math.max(v.step, 0) / v.steps);
        g.fill(cx - 1, barY - 1, cx + 2, barY + 7, 0xFFFFFFFF);
    }

    static int markerColour(String kind) {
        return switch (kind) {
            case "fork" -> 0xFF40C0FF;
            case "merge" -> 0xFF60E060;
            case "refusal" -> 0xFFFF5050;
            default -> 0xFFE0E040; // checkpoint
        };
    }

    @SubscribeEvent
    static void world(RenderLevelStageEvent e) {
        if (e.getStage() != RenderLevelStageEvent.Stage.AFTER_TRANSLUCENT_BLOCKS) return;
        ReplayView v = ReplayClient.view();
        Minecraft mc = Minecraft.getInstance();
        if (v == null || mc.level == null) return;
        String dim = mc.level.dimension().location().toString();
        Vec3 cam = e.getCamera().getPosition();
        PoseStack pose = e.getPoseStack();
        pose.pushPose();
        pose.translate(-cam.x, -cam.y, -cam.z);
        MultiBufferSource.BufferSource buffers = mc.renderBuffers().bufferSource();
        VertexConsumer lines = buffers.getBuffer(RenderType.lines());
        if (UiToggles.volumes)
            for (Job j : v.jobs) {
                if (!j.dimension().equals(dim)) continue;
                box(pose, lines, j.work(), j.colour(), 0.9f, 0.01);
                for (Box c : j.context()) box(pose, lines, c, j.colour(), 0.35f, 0.02);
            }
        long age = System.currentTimeMillis() - v.frameAt;
        if (UiToggles.flashes && age < FLASH_MS) {
            float a = 1f - (float) age / FLASH_MS;
            for (Flash f : v.flashes) {
                if (!f.dimension().equals(dim)) continue;
                for (Box b : f.boxes()) box(pose, lines, b, f.colour(), a, 0.03);
            }
        }
        buffers.endBatch(RenderType.lines());
        pose.popPose();
    }

    private static void box(PoseStack pose, VertexConsumer lines, Box b, int rgb, float alpha, double grow) {
        float r = ((rgb >> 16) & 0xFF) / 255f, g = ((rgb >> 8) & 0xFF) / 255f, bl = (rgb & 0xFF) / 255f;
        LevelRenderer.renderLineBox(pose, lines, b.minX() - grow, b.minY() - grow, b.minZ() - grow, b.maxX() + 1 + grow, b.maxY() + 1 + grow, b.maxZ() + 1 + grow, r, g, bl, alpha);
    }
}
