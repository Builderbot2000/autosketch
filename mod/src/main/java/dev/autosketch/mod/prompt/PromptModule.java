package dev.autosketch.mod.prompt;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import com.mojang.logging.LogUtils;
import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.WandMode;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.prompt.ChatRules.LogMode;
import java.util.List;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.server.ServerLifecycleHooks;
import org.slf4j.Logger;

/**
 * Registers in-game requests (13, *Prompting from the game*, M13) through the skeleton's hooks:
 * {@code /autosketch ask <text>} (and the configured alias), {@code /autosketch focus clear},
 * {@code /autosketch log off|mine|all}, the wand's {@code focus} mode, and the handlers for
 * {@code prompt.result} and {@code chat}.
 */
@EventBusSubscriber(modid = Autosketch.MOD_ID, bus = EventBusSubscriber.Bus.MOD)
public final class PromptModule {
    private PromptModule() {}

    private static final Logger LOG = LogUtils.getLogger();

    /** The focus mode's outline colour (gold), distinct from work and context. */
    public static final int FOCUS_COLOUR = 0xFFC233;

    @SubscribeEvent
    static void setup(AutosketchSetupEvent e) {
        e.messages().register("prompt.result", (m, x) -> {
            var server = ServerLifecycleHooks.getCurrentServer();
            if (server != null) InGamePrompts.onResult(m.header(), server);
        });
        e.messages().register("chat", (m, x) -> {
            var server = ServerLifecycleHooks.getCurrentServer();
            if (server != null) InGamePrompts.onChat(m.header(), server);
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
        r.root().then(Commands.literal("ask").then(askText()));
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
        alias(r.dispatcher(), AutosketchConfig.ASK_ALIAS.get().trim());
    }

    /** Registers the configured short alias for {@code ask}, unless it is empty, malformed or already a command. */
    static void alias(CommandDispatcher<CommandSourceStack> dispatcher, String alias) {
        if (alias.isEmpty()) return;
        if (!alias.matches("[a-z0-9_-]{1,32}")) {
            LOG.warn("Autosketch: askAlias \"{}\" isn't a valid command name; no alias registered", alias);
            return;
        }
        if (dispatcher.getRoot().getChild(alias) != null) {
            LOG.warn("Autosketch: askAlias \"{}\" is already a command; no alias registered", alias);
            return;
        }
        dispatcher.register(Commands.literal(alias).requires(src -> src.hasPermission(CommandExtension.OP_LEVEL)).then(askText()));
    }

    private static RequiredArgumentBuilder<CommandSourceStack, String> askText() {
        return Commands.argument("text", StringArgumentType.greedyString()).executes(PromptModule::ask);
    }

    private static int ask(CommandContext<CommandSourceStack> ctx) throws CommandSyntaxException {
        return InGamePrompts.ask(ctx.getSource().getPlayerOrException(), StringArgumentType.getString(ctx, "text"), Autosketch.bridge());
    }
}
