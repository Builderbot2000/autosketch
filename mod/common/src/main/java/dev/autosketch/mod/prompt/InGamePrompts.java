package dev.autosketch.mod.prompt;

import com.google.gson.JsonObject;
import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.prompt.ChatRules.LogMode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.ChatFormatting;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.Level;
import org.jetbrains.annotations.Nullable;

/**
 * In-game requests, mod side (13, *Prompting from the game*, M13): the focus box per player, the
 * {@code prompt} a request sends with its game context, the delivery result on the action bar, and
 * {@code chat} lines shown by kind and filtered by each player's log setting. Server thread only,
 * except {@link #nextId}.
 */
public final class InGamePrompts {
    private InGamePrompts() {}

    /** Where player-facing text goes; tests swap it to read what a player would see. */
    public interface Output {
        void actionBar(ServerPlayer player, Component text);

        void chat(ServerPlayer player, Component text);

        Output PLAYER = new Output() {
            @Override
            public void actionBar(ServerPlayer player, Component text) {
                player.displayClientMessage(text, true);
            }

            @Override
            public void chat(ServerPlayer player, Component text) {
                player.sendSystemMessage(text);
            }
        };
    }

    private static volatile Output out = Output.PLAYER;

    /** Where player-facing text goes now (the request commands, {@link StatusLines}). */
    public static Output output() {
        return out;
    }

    /** Replaces the output (tests); returns the previous one. */
    public static Output setOutput(Output o) {
        Output prev = out;
        out = o;
        return prev;
    }

    // ── focus box ─────────────────────────────────────────────────────────────────────────────

    /** A player's focus corners in one dimension. */
    public record Focus(ResourceKey<Level> dimension, @Nullable BlockPos corner1, @Nullable BlockPos corner2) {
        public @Nullable Box box() {
            return corner1 == null || corner2 == null ? null : Box.of(corner1, corner2);
        }
    }

    private static final Map<UUID, Focus> FOCUS = new ConcurrentHashMap<>();

    /** Sets a focus corner (the wand's focus mode) and tells the player the resulting box, clipped. */
    public static void setFocusCorner(ServerPlayer player, int corner, BlockPos pos) {
        ResourceKey<Level> dim = player.level().dimension();
        Focus f = FOCUS.get(player.getUUID());
        if (f == null || !f.dimension().equals(dim)) f = new Focus(dim, null, null);
        f = corner == 1 ? new Focus(dim, pos.immutable(), f.corner2()) : new Focus(dim, f.corner1(), pos.immutable());
        FOCUS.put(player.getUUID(), f);
        Box box = f.box();
        if (box == null) {
            out.actionBar(player, Component.literal("Autosketch: focus corner " + corner + " set at " + pos.toShortString()));
            return;
        }
        FocusClip.Result clip = FocusClip.clip(box, Autosketch.link().current());
        if (clip == null) out.actionBar(player, Component.literal("Autosketch: focus box " + FocusClip.size(box) + " lies outside the work and context volumes, so requests won't carry it").withStyle(ChatFormatting.YELLOW));
        else if (clip.clipped()) out.actionBar(player, Component.literal("Autosketch: focus box clipped to the volumes: " + FocusClip.size(clip.box()) + " of " + FocusClip.size(box)).withStyle(ChatFormatting.YELLOW));
        else out.actionBar(player, Component.literal("Autosketch: focus box " + FocusClip.size(box)));
    }

    /** The player's focus box clipped to the volumes, in their current dimension, or null. */
    public static @Nullable FocusClip.Result focus(ServerPlayer player) {
        Focus f = FOCUS.get(player.getUUID());
        if (f == null || !f.dimension().equals(player.level().dimension())) return null;
        Box box = f.box();
        if (box == null) return null;
        LinkVolumes v = Autosketch.link().current();
        if (v != null && !v.dimension().equals(f.dimension())) return null;
        return FocusClip.clip(box, v);
    }

    /** {@code /autosketch focus clear}. Returns whether there was one. */
    public static boolean clearFocus(ServerPlayer player) {
        return FOCUS.remove(player.getUUID()) != null;
    }

    // ── asking ────────────────────────────────────────────────────────────────────────────────

    private static final AtomicLong IDS = new AtomicLong();
    /** Prompts awaiting their {@code prompt.result}: id → asking player. */
    private static final Map<Long, UUID> PENDING = new ConcurrentHashMap<>();

    public static long nextId() {
        return IDS.incrementAndGet();
    }

    /**
     * The {@code prompt} message for a request (13, *Wire format*, {@code prompt}): the game context
     * and the request's {@code mode} (B6).
     */
    public static Frame prompt(long id, ServerPlayer player, String text, double reach, String mode) {
        Messages.Player who = new Messages.Player(player.getGameProfile().getName(), player.getUUID());
        return new Messages.Prompt(id, who, text, GameContext.capture(player, reach, focus(player)), mode).encode();
    }

    /**
     * {@code /autosketch ask|plan|build <text>} (13, B6): sends the request in that mode with its game
     * context. With no MCP connected, the player hears {@code no_link} at once (13: "When the mod has
     * no connection at all, it tells the player no_link itself"); a mode the MCP's hello doesn't list
     * is refused here with {@code unsupported_mode}, and nothing is sent. Returns the command result
     * (1 sent, 0 not).
     */
    public static int request(ServerPlayer player, String mode, String text, Bridge bridge) {
        return request(player, mode, text, bridge, () -> {});
    }

    /** As {@link #request(ServerPlayer, String, String, Bridge)}, running {@code beforeSend} (the select grant) only once the request may go out. */
    public static int request(ServerPlayer player, String mode, String text, Bridge bridge, Runnable beforeSend) {
        long id = nextId();
        if (!bridge.connected()) {
            out.actionBar(player, refusal("no_link"));
            return 0;
        }
        BridgeSession session = bridge.session();
        if (session == null || !session.modes().contains(mode)) {
            out.actionBar(player, Component.literal(unsupportedText(mode)).withStyle(ChatFormatting.RED));
            return 0;
        }
        beforeSend.run();
        PENDING.put(id, player.getUUID());
        if (!bridge.send(prompt(id, player, text, AutosketchConfig.get().prompts.targetReach, mode))) {
            PENDING.remove(id);
            out.actionBar(player, refusal("no_link"));
            return 0;
        }
        out.actionBar(player, Component.literal("Autosketch: asking the agent…").withStyle(ChatFormatting.GRAY));
        return 1;
    }

    /**
     * What a select request's grant does as the prompt goes out (13, *Where the mod serves reads*,
     * "Read grants in select mode"): given the prompt's dimension and the block of its
     * {@code context.position}, it grants the square within {@code selectChunks} of that chunk,
     * replacing any grant. The world module installs the real grant ({@link #setSelectGrant}); until
     * it does, a select prompt grants nothing.
     */
    public interface SelectGrant {
        void grant(ResourceKey<Level> dimension, BlockPos position);
    }

    private static volatile SelectGrant selectGrant = (dimension, position) -> {};

    /** Installs the select grant hook (the world module, tests); returns the previous one. */
    public static SelectGrant setSelectGrant(SelectGrant g) {
        SelectGrant prev = selectGrant;
        selectGrant = g;
        return prev;
    }

    /**
     * {@code /autosketch select [text]} (18, piece 1): a {@code select} request, read-only (the MCP
     * refuses edits and drafts), carrying the usual game context and no grant
     * field. The select grant is fixed at the prompt's position as the request goes out, and only then
     * ({@link SelectGrant}); a request refused here (no link, an MCP whose hello lacks {@code select})
     * grants nothing. Empty text means the crosshair block is the starting point.
     */
    public static int select(ServerPlayer player, String text, Bridge bridge) {
        return request(player, "select", text, bridge, () -> selectGrant.grant(player.level().dimension(), BlockPos.containing(player.position())));
    }

    /**
     * {@code /autosketch done} (13, B6): ends the open read-only request ({@code ask}, {@code plan},
     * {@code select}). Only the player lifts a read-only mode, so this is the in-game way to end one
     * without sending a new request. Sends {@code prompt.close}, which the MCP answers with a notice on
     * the player's action bar (it owns the request state, so it says whether one was open). Without a
     * connection the player hears {@code no_link}; an MCP whose hello doesn't list
     * {@code prompt.close} is too old for it, and the player is told to update it, with nothing sent.
     * Returns the command result (1 sent, 0 not).
     */
    public static int done(ServerPlayer player, Bridge bridge) {
        if (!bridge.connected()) {
            out.actionBar(player, refusal("no_link"));
            return 0;
        }
        BridgeSession session = bridge.session();
        if (session == null || !session.features().contains(Messages.MCP_FEATURE_PROMPT_CLOSE)) {
            out.actionBar(player, Component.literal(DONE_UNSUPPORTED).withStyle(ChatFormatting.RED));
            return 0;
        }
        Messages.Player who = new Messages.Player(player.getGameProfile().getName(), player.getUUID());
        if (!bridge.send(new Messages.PromptClose(who).encode())) {
            out.actionBar(player, refusal("no_link"));
            return 0;
        }
        out.actionBar(player, Component.literal("Autosketch: ending the open request…").withStyle(ChatFormatting.GRAY));
        return 1;
    }

    /** The action-bar text for {@code /autosketch done} to an MCP that doesn't list {@code prompt.close}. */
    public static final String DONE_UNSUPPORTED = "Autosketch: not sent: the Autosketch MCP server is too old for /autosketch done (update it; a new request also ends the open one)";

    /** The action-bar text for a request mode the MCP doesn't accept (its hello doesn't list it). */
    public static String unsupportedText(String mode) {
        return "Autosketch: not sent: the Autosketch MCP server doesn't accept " + mode + " requests (update it; /autosketch build still works)";
    }

    /** The action-bar refusal for {@code reason}, worded as a {@code prompt.result}'s. */
    public static Component refusal(String reason) {
        return Component.literal(ChatRules.resultText(false, reason)).withStyle(ChatFormatting.RED);
    }

    /** The action-bar line for a prompt queued behind the running request (19, *Queueing*). */
    public static String queuedText(@Nullable Integer position) {
        return "Autosketch: queued behind the running request (" + (position == null ? "in" : "#" + position + " in") + " your queue; /autosketch queue)";
    }

    /** Handles {@code prompt.result}: the delivery result on the asking player's action bar. */
    public static void onResult(JsonObject h, MinecraftServer server) throws ProtocolException {
        Messages.PromptResult r = Messages.PromptResult.decode(new Frame(h));
        UUID who = PENDING.remove(r.id());
        if (who == null) return;
        ServerPlayer player = server.getPlayerList().getPlayer(who);
        if (player == null) return;
        // 19, *Queueing*: a queued prompt is neither delivered nor refused; its status line follows.
        if (r.queued()) {
            out.actionBar(player, Component.literal(queuedText(r.position())).withStyle(ChatFormatting.YELLOW));
            return;
        }
        boolean delivered = r.delivered();
        Component text = Component.literal(ChatRules.resultText(delivered, r.reason())).withStyle(delivered ? ChatFormatting.GREEN : ChatFormatting.RED);
        out.actionBar(player, text);
    }

    // ── chat ──────────────────────────────────────────────────────────────────────────────────

    private static final String LOG_KEY = "autosketch_log";

    /** The player's {@code /autosketch log} setting, kept with the player's saved data. Default {@code mine}. */
    public static LogMode logMode(ServerPlayer player) {
        CompoundTag data = Platform.get().playerData(player);
        LogMode m = LogMode.parse(data.contains(LOG_KEY) ? data.getString(LOG_KEY) : null);
        return m == null ? LogMode.MINE : m;
    }

    public static void setLogMode(ServerPlayer player, LogMode mode) {
        Platform.get().playerData(player).putString(LOG_KEY, mode.id());
    }

    /**
     * Handles {@code chat}: shows the lines to the named player (a reply always, activity unless their
     * log is off) and to every other player whose log is {@code all}. Only players allowed to use
     * {@code /autosketch} (op level 2) ever see agent output. A reply's {@code action} (17, piece 3)
     * makes its line clickable for players whose client runs the client half ({@link #setClickable});
     * everyone else sees the same line as plain text. Returns how many players it reached.
     */
    public static int onChat(Messages.Chat chat, MinecraftServer server) {
        UUID target = chat.player();
        boolean reply = chat.reply();
        Messages.ChatAction action = chat.action();
        long actionId = action == null ? 0 : remember(action);
        List<Component> plain = format(chat.lines(), reply, -1, 0);
        List<Component> withAction = action == null ? plain : format(chat.lines(), reply, action.line(), actionId, actionHover(action.kind()));
        int reached = 0;
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            if (!p.hasPermissions(CommandExtension.OP_LEVEL)) continue;
            if (!ChatRules.visible(logMode(p), p.getUUID(), target, reply)) continue;
            // 18, piece 7, *Folding*: a question's lines go to the client half, which adds and later folds them.
            if (reply && chat.question() != null && ChoiceLines.relay(p, chat, actionId)) {
                reached++;
                continue;
            }
            for (Component c : action != null && clickable.test(p) ? withAction : plain) out.chat(p, c);
            reached++;
        }
        return reached;
    }

    // ── clickable reply lines (17, piece 3) ───────────────────────────────────────────────────

    /** How many reply-line actions are kept for {@code /autosketch action <n>}; older lines expire. */
    public static final int ACTIONS_KEPT = 256;

    private static final AtomicLong ACTION_IDS = new AtomicLong();
    private static final Map<Long, Messages.ChatAction> ACTIONS = java.util.Collections.synchronizedMap(new java.util.LinkedHashMap<>() {
        @Override
        protected boolean removeEldestEntry(Map.Entry<Long, Messages.ChatAction> eldest) {
            return size() > ACTIONS_KEPT;
        }
    });

    private static volatile java.util.function.Predicate<ServerPlayer> clickable = p -> false;

    /**
     * Says which players get a reply's action as a clickable line: those whose client runs the client
     * half (the loader wires the {@code autosketch:ui} channel check). Returns the previous one (tests).
     */
    public static java.util.function.Predicate<ServerPlayer> setClickable(java.util.function.Predicate<ServerPlayer> c) {
        java.util.function.Predicate<ServerPlayer> prev = clickable;
        clickable = c;
        return prev;
    }

    /** Keeps an action for {@code /autosketch action <n>} and returns its number (status-line buttons, {@link StatusLines}). */
    public static long remember(Messages.ChatAction action) {
        long id = ACTION_IDS.incrementAndGet();
        ACTIONS.put(id, action);
        return id;
    }

    /**
     * The action a clickable line numbered {@code id} carries, or null once it expired. The click
     * runs {@link #actionCommand}, which looks it up here, so the command stays short whatever the
     * action's arguments (a command a client sends is at most 256 characters).
     */
    public static Messages.@Nullable ChatAction action(long id) {
        return ACTIONS.get(id);
    }

    /** The command a clickable line runs. */
    public static String actionCommand(long id) {
        return "/autosketch action " + id;
    }

    /** The hover text of a clickable line. */
    public static final String ACTION_HOVER = "Click to open";

    /** The hover text of a choice line ({@code choices.pick}, 18, piece 7): the click answers the agent. */
    public static final String CHOICE_HOVER = "Click to answer with this";

    /** The hover text for a line whose action is {@code kind}. */
    public static String actionHover(String kind) {
        return kind.equals("choices.pick") ? CHOICE_HOVER : ACTION_HOVER;
    }

    /** Activity dimmed and italic; replies prominent, with the agent named. Long lines wrapped. */
    public static List<Component> format(List<String> lines, boolean reply) {
        return format(lines, reply, -1, 0);
    }

    /** As {@link #format(List, boolean)}; every piece of line {@code clickLine} runs action {@code actionId} when clicked. */
    static List<Component> format(List<String> lines, boolean reply, int clickLine, long actionId) {
        return format(lines, reply, clickLine, actionId, ACTION_HOVER);
    }

    /** As above, with the clickable line's hover text (also the client half's, for the choice lines it adds, {@link ChoiceLines}). */
    public static List<Component> format(List<String> lines, boolean reply, int clickLine, long actionId, String hover) {
        List<Component> out = new ArrayList<>();
        for (int i = 0; i < lines.size(); i++)
            for (String piece : ChatRules.wrap(lines.get(i), ChatRules.WRAP)) {
                MutableComponent c;
                if (reply) {
                    MutableComponent text = Component.literal(piece).withStyle(ChatFormatting.WHITE);
                    if (i == clickLine) {
                        String command = actionCommand(actionId);
                        text = Component.literal(piece).withStyle(s -> s.withColor(ChatFormatting.AQUA).withUnderlined(true)
                                .withClickEvent(new ClickEvent(ClickEvent.Action.RUN_COMMAND, command))
                                .withHoverEvent(new HoverEvent(HoverEvent.Action.SHOW_TEXT, Component.literal(hover))));
                    }
                    c = Component.literal("Agent: ").withStyle(ChatFormatting.AQUA, ChatFormatting.BOLD).append(text);
                } else c = Component.literal("· " + piece).withStyle(ChatFormatting.DARK_GRAY, ChatFormatting.ITALIC);
                out.add(c);
            }
        return out;
    }
}
