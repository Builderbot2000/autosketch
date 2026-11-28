package dev.autosketch.mod.command;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.RequestMessages;
import dev.autosketch.mod.protocol.RequestMessages.RequestControl;
import dev.autosketch.mod.prompt.InGamePrompts;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import org.jetbrains.annotations.Nullable;

/**
 * Request control from the server half (19, *Stop*, *Queueing*; 13, {@code request.control}):
 * {@code /autosketch stop}, {@code /autosketch queue} and {@code /autosketch queue cancel <n>}, also
 * under the alias. Op level 2 like every subcommand (so the request's own player or any op), locked
 * offline by {@code Link.lock}. Each sends {@code request.control} and nothing else: the MCP owns the
 * requests and the queue and answers with a {@code notice} ({@code stop}, {@code queue.cancel}) or a
 * {@code chat} reply ({@code queue}). They run on the server half, so a vanilla client can use them.
 * An MCP whose hello doesn't list {@code requests} is too old for them: the player is told so on the
 * action bar and nothing is sent (13, *Versions and features*).
 */
public final class RequestCommands {
    private RequestCommands() {}

    /** The action-bar line for an MCP whose hello doesn't list {@code requests}. */
    public static final String UNSUPPORTED = "Autosketch: not sent: the Autosketch MCP server is too old for /autosketch stop and queue (update it)";

    /** The action-bar line once a stop went out; the MCP's notice follows. */
    public static final String STOPPING = "Autosketch: stopping the request…";

    /** Adds {@code stop} and {@code queue [cancel <n>]} under {@code root} ({@code /autosketch} or the alias). */
    public static void register(LiteralArgumentBuilder<CommandSourceStack> root) {
        root.then(Commands.literal("stop").executes(ctx -> control(ctx.getSource().getPlayerOrException(), "stop", null, Autosketch.bridge())));
        root.then(Commands.literal("queue")
                .executes(ctx -> control(ctx.getSource().getPlayerOrException(), "queue", null, Autosketch.bridge()))
                .then(Commands.literal("cancel").then(Commands.argument("n", IntegerArgumentType.integer(1))
                        .executes(ctx -> control(ctx.getSource().getPlayerOrException(), "queue.cancel", IntegerArgumentType.getInteger(ctx, "n"), Autosketch.bridge())))));
    }

    /** The command {@code /autosketch queue cancel <n>}, as a plain status line's hint names it. */
    public static String cancelCommand(int position) {
        return "/autosketch queue cancel " + position;
    }

    /** The command {@code /autosketch stop}. */
    public static final String STOP_COMMAND = "/autosketch stop";

    /**
     * Sends one {@code request.control}. Returns the command result (1 sent, 0 not). Without a
     * connection the player hears {@code no_link}; an MCP without {@code requests} gets nothing.
     */
    public static int control(ServerPlayer player, String action, @Nullable Integer position, Bridge bridge) {
        InGamePrompts.Output out = InGamePrompts.output();
        if (!bridge.connected()) {
            out.actionBar(player, InGamePrompts.refusal("no_link"));
            return 0;
        }
        BridgeSession session = bridge.session();
        if (session == null || !session.features().contains(RequestMessages.FEATURE_REQUESTS)) {
            out.actionBar(player, Component.literal(UNSUPPORTED).withStyle(ChatFormatting.RED));
            return 0;
        }
        Messages.Player who = new Messages.Player(player.getGameProfile().getName(), player.getUUID());
        if (!bridge.send(new RequestControl(who, action, position).encode())) {
            out.actionBar(player, InGamePrompts.refusal("no_link"));
            return 0;
        }
        if (action.equals("stop")) out.actionBar(player, Component.literal(STOPPING).withStyle(ChatFormatting.GRAY));
        return 1;
    }
}
