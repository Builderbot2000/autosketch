package dev.autosketch.mod.client.ui.replay;

import dev.autosketch.mod.api.Autosketch;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.Marker;
import net.minecraft.world.phys.Vec3;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.client.event.InputEvent;
import net.neoforged.neoforge.client.event.RenderHandEvent;
import net.neoforged.neoforge.client.event.ViewportEvent;
import net.neoforged.neoforge.event.tick.PlayerTickEvent;
import org.jetbrains.annotations.Nullable;

/**
 * The detached camera and the frozen player of a replay (16, *Replay in the world*, *Camera*):
 * blocks that exist only in the client's copy of the world must not push the player around, so the
 * view moves to a client-only camera entity that flies where the player looks with the movement keys,
 * and the player stays exactly where it stood (no game-mode change). The player still turns with the
 * mouse, and the camera looks the same way. Restored on close, disconnect and the link going offline
 * ({@link ReplayClient#teardown}).
 *
 * <p>While the camera isn't the player, vanilla neither applies the player's movement input nor
 * sends its position ({@code LocalPlayer.isControlledCamera}); the freeze below also undoes gravity
 * and knockback on the client, so the position sent after close is the one the server has.
 *
 * <p>1.21.x: {@code Minecraft.setCameraEntity}, {@code LocalPlayer.isControlledCamera}, the
 * {@code Marker} constructor and {@code ViewportEvent.ComputeCameraAngles} are where a port looks.
 */
@EventBusSubscriber(modid = Autosketch.MOD_ID, value = Dist.CLIENT)
public final class ReplayCamera {
    private ReplayCamera() {}

    /** Camera speed in blocks per tick with a movement key held. */
    static final double SPEED = 0.6;

    private static @Nullable Marker camera;
    private static @Nullable Vec3 frozenAt;
    private static @Nullable LocalPlayer frozen;

    /** Whether the camera is detached now. */
    public static boolean detached() {
        Minecraft mc = Minecraft.getInstance();
        return camera != null && mc.getCameraEntity() == camera;
    }

    /** Where the player is held (null when not frozen). */
    public static @Nullable Vec3 frozenAt() {
        return frozenAt;
    }

    static void detach() {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer p = mc.player;
        if (p == null || mc.level == null) return;
        if (frozen != p) {
            frozen = p;
            frozenAt = p.position();
        }
        if (camera == null || camera.level() != mc.level) {
            Marker m = new Marker(EntityType.MARKER, mc.level);
            Vec3 eye = p.getEyePosition();
            m.moveTo(eye.x, eye.y, eye.z, p.getYRot(), p.getXRot());
            m.xo = m.getX();
            m.yo = m.getY();
            m.zo = m.getZ();
            camera = m;
        }
        mc.setCameraEntity(camera);
    }

    static void restore() {
        Minecraft mc = Minecraft.getInstance();
        LocalPlayer p = mc.player;
        if (p != null) {
            if (p == frozen && frozenAt != null) hold(p);
            mc.setCameraEntity(p);
        }
        camera = null;
        frozen = null;
        frozenAt = null;
    }

    /** Client tick while a replay is open: re-detach after a respawn or dimension change, and fly the camera. */
    static void tick() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null || mc.level == null) return;
        if (camera == null || camera.level() != mc.level || frozen != mc.player || mc.getCameraEntity() != camera) detach();
        Marker m = camera;
        if (m == null) return;
        m.xo = m.getX();
        m.yo = m.getY();
        m.zo = m.getZ();
        m.setYRot(mc.player.getYRot());
        m.setXRot(mc.player.getXRot());
        if (mc.screen != null) return;
        double fwd = (mc.options.keyUp.isDown() ? 1 : 0) - (mc.options.keyDown.isDown() ? 1 : 0);
        double side = (mc.options.keyLeft.isDown() ? 1 : 0) - (mc.options.keyRight.isDown() ? 1 : 0);
        if (fwd == 0 && side == 0) return;
        Vec3 look = Vec3.directionFromRotation(m.getXRot(), m.getYRot());
        Vec3 left = Vec3.directionFromRotation(0, m.getYRot() - 90);
        Vec3 move = look.scale(fwd).add(left.scale(side));
        if (move.lengthSqr() > 0) move = move.normalize().scale(SPEED);
        m.setPos(m.getX() + move.x, m.getY() + move.y, m.getZ() + move.z);
    }

    private static void hold(LocalPlayer p) {
        Vec3 at = frozenAt;
        if (at == null) return;
        p.setPos(at.x, at.y, at.z);
        p.setDeltaMovement(Vec3.ZERO);
        p.fallDistance = 0;
    }

    /** The player stays put: undo this tick's movement before its position could be sent. */
    @SubscribeEvent
    static void playerTick(PlayerTickEvent.Post e) {
        if (e.getEntity() instanceof LocalPlayer p && p == frozen && ReplayClient.isOpen()) hold(p);
    }

    @SubscribeEvent
    static void angles(ViewportEvent.ComputeCameraAngles e) {
        Minecraft mc = Minecraft.getInstance();
        if (!detached() || mc.player == null) return;
        e.setYaw(mc.player.getYRot());
        e.setPitch(mc.player.getXRot());
    }

    /** No attacking or using during replay: the crosshair looks from the camera, at blocks that may exist only on the client. */
    @SubscribeEvent
    static void interact(InputEvent.InteractionKeyMappingTriggered e) {
        if (!ReplayClient.isOpen()) return;
        e.setCanceled(true);
        e.setSwingHand(false);
    }

    @SubscribeEvent
    static void hand(RenderHandEvent e) {
        if (detached()) e.setCanceled(true);
    }
}
