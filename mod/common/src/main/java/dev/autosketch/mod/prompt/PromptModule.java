package dev.autosketch.mod.prompt;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.logging.LogUtils;
import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetup;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.WandMode;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.prompt.ChatRules.LogMode;
import java.util.List;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import org.slf4j.Logger;

/**
 * Registers in-game requests (13, *Prompting from the game*, M13) through the skeleton's hooks:
 * {@code /autosketch ask|plan|build <text>} (B6: the subcommand names the request's mode; the
 * configured alias is a short root for them), {@code /autosketch done} (B6: the player ends the open
 * read-only request), {@code /autosketch select [text]} (18, piece 1), {@code /autosketch focus clear},
 * {@code /autosketch log off|mine|all}, {@code /autosketch stop|queue} (19, {@link
 * dev.autosketch.mod.command.RequestCommands}), the wand's {@code focus} mode, and the handlers for
 * {@code prompt.result} and {@code chat} (status lines included, {@link StatusLines}). Each loader's setup event calls {@link #setup} (on
 * NeoForge, {@code PromptEvents}).
 */
public final class PromptModule {
    private PromptModule() {}

    private static final Logger LOG = LogUtils.getLogger();

    /** The focus mode's outline colour (gold), distinct from work and context. */
    public static final int FOCUS_COLOUR = 0xFFC233;

    public static void setup(AutosketchSetup e) {
        e.messages().register("prompt.result", (m, x) -> {
            var server = Platform.get().currentServer();
            if (server != null) InGamePrompts.onResult(m.header(), server);
        });
        e.messages().register("chat", (m, x) -> {
            var server = Platform.get().currentServer();
            if (server == null) return;
            // 19: a status line (feature requests) has its own handling; the hello lists requests because of it.
            if (dev.autosketch.mod.protocol.RequestMessages.isStatus(m.frame())) StatusLines.onStatus(dev.autosketch.mod.protocol.RequestMessages.Status.decode(m.frame()), server);
            else InGamePrompts.onChat(dev.autosketch.mod.protocol.Messages.Chat.decode(m.frame()), server);
        });
        // 18, piece 7, *Folding*: the hello lists choices.fold because of this handler.
        e.messages().register("choices.answered", (m, x) -> {
            var server = Platform.get().currentServer();
            if (server != null) ChoiceLines.onAnswered(dev.autosketch.mod.protocol.Messages.ChoicesAnswered.decode(m.frame()), server);
        });
        Autosketch.bridge().addListener(new dev.autosketch.mod.api.Bridge.Listener() {
            @Override
            public void disconnected(dev.autosketch.mod.api.BridgeSession session) {
                StatusLines.reset();
            }
        });
        e.commands(PromptModule::commands);
        e.wandModes(FOCUS_MODE);
    }

    public static final WandMode FOCUS_MODE = new WandMode() {
        @Override
        public String name() {
            return "focus";
        }

        @Override
        public int colour() {
            return FOCUS_COLOUR;
        }

        @Override
        public void setCorner(ServerPlayer player, int corner, BlockPos pos) {
            InGamePrompts.setFocusCorner(player, corner, pos);
        }

        @Override
        public List<Box> outline(ServerPlayer player) {
            FocusClip.Result f = InGamePrompts.focus(player);
            return f == null ? List.of() : List.of(f.box());
        }
    };

    static void commands(CommandExtension.Registration r) {
        requests(r.root());
        r.root().then(Commands.literal("focus").then(Commands.literal("clear").executes(ctx -> {
            boolean had = InGamePrompts.clearFocus(ctx.getSource().getPlayerOrException());
            ctx.getSource().sendSuccess(() -> Component.literal(had ? "Autosketch: focus box cleared" : "Autosketch: no focus box was set"), false);
            return had ? 1 : 0;
        })));
        LiteralArgumentBuilder<CommandSourceStack> log = Commands.literal("log").executes(ctx -> {
            LogMode m = InGamePrompts.logMode(ctx.getSource().getPlayerOrException());
            ctx.getSource().sendSuccess(() -> Component.literal("Autosketch: log " + m.id() + " (off: nothing but replies to you; mine: activity after your requests; all: everything the agent does on the linked document)"), false);
            return 1;
        });
        for (LogMode m : LogMode.values())
            log.then(Commands.literal(m.id()).executes(ctx -> {
                InGamePrompts.setLogMode(ctx.getSource().getPlayerOrException(), m);
                ctx.getSource().sendSuccess(() -> Component.literal("Autosketch: log " + m.id()), false);
                return 1;
            }));
        r.root().then(log);
        alias(r.dispatcher(), AutosketchConfig.get().prompts.askAlias.trim());
    }

    /** The request modes with a plain {@code <text>} subcommand; {@code select} (18) has its own. */
    static final List<String> TEXT_MODES = List.of("ask", "plan", "build");

    /**
     * Adds the request subcommands under {@code root} ({@code /autosketch}, or the alias), including
     * {@code select [text]} (18, piece 1: the text is optional, none means the crosshair
     * block) and {@code done} (B6: ends the open read-only request).
     */
    static void requests(LiteralArgumentBuilder<CommandSourceStack> root) {
        root.then(Commands.literal("done").executes(ctx -> InGamePrompts.done(ctx.getSource().getPlayerOrException(), Autosketch.bridge())));
        dev.autosketch.mod.command.RequestCommands.register(root); // 19: stop, queue, queue cancel <n>
        for (String mode : TEXT_MODES)
            root.then(Commands.literal(mode).then(Commands.argument("text", StringArgumentType.greedyString())
                    .executes(ctx -> InGamePrompts.request(ctx.getSource().getPlayerOrException(), mode, StringArgumentType.getString(ctx, "text"), Autosketch.bridge()))));
        root.then(Commands.literal("select")
                .executes(ctx -> InGamePrompts.select(ctx.getSource().getPlayerOrException(), "", Autosketch.bridge()))
                .then(Commands.argument("text", StringArgumentType.greedyString())
                        .executes(ctx -> InGamePrompts.select(ctx.getSource().getPlayerOrException(), StringArgumentType.getString(ctx, "text"), Autosketch.bridge()))));
    }

    /**
     * Registers the configured {@code askAlias} as a short root for the request subcommands
     * ({@code /as build …}, 13, B6), unless it is empty, malformed or already a command.
     */
    public static void alias(CommandDispatcher<CommandSourceStack> dispatcher, String alias) {
        if (alias.isEmpty()) return;
        if (!alias.matches("[a-z0-9_-]{1,32}")) {
            LOG.warn("Autosketch: askAlias \"{}\" isn't a valid command name; no alias registered", alias);
            return;
        }
        if (dispatcher.getRoot().getChild(alias) != null) {
            LOG.warn("Autosketch: askAlias \"{}\" is already a command; no alias registered", alias);
            return;
        }
        LiteralArgumentBuilder<CommandSourceStack> root = Commands.literal(alias).requires(src -> src.hasPermission(CommandExtension.OP_LEVEL));
        requests(root);
        dispatcher.register(dev.autosketch.mod.link.Link.lock(root)); // locked while no MCP is connected (16)
    }
}
