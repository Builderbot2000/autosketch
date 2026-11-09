package dev.autosketch.mod.command;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.api.PatchStatus;
import dev.autosketch.mod.api.WandMode;
import dev.autosketch.mod.feedback.Feedback;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.volume.PlayerStates;
import dev.autosketch.mod.volume.VolumeManager;
import dev.autosketch.mod.volume.VolumeModes;
import dev.autosketch.mod.volume.Wand;
import dev.autosketch.mod.volume.WandEvents;
import java.util.List;
import java.util.function.Supplier;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.SharedSuggestionProvider;
import net.minecraft.commands.arguments.coordinates.BlockPosArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;

/**
 * Silo N's subcommands (13, *Work and context volumes in-game*, *Player feedback in-game*; M3):
 * {@code wand}, {@code mode}, {@code pos1}, {@code pos2}, {@code show}, {@code clear},
 * {@code status}, {@code notices on|off}, {@code context add|grow <n>|clear}.
 */
public final class VolumeCommands implements CommandExtension {
    private final VolumeManager volumes;
    private final PlayerStates players;
    private final WandEvents wand;
    private final VolumeModes.Context contextMode;
    private final Feedback feedback;
    private final Bridge bridge;
    private final Supplier<List<WandMode>> modes;
    private final Supplier<PatchStatus> patches;

    public VolumeCommands(VolumeManager volumes, PlayerStates players, WandEvents wand, VolumeModes.Context contextMode, Feedback feedback,
            Bridge bridge, Supplier<List<WandMode>> modes, Supplier<PatchStatus> patches) {
        this.volumes = volumes;
        this.players = players;
        this.wand = wand;
        this.contextMode = contextMode;
        this.feedback = feedback;
        this.bridge = bridge;
        this.modes = modes;
        this.patches = patches;
    }

    @Override
    public void register(Registration r) {
        LiteralArgumentBuilder<CommandSourceStack> root = r.root();
        root.then(Commands.literal("wand").executes(this::giveWand));
        root.then(Commands.literal("mode").then(Commands.argument("mode", StringArgumentType.word())
                .suggests((c, b) -> SharedSuggestionProvider.suggest(modes.get().stream().map(WandMode::name), b))
                .executes(this::mode)));
        for (int corner = 1; corner <= 2; corner++) {
            int k = corner;
            root.then(Commands.literal("pos" + k)
                    .executes(c -> pos(c, k, c.getSource().getPlayerOrException().blockPosition()))
                    .then(Commands.argument("pos", BlockPosArgument.blockPos()).executes(c -> pos(c, k, BlockPosArgument.getBlockPos(c, "pos")))));
        }
        root.then(Commands.literal("show").executes(this::show));
        root.then(Commands.literal("clear").executes(this::clear));
        root.then(Commands.literal("status").executes(this::status));
        root.then(Commands.literal("notices")
                .then(Commands.literal("on").executes(c -> notices(c, true)))
                .then(Commands.literal("off").executes(c -> notices(c, false))));
        root.then(Commands.literal("context")
                .then(Commands.literal("add").executes(this::contextAdd))
                .then(Commands.literal("grow").then(Commands.argument("n", IntegerArgumentType.integer(1, 256)).executes(this::contextGrow)))
                .then(Commands.literal("clear").executes(this::contextClear)));
    }

    private static int ok(CommandContext<CommandSourceStack> c, String text) {
        c.getSource().sendSuccess(() -> Component.literal("Autosketch: " + text), false);
        return 1;
    }

    private static int refused(CommandContext<CommandSourceStack> c, String text) {
        c.getSource().sendFailure(Component.literal("Autosketch: " + text));
        return 0;
    }

    private int giveWand(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        ServerPlayer p = c.getSource().getPlayerOrException();
        ItemStack stack = Wand.create();
        if (!p.getInventory().add(stack)) p.drop(stack, false);
        return ok(c, "wand given. Left and right click set corners; the swap-hands key cycles the mode (now " + wand.mode(p).name() + ").");
    }

    private int mode(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        ServerPlayer p = c.getSource().getPlayerOrException();
        String name = StringArgumentType.getString(c, "mode");
        if (!wand.select(p, name)) return refused(c, "no wand mode \"" + name + "\" (modes: " + String.join(", ", modes.get().stream().map(WandMode::name).toList()) + ")");
        feedback.actionBar(p, Component.literal("Autosketch wand: " + name + " mode"));
        return ok(c, name + " mode");
    }

    private int pos(CommandContext<CommandSourceStack> c, int corner, BlockPos pos) throws CommandSyntaxException {
        ServerPlayer p = c.getSource().getPlayerOrException();
        wand.mode(p).setCorner(p, corner, pos);
        return 1;
    }

    private int show(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        PlayerStates.State st = players.get(c.getSource().getPlayerOrException().getUUID());
        st.show = !st.show;
        return ok(c, st.show ? "outlines shown (run show again to hide)" : "outlines hidden (still shown while holding the wand)");
    }

    private int clear(CommandContext<CommandSourceStack> c) {
        if (volumes.work() == null) return refused(c, "no work volume is set");
        volumes.clear();
        return ok(c, "work volume cleared; the link is closed");
    }

    private int notices(CommandContext<CommandSourceStack> c, boolean on) throws CommandSyntaxException {
        players.get(c.getSource().getPlayerOrException().getUUID()).notices = on;
        return ok(c, "notices " + (on ? "on" : "off"));
    }

    private int contextAdd(CommandContext<CommandSourceStack> c) throws CommandSyntaxException {
        ServerPlayer p = c.getSource().getPlayerOrException();
        Box b = contextMode.marked(p);
        if (b == null) return refused(c, "mark a box in context mode first (/autosketch mode context, then left and right click)");
        try {
            volumes.contextAdd(p.serverLevel(), b);
        } catch (VolumeManager.Refused e) {
            return refused(c, e.getMessage());
        }
        contextMode.clearMarked(p);
        return ok(c, "context box " + VolumeModes.size(b) + " added (" + volumes.current().context().size() + " boxes)");
    }

    private int contextGrow(CommandContext<CommandSourceStack> c) {
        int n = IntegerArgumentType.getInteger(c, "n");
        try {
            volumes.contextGrow(c.getSource().getLevel(), n);
        } catch (VolumeManager.Refused e) {
            return refused(c, e.getMessage());
        }
        return ok(c, "context is the work volume grown by " + n);
    }

    private int contextClear(CommandContext<CommandSourceStack> c) {
        volumes.contextClear();
        return ok(c, "context back to the default (work volume grown by " + VolumeManager.DEFAULT_GROW + ")");
    }

    private int status(CommandContext<CommandSourceStack> c) {
        LinkVolumes v = volumes.current();
        String mcp = bridge.connected() ? "MCP connected (" + bridge.session().clientName() + " " + bridge.session().clientVersion() + ")" : "MCP not connected";
        c.getSource().sendSuccess(() -> Component.literal("Autosketch: " + mcp).withStyle(bridge.connected() ? ChatFormatting.GREEN : ChatFormatting.YELLOW), false);
        if (v == null) c.getSource().sendSuccess(() -> Component.literal("  no work volume (unlinked)"), false);
        else {
            c.getSource().sendSuccess(() -> Component.literal("  link " + v.link() + " in " + v.dimension().location() + ": work " + v.work() + " (" + VolumeModes.size(v.work()) + ")"
                    + (v.extended() == null ? "" : ", extended to " + v.extended() + " (" + VolumeModes.size(v.extended()) + ")")), false);
            long total = v.context().stream().mapToLong(Box::volume).sum();
            c.getSource().sendSuccess(() -> Component.literal(String.format("  context: %d box(es), %,d blocks; grown by %d", v.context().size(), total, volumes.grow())), false);
        }
        PatchStatus ps = patches.get();
        PatchStatus.Finished last = ps.last();
        c.getSource().sendSuccess(() -> Component.literal("  patches: " + ps.pending() + " pending" + (last == null ? ", none finished yet" : "; last #" + last.id() + ": " + Feedback.patchLine(last).substring("Autosketch: ".length()))), false);
        return 1;
    }
}
