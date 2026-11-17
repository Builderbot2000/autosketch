package dev.autosketch.mod.volume;

import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.WandMode;
import dev.autosketch.mod.feedback.Feedback;
import dev.autosketch.mod.link.Link;
import dev.autosketch.mod.link.LinkStatus;
import dev.autosketch.mod.platform.Platform;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Air mode (13, B2): corners marked in open space, at a point in front of the eye along the look
 * vector, the way angel blocks place. Per player, toggled with {@code /autosketch air on|off}.
 *
 * <p>Two paths set a corner. <b>Without the client half</b> (any client): a right click into the air
 * reaches the server as a use of the item, so right click sets corner 2 and sneak+right click corner
 * 1, at the distance {@code /autosketch air reach <n>} set. <b>With the client half</b>, the client
 * also sends left clicks into the air (which never reach the server otherwise) as corner 1, and
 * sneak+scroll changes the distance; both arrive here through {@link #clientClick}. The point is
 * always computed on the server from the player's own eye and look, so the client only chooses the
 * distance. Server thread only.
 */
public final class AirMode {
    public static final int DEFAULT_REACH = 5, MAX_REACH = 64;

    private final PlayerStates players;
    private final Feedback feedback;
    private final java.util.function.Function<ServerPlayer, WandMode> mode;

    public AirMode(PlayerStates players, java.util.function.Function<ServerPlayer, WandMode> mode, Feedback feedback) {
        this.players = players;
        this.mode = mode;
        this.feedback = feedback;
    }

    public boolean on(ServerPlayer p) {
        return players.get(p.getUUID()).air;
    }

    public int reach(ServerPlayer p) {
        return players.get(p.getUUID()).airReach;
    }

    /** {@code /autosketch air on|off}. */
    public void set(ServerPlayer p, boolean on) {
        players.get(p.getUUID()).air = on;
        sync(p);
    }

    /** {@code /autosketch air reach <n>}, and the client half's sneak+scroll; clamped to 1…{@link #MAX_REACH}. */
    public void setReach(ServerPlayer p, int reach) {
        players.get(p.getUUID()).airReach = Math.max(1, Math.min(MAX_REACH, reach));
        sync(p);
    }

    /** Tells the player's client half (if it has one) the air state, so it previews the point and handles scroll. */
    public void sync(ServerPlayer p) {
        Platform.get().sendAirState(p, on(p), reach(p), Wand.itemId());
    }

    /** The air point: the block containing the point {@code reach} blocks along the look vector from the eye. */
    public static BlockPos point(ServerPlayer p, int reach) {
        Vec3 at = p.getEyePosition().add(p.getViewVector(1.0f).scale(reach));
        return BlockPos.containing(at);
    }

    private static boolean wielding(ServerPlayer p) {
        return Wand.isWand(p.getMainHandItem()) && p.hasPermissions(CommandExtension.OP_LEVEL);
    }

    /**
     * A use of the item with no block targeted (NeoForge's {@code RightClickItem}): with air mode on and
     * the wand in the main hand, sets corner 2 (corner 1 when sneaking) at the air point. A block within
     * the player's interaction range means the use follows a click on that block, which the block click
     * already handled, so it is left alone. True: cancel the use.
     */
    public boolean rightClickAir(ServerPlayer p, boolean mainHand) {
        if (!wielding(p) || !on(p)) return false;
        if (!mainHand) return true;
        if (looksAtBlock(p)) return true;
        if (!Link.requireConnected(p)) return true;
        setCorner(p, p.isShiftKeyDown() ? 1 : 2, reach(p));
        return true;
    }

    /**
     * The client half's message: {@code corner} 1 for a left click into the air, 0 for a distance change
     * only. The distance is the client's, clamped.
     */
    public void clientClick(ServerPlayer p, int corner, int reach) {
        if (!p.hasPermissions(CommandExtension.OP_LEVEL) || !Link.requireConnected(p)) return;
        players.get(p.getUUID()).airReach = Math.max(1, Math.min(MAX_REACH, reach));
        if (corner == 0) {
            feedback.actionBar(p, Component.literal("Autosketch: air distance " + reach(p)));
            return;
        }
        if (!wielding(p) || !on(p) || corner < 1 || corner > 2 || looksAtBlock(p)) return;
        setCorner(p, corner, reach(p));
    }

    /** Preview colour of the air point (white), for clients without the client half. */
    public static final int PREVIEW_COLOUR = 0xFFFFFF;

    /**
     * Every few ticks: for players in air mode holding the wand whose client has no client half, the
     * air point as a particle outline (the client half draws its own).
     */
    public void tick(net.minecraft.server.MinecraftServer server) {
        if (server.getTickCount() % Feedback.OUTLINE_PERIOD != 0 || Link.status() == LinkStatus.OFFLINE) return;
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            if (!on(p) || !wielding(p) || Platform.get().hasClientHalf(p)) continue;
            BlockPos at = point(p, reach(p));
            Feedback.outline(p, PREVIEW_COLOUR, new dev.autosketch.mod.protocol.Box(at.getX(), at.getY(), at.getZ(), at.getX(), at.getY(), at.getZ()));
        }
    }

    private void setCorner(ServerPlayer p, int corner, int reach) {
        mode.apply(p).setCorner(p, corner, point(p, reach));
    }

    private static boolean looksAtBlock(ServerPlayer p) {
        Vec3 eye = p.getEyePosition();
        Vec3 end = eye.add(p.getViewVector(1.0f).scale(p.blockInteractionRange()));
        return p.level().clip(new ClipContext(eye, end, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, p)).getType() == HitResult.Type.BLOCK;
    }
}
