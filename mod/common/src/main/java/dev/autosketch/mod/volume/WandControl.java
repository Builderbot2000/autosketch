package dev.autosketch.mod.volume;

import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.WandMode;
import dev.autosketch.mod.feedback.Feedback;
import java.util.List;
import java.util.function.Supplier;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/**
 * The wand's clicks (13, *Work and context volumes in-game*): with the wand in the main hand, an op
 * sets corner 1 with a left click on a block and corner 2 with a right click, for the current mode,
 * and the swap-hands key cycles the mode. Each loader's events call these; a {@code true} result
 * means the loader cancels the click, so the wand never breaks, uses or places anything. Players
 * below op level 2 get the plain item's behaviour.
 */
public final class WandControl {
    private final PlayerStates players;
    private final Supplier<List<WandMode>> modes;
    private final Feedback feedback;

    public WandControl(PlayerStates players, Supplier<List<WandMode>> modes, Feedback feedback) {
        this.players = players;
        this.modes = modes;
        this.feedback = feedback;
    }

    private static boolean wielding(ServerPlayer p) {
        return Wand.isWand(p.getMainHandItem()) && p.hasPermissions(CommandExtension.OP_LEVEL);
    }

    /** The player's current mode (modes cycle in registration order). */
    public WandMode mode(ServerPlayer p) {
        List<WandMode> all = modes.get();
        return all.get(Math.floorMod(players.get(p.getUUID()).mode, all.size()));
    }

    /** Selects a mode by name; false if no mode has that name. */
    public boolean select(ServerPlayer p, String name) {
        List<WandMode> all = modes.get();
        for (int i = 0; i < all.size(); i++)
            if (all.get(i).name().equals(name)) {
                players.get(p.getUUID()).mode = i;
                return true;
            }
        return false;
    }

    /** A left click on a block; {@code start} is the click itself (not the held-down follow-ups). True: cancel it. */
    public boolean leftClick(ServerPlayer p, BlockPos pos, boolean start) {
        if (!wielding(p)) return false;
        if (start) mode(p).setCorner(p, 1, pos);
        return true;
    }

    /** A right click on a block, with the main hand or not. True: cancel it. */
    public boolean rightClick(ServerPlayer p, BlockPos pos, boolean mainHand) {
        if (!wielding(p)) return false;
        if (mainHand) mode(p).setCorner(p, 2, pos);
        return true;
    }

    /** The swap-hands key: cycles the mode. True: cancel the swap. */
    public boolean swapHands(ServerPlayer p) {
        if (!wielding(p)) return false;
        PlayerStates.State st = players.get(p.getUUID());
        st.mode = Math.floorMod(st.mode + 1, modes.get().size());
        feedback.actionBar(p, Component.literal("Autosketch wand: " + mode(p).name() + " mode"));
        return true;
    }
}
