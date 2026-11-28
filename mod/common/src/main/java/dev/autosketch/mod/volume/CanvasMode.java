package dev.autosketch.mod.volume;

import dev.autosketch.mod.api.WandMode;
import dev.autosketch.mod.feedback.Feedback;
import dev.autosketch.mod.protocol.Box;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/**
 * The wand's {@code canvas} mode (19, *Setting the canvas*), after {@code work} and {@code context}:
 * left and right click mark two corners, and both set make the canvas, widened to whole chunk columns
 * and the full build height (over {@code canvasChunks} across: refused). Its outline is the canvas and
 * a half-marked or marked box, widened as it would be; the overlay draws it faint, with a chunk grid
 * while the wand is held ({@link dev.autosketch.mod.feedback.VolumeOutlines.Entry#faint}).
 */
public final class CanvasMode implements WandMode {
    /** A pale yellow, distinct from work's green and context's blue. */
    public static final int COLOUR = 0xE8D86A;

    private final CanvasManager canvas;
    private final PlayerStates players;
    private final Feedback feedback;

    public CanvasMode(CanvasManager canvas, PlayerStates players, Feedback feedback) {
        this.canvas = canvas;
        this.players = players;
        this.feedback = feedback;
    }

    @Override
    public String name() {
        return "canvas";
    }

    @Override
    public int colour() {
        return COLOUR;
    }

    @Override
    public void setCorner(ServerPlayer player, int corner, BlockPos pos) {
        PlayerStates.Corners c = players.get(player.getUUID()).canvas;
        if (!c.set(player.serverLevel().dimension(), corner, pos)) {
            feedback.actionBar(player, Component.literal("Autosketch: canvas corner " + corner + " at " + VolumeModes.at(pos) + " (chunk " + (pos.getX() >> 4) + ", " + (pos.getZ() >> 4) + ")"));
            return;
        }
        try {
            Box b = canvas.set(player.serverLevel(), Box.of(c.first, c.second));
            c.clear();
            feedback.actionBar(player, Component.literal("Autosketch: canvas " + CanvasManager.chunks(b)));
        } catch (VolumeManager.Refused e) {
            player.sendSystemMessage(Component.literal("Autosketch: " + e.getMessage()).withStyle(ChatFormatting.RED));
        }
    }

    @Override
    public List<Box> outline(ServerPlayer player) {
        List<Box> out = new ArrayList<>();
        Box b = canvas.box();
        if (b != null && player.serverLevel().dimension().equals(canvas.dimension())) out.add(b);
        PlayerStates.Corners c = players.get(player.getUUID()).canvas;
        if (player.serverLevel().dimension().equals(c.dimension)) {
            BlockPos a = c.first != null ? c.first : c.second, z = c.second != null ? c.second : c.first;
            if (a != null) out.add(CanvasManager.widen(player.serverLevel(), Box.of(a, z)));
        }
        return out;
    }
}
