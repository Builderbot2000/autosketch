package dev.autosketch.mod.prompt;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Json;
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
import net.minecraft.network.chat.Component;
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

    /** The {@code prompt} message for a request (13, *Wire format*, {@code prompt}). */
    public static Frame prompt(long id, ServerPlayer player, String text, double reach) {
        JsonObject h = Json.header("prompt");
        h.addProperty("id", id);
        JsonObject who = new JsonObject();
        who.addProperty("name", player.getGameProfile().getName());
        who.addProperty("uuid", player.getUUID().toString());
        h.add("player", who);
        h.addProperty("text", text);
        h.add("context", GameContext.capture(player, reach, focus(player)));
        return new Frame(h);
    }

    /**
     * {@code /autosketch ask <text>}: sends the request with its game context. With no MCP connected,
     * the player hears {@code no_link} at once (13: "When the mod has no connection at all, it tells
     * the player no_link itself"). Returns the command result (1 sent, 0 not).
     */
    public static int ask(ServerPlayer player, String text, Bridge bridge) {
        long id = nextId();
        if (!bridge.connected()) {
            out.actionBar(player, refusal("no_link"));
            return 0;
        }
        PENDING.put(id, player.getUUID());
        if (!bridge.send(prompt(id, player, text, AutosketchConfig.TARGET_REACH.get()))) {
            PENDING.remove(id);
            out.actionBar(player, refusal("no_link"));
            return 0;
        }
        out.actionBar(player, Component.literal("Autosketch: asking the agent…").withStyle(ChatFormatting.GRAY));
        return 1;
    }

    private static Component refusal(String reason) {
        return Component.literal(ChatRules.resultText(false, reason)).withStyle(ChatFormatting.RED);
    }

    /** Handles {@code prompt.result}: the delivery result on the asking player's action bar. */
    public static void onResult(JsonObject h, MinecraftServer server) throws ProtocolException {
        Long id = Json.reqLong(h, "id", null);
        boolean delivered = Json.reqBool(h, "delivered", id);
        String reason = delivered ? null : Json.optString(h, "reason", id);
        UUID who = PENDING.remove(id);
        if (who == null) return;
        ServerPlayer player = server.getPlayerList().getPlayer(who);
        if (player == null) return;
        Component text = Component.literal(ChatRules.resultText(delivered, reason)).withStyle(delivered ? ChatFormatting.GREEN : ChatFormatting.RED);
        out.actionBar(player, text);
    }

    // ── chat ──────────────────────────────────────────────────────────────────────────────────

    private static final String LOG_KEY = "autosketch_log";

    /** The player's {@code /autosketch log} setting, kept with the player's saved data. Default {@code mine}. */
    public static LogMode logMode(ServerPlayer player) {
        CompoundTag data = player.getPersistentData();
        LogMode m = LogMode.parse(data.contains(LOG_KEY) ? data.getString(LOG_KEY) : null);
        return m == null ? LogMode.MINE : m;
    }

    public static void setLogMode(ServerPlayer player, LogMode mode) {
        player.getPersistentData().putString(LOG_KEY, mode.id());
    }

    /**
     * Handles {@code chat}: shows the lines to the named player (a reply always, activity unless their
     * log is off) and to every other player whose log is {@code all}. Only players allowed to use
     * {@code /autosketch} (op level 2) ever see agent output. Returns how many players it reached.
     */
    public static int onChat(JsonObject h, MinecraftServer server) throws ProtocolException {
        Long request = Json.reqNullableLong(h, "request", null);
        String player = Json.optString(h, "player", null);
        String kind = Json.reqString(h, "kind", null);
        if (!kind.equals("activity") && !kind.equals("reply")) throw ProtocolException.badRequest(null, "\"kind\" must be \"activity\" or \"reply\"");
        List<String> lines = new ArrayList<>();
        for (JsonElement e : Json.reqArray(h, "lines", null)) {
            if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) throw ProtocolException.badRequest(null, "\"lines\" must be strings");
            lines.add(e.getAsString());
        }
        UUID target;
        try {
            target = player == null ? null : UUID.fromString(player);
        } catch (IllegalArgumentException ex) {
            throw ProtocolException.badRequest(null, "\"player\" must be a UUID");
        }
        boolean reply = kind.equals("reply");
        List<Component> shown = format(lines, reply);
        int reached = 0;
        for (ServerPlayer p : server.getPlayerList().getPlayers()) {
            if (!p.hasPermissions(CommandExtension.OP_LEVEL)) continue;
            if (!ChatRules.visible(logMode(p), p.getUUID(), target, reply)) continue;
            for (Component c : shown) out.chat(p, c);
            reached++;
        }
        return reached;
    }

    /** Activity dimmed and italic; replies prominent, with the agent named. Long lines wrapped. */
    public static List<Component> format(List<String> lines, boolean reply) {
        List<Component> out = new ArrayList<>();
        for (String line : lines)
            for (String piece : ChatRules.wrap(line, ChatRules.WRAP)) {
                MutableComponent c;
                if (reply) c = Component.literal("Agent: ").withStyle(ChatFormatting.AQUA, ChatFormatting.BOLD).append(Component.literal(piece).withStyle(ChatFormatting.WHITE));
                else c = Component.literal("· " + piece).withStyle(ChatFormatting.DARK_GRAY, ChatFormatting.ITALIC);
                out.add(c);
            }
        return out;
    }
}
