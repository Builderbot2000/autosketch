package dev.autosketch.mod.ui.ghost;

import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.WandMode;
import dev.autosketch.mod.link.Link;
import dev.autosketch.mod.protocol.Box;
import java.util.List;
import java.util.function.BiPredicate;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/**
 * Anchored ghosts' server half (16, *Ghost blocks*: an unlinked document shown at an anchor the
 * player sets). {@code /autosketch ghost here} anchors it at the player's feet, {@code ghost clear}
 * removes it, and the wand's {@code ghost} mode anchors it on the clicked block (either click, at
 * the block above it, where the player would stand). Ghosts live in the player's client, so this
 * only hands the client half an action (relay op {@code CLIENT_ACTION}, 13, *Relay to the client*):
 * {@code ghost.here <dimension> <x> <y> <z>} or {@code ghost.clear}; the client sends the
 * {@code ghost.anchor} or {@code ghost.clear} request itself. Locked offline by {@code Link.lock}
 * like every subcommand, and behind {@link Link#requireUi} as a {@code 16} feature. Server thread.
 */
public final class GhostCommand implements CommandExtension {
    /** The line for a player whose client lacks the client half (a vanilla client). */
    public static final String NO_CLIENT_LINE = "Autosketch: ghosts need the Autosketch mod on your client";

    /** Sends an action to the player's client; false when the client lacks the channel. */
    private final BiPredicate<ServerPlayer, String> actions;

    public GhostCommand(BiPredicate<ServerPlayer, String> actions) {
        this.actions = actions;
    }

    /** The client action anchoring the document at {@code pos} in the player's dimension. */
    public static String hereAction(ServerPlayer p, BlockPos pos) {
        return "ghost.here " + p.level().dimension().location() + " " + pos.getX() + " " + pos.getY() + " " + pos.getZ();
    }

    @Override
    public void register(Registration reg) {
        reg.root().then(Commands.literal("ghost")
                .then(Commands.literal("here").executes(ctx -> {
                    ServerPlayer p = ctx.getSource().getPlayerOrException();
                    return send(ctx, hereAction(p, p.blockPosition()));
                }))
                .then(Commands.literal("clear").executes(ctx -> send(ctx, "ghost.clear"))));
    }

    private int send(CommandContext<CommandSourceStack> ctx, String action) throws CommandSyntaxException {
        CommandSourceStack src = ctx.getSource();
        if (!Link.requireUi(src)) return 0;
        ServerPlayer p = src.getPlayerOrException();
        if (!actions.test(p, action)) {
            src.sendFailure(Component.literal(NO_CLIENT_LINE));
            return 0;
        }
        return 1;
    }

    /** The wand's {@code ghost} mode: a click anchors the unlinked document on the clicked block. */
    public WandMode wandMode() {
        return new WandMode() {
            @Override
            public String name() {
                return "ghost";
            }

            @Override
            public int colour() {
                return 0xb0e0ff;
            }

            @Override
            public void setCorner(ServerPlayer player, int corner, BlockPos pos) {
                if (!Link.requireUi(player)) return;
                if (!actions.test(player, hereAction(player, pos.above())))
                    player.displayClientMessage(Component.literal(NO_CLIENT_LINE), true);
            }

            @Override
            public List<Box> outline(ServerPlayer player) {
                return List.of();
            }
        };
    }
}
