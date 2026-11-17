package dev.autosketch.mod.ui.replay;

import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.link.Link;
import java.util.function.BiPredicate;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/**
 * {@code /autosketch replay} (16, *Replay in the world*): {@code replay} lists the workspace's
 * session logs, {@code replay <log>} opens one, {@code replay live} opens the running session,
 * {@code replay close} closes the open replay. Replay lives in the player's client, so the command
 * only hands the action to the client half (relay op {@code CLIENT_ACTION}, 13, *Relay to the
 * client*), which sends the {@code ui.request} itself. Locked offline by {@code Link.lock} like every
 * subcommand, and behind {@link Link#requireUi} since it is a {@code 16} feature.
 */
public final class ReplayCommand implements CommandExtension {
    /** The line for a player whose client lacks the client half (a vanilla client). */
    public static final String NO_CLIENT_LINE = "Autosketch: replay needs the Autosketch mod on your client";

    /** Sends an action to the player's client; false when the client lacks the channel. */
    private final BiPredicate<ServerPlayer, String> actions;

    public ReplayCommand(BiPredicate<ServerPlayer, String> actions) {
        this.actions = actions;
    }

    @Override
    public void register(Registration reg) {
        reg.root().then(Commands.literal("replay")
                .executes(ctx -> send(ctx, "replay.list"))
                .then(Commands.literal("live").executes(ctx -> send(ctx, "replay.open")))
                .then(Commands.literal("close").executes(ctx -> send(ctx, "replay.close")))
                .then(Commands.argument("log", StringArgumentType.greedyString())
                        .executes(ctx -> send(ctx, "replay.open " + StringArgumentType.getString(ctx, "log")))));
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
}
