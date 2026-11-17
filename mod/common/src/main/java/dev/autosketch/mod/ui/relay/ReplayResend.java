package dev.autosketch.mod.ui.relay;

import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.UiMessages.UiResult;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.network.protocol.game.ClientboundLevelChunkWithLightPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.ChunkPos;
import net.minecraft.world.level.chunk.LevelChunk;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * The server half's part of replay (16, *Replay in the world*; 13, {@code replay.close}): replay
 * overrides blocks only in the player's own client copy of the world, so when a replay ends the
 * server resends the chunks covering its volume to that player, and the client shows exactly the
 * server's world again. Nothing here writes to the world, and nothing needs cleaning up after a
 * client crash: a fresh join sends fresh chunks anyway.
 *
 * <p>It learns each player's open replay from the {@code replay.open} results going back through
 * the relay ({@link UiRelay#addResultListener}), and resends on that player's {@code replay.close}
 * (whatever the MCP answered: the client has closed either way), on a {@code resync} (which closes
 * the replay, 13), and for every open replay when the bridge disconnects (the relay can't forward a
 * close then). In the last two cases it first tells the client the replay ended ({@link #ENDED}),
 * so the client stops overriding before the chunks arrive. Server thread.
 */
public final class ReplayResend {
    private static final Logger LOG = LogUtils.getLogger();

    /** One player's open replay: its id, dimension and volume (world coordinates). */
    public record Open(String replay, String dimension, Box volume) {}

    /** How chunks reach a player's client; replaced in GameTests to record them. */
    public interface Sender {
        /** Whether the player's client holds this chunk now (only those are resent; others arrive fresh when tracked). */
        boolean hasChunk(ServerPlayer player, ChunkPos pos);

        void send(ServerPlayer player, LevelChunk chunk);
    }

    public static final Sender VANILLA = new Sender() {
        @Override
        public boolean hasChunk(ServerPlayer player, ChunkPos pos) {
            return player.getChunkTrackingView().contains(pos);
        }

        @Override
        public void send(ServerPlayer player, LevelChunk chunk) {
            // 1.21.x: the chunk packet's constructor (light BitSets null = all sections).
            player.connection.send(new ClientboundLevelChunkWithLightPacket(chunk, chunk.getLevel().getLightEngine(), null, null));
        }
    };

    /**
     * The client action that ends a replay locally without a request: sent before the chunks when
     * the replay ended on the MCP's side (a {@code resync}, or the MCP going away). The client may
     * not have seen the link go offline at all (a new MCP replaced the old one at once), and its
     * replay belonged to the old session.
     */
    public static final String ENDED = "replay.ended";

    private final Map<UUID, Open> open = new ConcurrentHashMap<>();
    private final UiRelay relay;
    private volatile Sender sender = VANILLA;

    /** Hooks onto the relay's results and the bridge's disconnect. */
    public ReplayResend(UiRelay relay, Bridge bridge) {
        this.relay = relay;
        relay.addResultListener(this::result);
        bridge.addListener(new Bridge.Listener() {
            @Override
            public void disconnected(BridgeSession session) {
                MinecraftServer server = Platform.get().currentServer();
                if (server == null) {
                    open.clear();
                    return;
                }
                server.execute(() -> {
                    for (Map.Entry<UUID, Open> e : List.copyOf(open.entrySet())) {
                        ServerPlayer p = server.getPlayerList().getPlayer(e.getKey());
                        if (p == null) continue;
                        relay.sendAction(p, ENDED);
                        resend(p, e.getValue());
                    }
                    open.clear();
                });
            }
        });
    }

    /** For tests: replaces the sender. Returns the old one. */
    public Sender setSender(Sender s) {
        Sender old = sender;
        sender = s;
        return old;
    }

    /** The player's open replay, or null. */
    public @Nullable Open open(UUID player) {
        return open.get(player);
    }

    /** A player left: their next join loads every chunk fresh. */
    public void playerLeft(ServerPlayer p) {
        open.remove(p.getUUID());
    }

    void result(ServerPlayer p, String kind, JsonObject args, UiResult r) {
        switch (kind) {
            case "replay.open" -> {
                if (!r.ok() || r.result() == null) return;
                try {
                    JsonObject res = r.result();
                    Open o = new Open(Json.reqString(res, "replay", null), Json.reqString(res, "dimension", null), Box.fromJson(Json.reqObject(res, "volume", null), "volume", null));
                    Open before = open.put(p.getUUID(), o);
                    // A second open replaces the first: the client shows the new one only.
                    if (before != null && !before.volume().equals(o.volume())) resend(p, before);
                } catch (ProtocolException | RuntimeException e) {
                    LOG.warn("Autosketch UI: a replay.open result without a usable volume: {}", e.getMessage());
                }
            }
            case "replay.close", "resync" -> {
                Open o = open.remove(p.getUUID());
                if (o == null) return;
                if (kind.equals("resync")) relay.sendAction(p, ENDED);
                resend(p, o);
            }
            default -> {}
        }
    }

    /** The chunks covering the volume that the player's client holds, in the replay's dimension; empty when the player is elsewhere. */
    public List<LevelChunk> chunks(ServerPlayer p, Open o) {
        List<LevelChunk> out = new ArrayList<>();
        if (!p.level().dimension().location().toString().equals(o.dimension())) return out;
        ServerLevel level = p.serverLevel();
        Box b = o.volume();
        Sender s = sender;
        for (int cx = b.minX() >> 4; cx <= b.maxX() >> 4; cx++)
            for (int cz = b.minZ() >> 4; cz <= b.maxZ() >> 4; cz++) {
                ChunkPos pos = new ChunkPos(cx, cz);
                if (!s.hasChunk(p, pos)) continue;
                LevelChunk c = level.getChunkSource().getChunkNow(cx, cz);
                if (c != null) out.add(c);
            }
        return out;
    }

    /** Resends the volume's chunks to that player only. */
    public void resend(ServerPlayer p, Open o) {
        Sender s = sender;
        for (LevelChunk c : chunks(p, o)) s.send(p, c);
    }
}
