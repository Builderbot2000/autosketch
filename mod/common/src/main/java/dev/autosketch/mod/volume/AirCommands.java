package dev.autosketch.mod.volume;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.autosketch.mod.api.CommandExtension;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;

/** {@code /autosketch air on|off} and {@code /autosketch air reach <n>} (13, B2), per player. */
public final class AirCommands implements CommandExtension {
    private final AirMode air;

    public AirCommands(AirMode air) {
        this.air = air;
    }

    @Override
    public void register(Registration r) {
        r.root().then(Commands.literal("air")
                .executes(this::status)
                .then(Commands.literal("on").executes(c -> toggle(c, true)))
                .then(Commands.literal("off").executes(c -> toggle(c, false)))
                .then(Commands.literal("reach").then(Commands.argument("n", IntegerArgumentType.integer(1, AirMode.MAX_REACH)).executes(this::reach))));
    }

    private int status(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        ServerPlayer p = c.getSource().getPlayerOrException();
        c.getSource().sendSuccess(() -> Component.literal("Autosketch: air mode " + (air.on(p) ? "on" : "off") + ", distance " + air.reach(p)), false);
        return 1;
    }

    private int toggle(CommandContext<CommandSourceStack> c, boolean on) throws CommandSyntaxException {
        ServerPlayer p = c.getSource().getPlayerOrException();
        air.set(p, on);
        String how = on ? "air mode on: with the wand, right click into the air sets corner 2 and sneak+right click corner 1, "
                + air.reach(p) + " blocks ahead (/autosketch air reach <n>); with the client half, left click into the air sets corner 1 and sneak+scroll sets the distance"
                : "air mode off";
        c.getSource().sendSuccess(() -> Component.literal("Autosketch: " + how), false);
        return 1;
    }

    private int reach(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        ServerPlayer p = c.getSource().getPlayerOrException();
        air.setReach(p, IntegerArgumentType.getInteger(c, "n"));
        c.getSource().sendSuccess(() -> Component.literal("Autosketch: air distance " + air.reach(p)), false);
        return 1;
    }
}
