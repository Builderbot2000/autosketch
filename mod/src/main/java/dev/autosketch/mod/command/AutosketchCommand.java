package dev.autosketch.mod.command;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.api.PatchStatus;
import java.util.List;
import net.minecraft.commands.CommandBuildContext;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;

/**
 * {@code /autosketch} (13, *Work and context volumes in-game*, *Player feedback in-game*): the root
 * literal, op level 2, with every registered {@link CommandExtension}'s subcommands under it.
 */
public final class AutosketchCommand {
    private AutosketchCommand() {}

    public static final String ROOT = "autosketch";

    public static void register(CommandDispatcher<CommandSourceStack> dispatcher, CommandBuildContext context, List<CommandExtension> extensions) {
        LiteralArgumentBuilder<CommandSourceStack> root = Commands.literal(ROOT).requires(src -> src.hasPermission(CommandExtension.OP_LEVEL));
        root.then(Commands.literal("status").executes(AutosketchCommand::status));
        CommandExtension.Registration reg = new CommandExtension.Registration(root, dispatcher, context);
        for (CommandExtension e : extensions) e.register(reg);
        dispatcher.register(root);
    }

    private static int status(CommandContext<CommandSourceStack> ctx) {
        LinkVolumes v = Autosketch.link().current();
        String link = v == null ? "no work volume (unlinked)" : "link " + v.link() + ", work " + v.work() + " in " + v.dimension().location();
        String mcp = Autosketch.bridge().connected() ? "MCP connected" : "MCP not connected";
        PatchStatus ps = Autosketch.patchStatus();
        PatchStatus.Finished last = ps.last();
        String patches = ps.pending() + " pending" + (last == null ? "" : ", last #" + last.id() + ": " + last.applied() + " placed, " + last.skipped() + " skipped, " + last.rejected() + " rejected");
        ctx.getSource().sendSuccess(() -> Component.literal("Autosketch: " + mcp + "; " + link + "; patches " + patches), false);
        return 1;
    }
}
