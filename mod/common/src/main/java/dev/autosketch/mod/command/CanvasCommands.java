package dev.autosketch.mod.command;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.volume.CanvasManager;
import dev.autosketch.mod.volume.PlayerStates;
import dev.autosketch.mod.volume.VolumeManager;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;

/**
 * {@code /autosketch canvas here [radius]|grow <chunks>|clear|show} (19, *Setting the canvas*):
 * {@code here} sets the canvas to the square of chunks within {@code radius} (default
 * {@value #DEFAULT_RADIUS}) of the source's chunk, {@code grow} widens it by whole chunks on every
 * side, {@code clear} removes it (the volumes stay), and {@code show} lists it with its size in chunks
 * and turns the outlines on. Over {@code canvasChunks} across is refused. {@code here} works from the
 * console too, at the source's position.
 */
public final class CanvasCommands implements CommandExtension {
    public static final int DEFAULT_RADIUS = 16;

    private final CanvasManager canvas;
    private final PlayerStates players;

    public CanvasCommands(CanvasManager canvas, PlayerStates players) {
        this.canvas = canvas;
        this.players = players;
    }

    @Override
    public void register(Registration r) {
        LiteralArgumentBuilder<CommandSourceStack> root = r.root();
        root.then(Commands.literal("canvas")
                .then(Commands.literal("here")
                        .executes(c -> here(c, DEFAULT_RADIUS))
                        .then(Commands.argument("radius", IntegerArgumentType.integer(0, 255)).executes(c -> here(c, IntegerArgumentType.getInteger(c, "radius")))))
                .then(Commands.literal("grow").then(Commands.argument("chunks", IntegerArgumentType.integer(1, 256)).executes(this::grow)))
                .then(Commands.literal("clear").executes(this::clear))
                .then(Commands.literal("show").executes(this::show)));
    }

    private static int ok(CommandContext<CommandSourceStack> c, String text) {
        c.getSource().sendSuccess(() -> Component.literal("Autosketch: " + text), false);
        return 1;
    }

    private static int refused(CommandContext<CommandSourceStack> c, String text) {
        c.getSource().sendFailure(Component.literal("Autosketch: " + text));
        return 0;
    }

    private int here(CommandContext<CommandSourceStack> c, int radius) {
        BlockPos at = BlockPos.containing(c.getSource().getPosition());
        try {
            Box b = canvas.here(c.getSource().getLevel(), at, radius);
            return ok(c, "canvas " + CanvasManager.chunks(b) + " around chunk " + (at.getX() >> 4) + ", " + (at.getZ() >> 4));
        } catch (VolumeManager.Refused e) {
            return refused(c, e.getMessage());
        }
    }

    private int grow(CommandContext<CommandSourceStack> c) {
        try {
            Box b = canvas.grow(IntegerArgumentType.getInteger(c, "chunks"));
            return ok(c, "canvas grown to " + CanvasManager.chunks(b));
        } catch (VolumeManager.Refused e) {
            return refused(c, e.getMessage());
        }
    }

    private int clear(CommandContext<CommandSourceStack> c) {
        if (!canvas.clear()) return refused(c, "no canvas is set");
        return ok(c, "canvas cleared; the volumes stay");
    }

    private int show(CommandContext<CommandSourceStack> c) {
        Box b = canvas.box();
        if (b == null) return refused(c, "no canvas is set (/autosketch canvas here [radius], or mark one in canvas mode)");
        if (c.getSource().isPlayer()) players.get(c.getSource().getPlayer().getUUID()).show = true;
        return ok(c, "canvas " + CanvasManager.chunks(b) + " in " + canvas.dimension().location() + ": chunks " + (b.minX() >> 4) + ", " + (b.minZ() >> 4)
                + " to " + (b.maxX() >> 4) + ", " + (b.maxZ() >> 4) + " (blocks " + b + ")" + (c.getSource().isPlayer() ? "; outlines shown" : ""));
    }
}
