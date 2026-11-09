package dev.autosketch.mod.api;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import net.minecraft.commands.CommandBuildContext;
import net.minecraft.commands.CommandSourceStack;

/**
 * Adds subcommands under {@code /autosketch}, registered with {@link AutosketchSetupEvent#commands}.
 * Called once per command registration (every server start and {@code /reload}), on the server thread.
 * Silo S adds {@code ask}, {@code focus} and {@code log} this way; N's own {@code wand}, {@code mode},
 * {@code pos1}, ... use the same hook.
 */
@FunctionalInterface
public interface CommandExtension {
    void register(Registration registration);

    /**
     * What an extension builds on. {@code root} is the {@code /autosketch} literal, which already
     * requires op level 2 (13, *Connection*, "Permissions"): add subcommands with
     * {@code root.then(...)}. {@code dispatcher} is for a top-level alias (the configured short alias
     * for {@code ask}); an alias must apply {@link #OP_LEVEL} itself.
     */
    record Registration(LiteralArgumentBuilder<CommandSourceStack> root, CommandDispatcher<CommandSourceStack> dispatcher, CommandBuildContext context) {}

    /** The permission level every {@code /autosketch} command requires. */
    int OP_LEVEL = 2;
}
