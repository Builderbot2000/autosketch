package dev.autosketch.mod.link;

import com.mojang.brigadier.Command;
import com.mojang.brigadier.builder.ArgumentBuilder;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.tree.CommandNode;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.protocol.Messages;
import java.util.List;
import java.util.Set;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.jetbrains.annotations.Nullable;

/**
 * The offline lock, in one place (16, *Mod side*: <i>The whole mod is locked while the MCP is
 * offline</i>, <i>An MCP that is connected but older</i>). Every gate in the mod calls
 * {@link #requireConnected} (today's features: the wand, air mode, every {@code /autosketch}
 * subcommand but {@code status}) or {@link #requireUi} ({@code 16}'s in-game UI); each sends the one
 * action-bar line and returns false, so nothing else re-implements the message. The status comes
 * from {@link Autosketch#bridge()}, so a test's stand-in bridge counts. The client half is told the
 * status on every change and on join ({@link #publish}, {@link #sendTo}). Server thread only.
 */
public final class Link {
    private Link() {}

    /** The action-bar line while no MCP is connected. */
    public static final String OFFLINE_LINE = "Autosketch: the Autosketch MCP isn't connected (/autosketch status)";
    /** The action-bar line for {@code 16}'s features while the MCP lacks {@code ui}. */
    public static final String TOO_OLD_LINE = "Autosketch: the Autosketch MCP is too old for the in-game UI; update the Autosketch MCP server";

    /** Subcommands of {@code /autosketch} that work offline: only what lets the player check on the link. */
    public static final Set<String> UNLOCKED = Set.of("status");

    public static LinkStatus status() {
        return LinkStatus.of(Autosketch.bridge());
    }

    /** True when an MCP is connected; otherwise shows {@link #OFFLINE_LINE} to the player and returns false. */
    public static boolean requireConnected(ServerPlayer player) {
        if (status() != LinkStatus.OFFLINE) return true;
        show(player, OFFLINE_LINE);
        return false;
    }

    /** As {@link #requireConnected(ServerPlayer)} for a command source; a source that isn't a player (console, RCON) gets the line as a failure. */
    public static boolean requireConnected(CommandSourceStack source) {
        if (status() != LinkStatus.OFFLINE) return true;
        refuse(source, OFFLINE_LINE);
        return false;
    }

    /** True when the MCP lists {@code ui}; otherwise shows the offline or too-old line and returns false. */
    public static boolean requireUi(CommandSourceStack source) {
        LinkStatus s = status();
        if (s == LinkStatus.CONNECTED) return true;
        refuse(source, s == LinkStatus.OFFLINE ? OFFLINE_LINE : TOO_OLD_LINE);
        return false;
    }

    /** As {@link #requireUi(CommandSourceStack)} for a player (a client half's request). */
    public static boolean requireUi(ServerPlayer player) {
        LinkStatus s = status();
        if (s == LinkStatus.CONNECTED) return true;
        show(player, s == LinkStatus.OFFLINE ? OFFLINE_LINE : TOO_OLD_LINE);
        return false;
    }

    private static void refuse(CommandSourceStack source, String line) {
        ServerPlayer p = source.getPlayer();
        if (p != null) show(p, line);
        else source.sendFailure(Component.literal(line));
    }

    /** Where the lock's action-bar lines go; GameTests swap in a recorder. */
    public interface Output {
        void actionBar(ServerPlayer player, Component line);
    }

    private static volatile Output output = (p, line) -> p.displayClientMessage(line, true);

    /** Installs an output and returns the previous one (GameTests only). */
    public static Output setOutput(Output o) {
        Output old = output;
        output = o;
        return old;
    }

    private static void show(ServerPlayer player, String line) {
        output.actionBar(player, Component.literal(line));
    }

    /**
     * The status line {@code /autosketch status} shows: the link state, and for {@code too_old} the
     * MCP's protocol and features (the mod pairs only with its own protocol, so it is this build's).
     */
    public static String statusLine() {
        LinkStatus s = status();
        return switch (s) {
            case OFFLINE -> "link state: offline (the mod is locked until the Autosketch MCP connects; volumes already marked are kept)";
            case CONNECTED -> "link state: connected";
            case TOO_OLD -> {
                var session = Autosketch.bridge().session();
                List<String> features = session == null ? List.of() : session.features();
                yield "link state: too_old (MCP protocol " + Messages.PROTOCOL_VERSION + ", features " + (features.isEmpty() ? "none" : String.join(", ", features))
                        + "; the in-game UI needs \"" + LinkStatus.FEATURE_UI + "\": update the Autosketch MCP server)";
            }
        };
    }

    // ── commands ──────────────────────────────────────────────────────────────────────────────

    /**
     * {@code root} with every subcommand behind {@link #requireConnected(CommandSourceStack)}, except
     * {@link #UNLOCKED} ones. Applied to {@code /autosketch} and the request alias once all
     * extensions have registered, so a silo's new subcommand is locked offline without a line of its own.
     */
    public static LiteralArgumentBuilder<CommandSourceStack> lock(LiteralArgumentBuilder<CommandSourceStack> root) {
        LiteralArgumentBuilder<CommandSourceStack> out = LiteralArgumentBuilder.<CommandSourceStack>literal(root.getLiteral()).requires(root.getRequirement());
        if (root.getCommand() != null) out.executes(gate(root.getCommand()));
        for (CommandNode<CommandSourceStack> child : root.getArguments())
            out.then(UNLOCKED.contains(child.getName()) ? child : copy(child));
        return out;
    }

    private static CommandNode<CommandSourceStack> copy(CommandNode<CommandSourceStack> node) {
        ArgumentBuilder<CommandSourceStack, ?> b = node.createBuilder();
        if (node.getCommand() != null) b.executes(gate(node.getCommand()));
        if (node.getRedirect() == null) for (CommandNode<CommandSourceStack> child : node.getChildren()) b.then(copy(child));
        return b.build();
    }

    private static Command<CommandSourceStack> gate(Command<CommandSourceStack> command) {
        return ctx -> requireConnected(ctx.getSource()) ? command.run(ctx) : 0;
    }

    // ── telling the client half ───────────────────────────────────────────────────────────────

    private static @Nullable LinkStatus lastPublished;

    /** Sends the status to every player when it changed since the last publish (bridge connect and disconnect). */
    public static void publish(MinecraftServer server) {
        LinkStatus s = status();
        if (s == lastPublished) return;
        lastPublished = s;
        for (ServerPlayer p : server.getPlayerList().getPlayers()) Platform.get().sendLinkStatus(p, s);
    }

    /** Sends the current status to one player (on join). */
    public static void sendTo(ServerPlayer player) {
        Platform.get().sendLinkStatus(player, status());
    }

    /** Server start: forget the last published status. */
    public static void reset() {
        lastPublished = null;
    }

    /** Registers {@link #publish} on the bridge's connection events. */
    public static void watch(Bridge bridge) {
        bridge.addListener(new Bridge.Listener() {
            @Override
            public void connected(dev.autosketch.mod.api.BridgeSession session) {
                MinecraftServer s = Platform.get().currentServer();
                if (s != null) publish(s);
            }

            @Override
            public void disconnected(dev.autosketch.mod.api.BridgeSession session) {
                MinecraftServer s = Platform.get().currentServer();
                if (s != null) publish(s);
            }
        });
    }
}
