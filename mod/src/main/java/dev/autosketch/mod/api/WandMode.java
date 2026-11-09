package dev.autosketch.mod.api;

import dev.autosketch.mod.protocol.Box;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;

/**
 * One mode of the wand (13, *Work and context volumes in-game*), registered with
 * {@link AutosketchSetupEvent#wandModes}. N registers {@code work} and {@code context}; S registers
 * {@code focus}. The swap-hands key cycles modes in registration order, {@code /autosketch mode <name>}
 * selects one, and {@code /autosketch pos1|pos2} and left/right clicks call {@link #setCorner} on the
 * player's current mode. All methods run on the server thread.
 */
public interface WandMode {
    /** Lower-case name, used by {@code /autosketch mode} and on the action bar. */
    String name();

    /** Outline particle colour, {@code 0xRRGGBB}. */
    int colour();

    /**
     * Sets corner 1 (left click, {@code pos1}) or 2 (right click, {@code pos2}) of this mode's box at
     * {@code pos} in the player's current level. The mode decides what a complete box means (the work
     * mode relinks, the focus mode clips to the volumes) and tells the player.
     */
    void setCorner(ServerPlayer player, int corner, BlockPos pos);

    /** The boxes to outline in this mode's colour for this player, in the player's current level; may be empty. */
    List<Box> outline(ServerPlayer player);
}
