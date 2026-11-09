package dev.autosketch.mod.command;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import dev.autosketch.mod.api.CommandExtension;
import java.util.List;
import net.minecraft.commands.CommandBuildContext;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;

/**
 * {@code /autosketch} (13, *Work and context volumes in-game*, *Player feedback in-game*): the root
 * literal, op level 2, with every registered {@link CommandExtension}'s subcommands under it
 * (silo N's own in {@link VolumeCommands}).
 */
public final class AutosketchCommand {
    private AutosketchCommand() {}

    public static final String ROOT = "autosketch";

    public static void register(CommandDispatcher<CommandSourceStack> dispatcher, CommandBuildContext context, List<CommandExtension> extensions) {
        LiteralArgumentBuilder<CommandSourceStack> root = Commands.literal(ROOT).requires(src -> src.hasPermission(CommandExtension.OP_LEVEL));
        CommandExtension.Registration reg = new CommandExtension.Registration(root, dispatcher, context);
        for (CommandExtension e : extensions) e.register(reg);
        dispatcher.register(root);
    }
}
