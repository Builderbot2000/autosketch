package dev.autosketch.mod.ui;

import com.mojang.brigadier.arguments.LongArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.link.Link;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.prompt.InGamePrompts;
import java.util.function.BiPredicate;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/**
 * {@code /autosketch action <n>} (17, piece 3; 13, {@code chat}): what a clickable reply line runs.
 * The server half keeps each reply's action under a number ({@link InGamePrompts#action}) and hands
 * it to the player's client as the client action {@code chat.action <kind> <args JSON>} (relay op
 * {@code CLIENT_ACTION}, as replay's log lines do), and the client half sends the {@code ui.request}
 * itself. Locked offline by {@code Link.lock} like every subcommand, and behind
 * {@link Link#requireUi}. Never references client classes.
 */
public final class ReplyActionCommand implements CommandExtension {
    /** The client action's name. */
    public static final String ACTION = "chat.action";

    /** The line for a player whose client lacks the client half (a vanilla client). */
    public static final String NO_CLIENT_LINE = "Autosketch: that line needs the Autosketch mod on your client";

    /** The line for a number nothing is kept under (the server restarted, or too many replies since). */
    public static final String EXPIRED_LINE = "Autosketch: that line has expired; ask the agent to send it again";

    /** Sends an action to the player's client; false when the client lacks the channel. */
    private final BiPredicate<ServerPlayer, String> actions;

    public ReplyActionCommand(BiPredicate<ServerPlayer, String> actions) {
        this.actions = actions;
    }

    /** The client action text for a reply-line action. */
    public static String clientAction(Messages.ChatAction a) {
        return ACTION + " " + a.kind() + " " + Json.write(a.args());
    }

    @Override
    public void register(Registration reg) {
        reg.root().then(Commands.literal("action").then(Commands.argument("n", LongArgumentType.longArg(1))
                .executes(ctx -> send(ctx, LongArgumentType.getLong(ctx, "n")))));
    }

    private int send(CommandContext<CommandSourceStack> ctx, long n) throws CommandSyntaxException {
        CommandSourceStack src = ctx.getSource();
        if (!Link.requireUi(src)) return 0;
        ServerPlayer p = src.getPlayerOrException();
        Messages.ChatAction a = InGamePrompts.action(n);
        if (a == null) {
            src.sendFailure(Component.literal(EXPIRED_LINE));
            return 0;
        }
        if (!actions.test(p, clientAction(a))) {
            src.sendFailure(Component.literal(NO_CLIENT_LINE));
            return 0;
        }
        return 1;
    }
}
