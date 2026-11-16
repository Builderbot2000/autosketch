package dev.autosketch.mod.client;

import com.mojang.blaze3d.vertex.PoseStack;
import dev.autosketch.mod.volume.AirMode;
import dev.autosketch.mod.volume.AirPayloads;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.renderer.LevelRenderer;
import net.minecraft.client.renderer.MultiBufferSource;
import net.minecraft.client.renderer.RenderType;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.neoforged.neoforge.client.event.InputEvent;
import net.neoforged.neoforge.client.event.RenderLevelStageEvent;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;
import net.neoforged.neoforge.network.PacketDistributor;

/**
 * The optional client half of air mode (13, B2), loaded only on a physical client. While the server
 * says air mode is on ({@link AirPayloads.State}) and the wand is in the main hand: a left click into
 * the air (which never reaches the server on its own) sends corner 1, sneak+scroll changes the
 * distance, and the point is drawn as a box outline. The server computes the point itself from the
 * player's eye and look; the client only chooses the distance. Unverified in a real client (the
 * GameTests cover the server half).
 */
public final class AirClient {
    private AirClient() {}

    public static void register() {
        NeoForge.EVENT_BUS.addListener(AirClient::leftClickEmpty);
        NeoForge.EVENT_BUS.addListener(AirClient::scroll);
        NeoForge.EVENT_BUS.addListener(AirClient::render);
    }

    /** The air state when it applies now: on, and the local player holds the wand in the main hand. */
    private static AirPayloads.State active(LocalPlayer p) {
        AirPayloads.State s = AirPayloads.clientState;
        if (s == null || p == null || p.getMainHandItem().isEmpty()) return null;
        return BuiltInRegistries.ITEM.getKey(p.getMainHandItem().getItem()).toString().equals(s.wandItem()) ? s : null;
    }

    private static void leftClickEmpty(PlayerInteractEvent.LeftClickEmpty e) {
        if (!e.getLevel().isClientSide()) return;
        AirPayloads.State s = active(Minecraft.getInstance().player);
        if (s != null) PacketDistributor.sendToServer(new AirPayloads.Click(1, s.reach()));
    }

    private static void scroll(InputEvent.MouseScrollingEvent e) {
        LocalPlayer p = Minecraft.getInstance().player;
        AirPayloads.State s = active(p);
        if (s == null || !p.isShiftKeyDown() || Minecraft.getInstance().screen != null || e.getScrollDeltaY() == 0) return;
        int reach = Math.max(1, Math.min(AirMode.MAX_REACH, s.reach() + (e.getScrollDeltaY() > 0 ? 1 : -1)));
        AirPayloads.clientState = new AirPayloads.State(true, reach, s.wandItem());
        PacketDistributor.sendToServer(new AirPayloads.Click(0, reach));
        p.displayClientMessage(Component.literal("Autosketch: air distance " + reach), true);
        e.setCanceled(true);
    }

    private static void render(RenderLevelStageEvent e) {
        if (e.getStage() != RenderLevelStageEvent.Stage.AFTER_TRANSLUCENT_BLOCKS) return;
        Minecraft mc = Minecraft.getInstance();
        AirPayloads.State s = active(mc.player);
        if (s == null) return;
        float partial = e.getPartialTick().getGameTimeDeltaPartialTick(false);
        Vec3 at = mc.player.getEyePosition(partial).add(mc.player.getViewVector(partial).scale(s.reach()));
        BlockPos b = BlockPos.containing(at);
        Vec3 cam = e.getCamera().getPosition();
        PoseStack pose = e.getPoseStack();
        pose.pushPose();
        pose.translate(-cam.x, -cam.y, -cam.z);
        MultiBufferSource.BufferSource buffers = mc.renderBuffers().bufferSource();
        LevelRenderer.renderLineBox(pose, buffers.getBuffer(RenderType.lines()), new AABB(b).inflate(0.002), 1f, 1f, 1f, 0.9f);
        buffers.endBatch(RenderType.lines());
        pose.popPose();
    }
}
