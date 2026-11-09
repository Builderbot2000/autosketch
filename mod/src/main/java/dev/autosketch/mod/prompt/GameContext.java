package dev.autosketch.mod.prompt;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Json;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import org.jetbrains.annotations.Nullable;

/**
 * The game context a request carries (13, *Wire format*, {@code prompt}, {@code context}), all in
 * world coordinates: the player's dimension, feet and eye position, yaw (wrapped to [−180, 180)) and
 * pitch, the horizontal facing, the block under the crosshair from a server-side raycast up to the
 * configured reach, and the focus box (already clipped). The MCP converts it to local handles.
 */
public final class GameContext {
    private GameContext() {}

    /** The crosshair block within {@code reach}, or null when the ray hits nothing (fluids are looked through). */
    public static @Nullable BlockHitResult target(ServerPlayer player, double reach) {
        Vec3 eye = player.getEyePosition();
        Vec3 end = eye.add(player.getViewVector(1.0f).scale(reach));
        BlockHitResult hit = player.level().clip(new ClipContext(eye, end, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
        return hit.getType() == HitResult.Type.BLOCK ? hit : null;
    }

    public static JsonObject capture(ServerPlayer player, double reach, @Nullable FocusClip.Result focus) {
        JsonObject c = new JsonObject();
        c.addProperty("dimension", player.level().dimension().location().toString());
        c.add("position", vec(player.position()));
        c.add("eye", vec(player.getEyePosition()));
        float yaw = Mth.wrapDegrees(player.getYRot());
        c.addProperty("yaw", yaw);
        c.addProperty("pitch", player.getXRot());
        c.addProperty("facing", Direction.fromYRot(yaw).getName());
        BlockHitResult hit = target(player, reach);
        if (hit != null) {
            BlockPos p = hit.getBlockPos();
            JsonObject t = new JsonObject();
            t.add("pos", Json.vec(p.getX(), p.getY(), p.getZ()));
            t.addProperty("state", BlockStates.canonical(player.level().getBlockState(p)));
            t.addProperty("face", hit.getDirection().getName());
            c.add("target", t);
        }
        if (focus != null) {
            Box b = focus.box();
            c.add("focus", b.toJson());
            if (focus.clipped()) c.addProperty("focusClipped", true);
        }
        return c;
    }

    private static JsonArray vec(Vec3 v) {
        JsonArray a = new JsonArray(3);
        a.add(v.x);
        a.add(v.y);
        a.add(v.z);
        return a;
    }
}
