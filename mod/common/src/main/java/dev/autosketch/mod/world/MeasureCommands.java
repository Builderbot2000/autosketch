package dev.autosketch.mod.world;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.context.CommandContext;
import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.CommandExtension;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;

/**
 * {@code /autosketch measure …}: seams for the headless world tier and 18's *Measure first* (step Z1),
 * which run against a server with no player. A select grant otherwise comes only from a player's
 * {@code /autosketch select} (piece 1), so:
 * <ul>
 * <li>{@code measure grant <x> <z> [radius]}: the select grant a select prompt at that position would
 * fix, in the source's dimension ({@code execute in <dim> run …}), radius clipped to
 * {@code selectChunks}. Console and RCON only: a player gets theirs from {@code select}.</li>
 * <li>{@code measure last}: the last search, fill, coarse, blocks and surface read's cost.</li>
 * <li>{@code measure slice <ms>}: the per-tick server time of search, fill, coarse and blocks reads
 * (default 5), to compare budgets. Console and RCON only.</li>
 * </ul>
 */
final class MeasureCommands {
    private MeasureCommands() {}

    static void register(CommandExtension.Registration r) {
        r.root().then(Commands.literal("measure")
                .then(Commands.literal("grant").requires(s -> !s.isPlayer())
                        .then(Commands.argument("x", IntegerArgumentType.integer()).then(Commands.argument("z", IntegerArgumentType.integer())
                                .executes(c -> grant(c, AutosketchConfig.get().select.selectChunks))
                                .then(Commands.argument("radius", IntegerArgumentType.integer(0, 256))
                                        .executes(c -> grant(c, IntegerArgumentType.getInteger(c, "radius")))))))
                .then(Commands.literal("slice").requires(s -> !s.isPlayer())
                        .then(Commands.argument("ms", IntegerArgumentType.integer(1, 50)).executes(MeasureCommands::slice)))
                .then(Commands.literal("last").executes(MeasureCommands::last)));
    }

    private static int grant(CommandContext<CommandSourceStack> c, int radius) {
        int x = IntegerArgumentType.getInteger(c, "x"), z = IntegerArgumentType.getInteger(c, "z");
        int rad = Math.min(radius, AutosketchConfig.get().select.selectChunks);
        SelectGrants.Grant g = SelectGrants.set(c.getSource().getLevel().dimension(), new BlockPos(x, 0, z), rad);
        c.getSource().sendSuccess(() -> Component.literal("Autosketch: select grant in " + g.dimension().location() + " around chunk " + g.centreX() + "," + g.centreZ() + ", radius " + g.radius()), false);
        return 1;
    }

    private static int slice(CommandContext<CommandSourceStack> c) {
        long nanos = IntegerArgumentType.getInteger(c, "ms") * 1_000_000L;
        MaterialSearch.sliceNanos = nanos;
        WorldFill.sliceNanos = nanos;
        CoarseReads.sliceNanos = nanos;
        WorldReads.sliceNanos = nanos;
        c.getSource().sendSuccess(() -> Component.literal("Autosketch: " + nanos / 1_000_000 + " ms per tick for search, fill, coarse and blocks reads"), false);
        return 1;
    }

    private static int last(CommandContext<CommandSourceStack> c) {
        String text = "search " + MaterialSearch.lastSearch + "\nfill " + WorldFill.lastFill + "\ncoarse " + CoarseReads.lastCoarse + "\nblocks "
                + WorldReads.lastRead + "\nsurface " + SurfaceReads.lastRead;
        c.getSource().sendSuccess(() -> Component.literal(text), false);
        return 1;
    }
}
