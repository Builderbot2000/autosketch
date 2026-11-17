package dev.autosketch.mod.ui.relay;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.AutosketchSetup;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.Messages.Player;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.UiMessages;
import dev.autosketch.mod.protocol.UiMessages.UiRequest;
import dev.autosketch.mod.protocol.UiMessages.UiResult;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import org.slf4j.Logger;

/**
 * The server half of the in-game UI (16, *Mod side*; 13, *In-game UI*, *Relay to the client*): it
 * forwards each {@code ui.*} and {@code replay.*} message from the MCP to the players it names whose
 * clients registered {@code autosketch:ui}, split into parts of at most 1,000,000 bytes; it forwards
 * a client's request to the MCP as a {@code ui.request} numbered from its own counter, with the
 * player set from the connection, and routes the {@code ui.result} back to that client under the
 * client's own number. It keeps no UI state except, per player, the last full {@code ui.state}
 * naming them, resent when they join and dropped when the bridge disconnects.
 *
 * <p>Nothing here is sent unless both hellos list {@code ui}. Runs on the server thread (the bridge
 * hands id-less messages to it there, and the payload handler enqueues client requests there).
 * Never references client classes.
 */
public final class UiRelay {
    private static final Logger LOG = LogUtils.getLogger();

    /** How the relay reaches players' clients; the loader's payload registration provides it. */
    public interface Transport {
        /** Whether the player's client registered {@code autosketch:ui} (it runs the client half). */
        boolean hasChannel(ServerPlayer player);

        void send(ServerPlayer player, UiPayload payload);
    }

    /** Told of each request's result as it goes back to the client (silo R resends chunks on {@code replay.close}). */
    @FunctionalInterface
    public interface ResultListener {
        void result(ServerPlayer player, String kind, JsonObject args, UiResult result);
    }

    private record Pending(UUID player, long clientId, String kind, JsonObject args) {}

    private final Bridge bridge;
    private final boolean modListsUi;
    private volatile Transport transport;
    private final AtomicLong requests = new AtomicLong();
    private final Map<UUID, AtomicLong> frameIds = new ConcurrentHashMap<>();
    private final Map<Long, Pending> pending = new ConcurrentHashMap<>();
    private final Map<UUID, Frame> lastFull = new ConcurrentHashMap<>();
    private final List<ResultListener> resultListeners = new CopyOnWriteArrayList<>();

    /** {@code modListsUi}: whether this mod's hello lists {@code ui} (it does whenever the relay is set up). */
    public UiRelay(Bridge bridge, Transport transport, boolean modListsUi) {
        this.bridge = bridge;
        this.transport = transport;
        this.modListsUi = modListsUi;
        bridge.addListener(new Bridge.Listener() {
            @Override
            public void disconnected(BridgeSession session) {
                lastFull.clear();
                failPending("the Autosketch MCP disconnected");
            }
        });
    }

    /** Registers the handlers for every MCP → mod {@code ui} message type; that makes the mod's hello list {@code ui}. */
    public void setup(AutosketchSetup setup) {
        for (String type : UiMessages.MCP_TYPES) setup.messages().register(type, (m, ex) -> forward(m.frame()));
    }

    /** For tests: replaces the transport. Returns the old one. */
    public Transport setTransport(Transport t) {
        Transport old = transport;
        transport = t;
        return old;
    }

    public void addResultListener(ResultListener l) {
        resultListeners.add(l);
    }

    /** Whether both hellos list {@code ui} now. */
    public boolean enabled() {
        BridgeSession s = bridge.connected() ? bridge.session() : null;
        return modListsUi && s != null && s.features().contains(UiMessages.FEATURE_UI);
    }

    /** Requests forwarded and not yet answered. */
    public int pending() {
        return pending.size();
    }

    // ── MCP → clients ─────────────────────────────────────────────────────────────────────────

    /** Forwards one MCP message to its players. Server thread. A malformed {@code players} is {@code bad_request}. */
    public void forward(Frame f) throws ProtocolException {
        if (!enabled()) {
            LOG.debug("Autosketch UI: dropping {}: the MCP's hello doesn't list ui", f.type());
            return;
        }
        List<UUID> players = UiMessages.players(f);
        if (f.type().equals("ui.result")) {
            result(f, players.get(0));
            return;
        }
        if (f.type().equals("ui.state") && Json.optBool(f.header(), "full", null)) for (UUID u : players) lastFull.put(u, f);
        byte[] bytes = FrameCodec.encode(f);
        MinecraftServer server = Platform.get().currentServer();
        if (server == null) return;
        for (UUID u : players) {
            ServerPlayer p = server.getPlayerList().getPlayer(u);
            if (p != null) sendFrame(p, bytes);
        }
    }

    private void result(Frame f, UUID player) throws ProtocolException {
        long request = Json.reqLong(f.header(), "request", null);
        Pending q = pending.remove(request);
        if (q == null || !q.player.equals(player)) {
            LOG.debug("Autosketch UI: a ui.result for request {} nobody is waiting for", request);
            return;
        }
        UiResult r = UiResult.decode(f);
        MinecraftServer server = Platform.get().currentServer();
        ServerPlayer p = server == null ? null : server.getPlayerList().getPlayer(player);
        if (p == null) return;
        JsonObject h = f.header().deepCopy();
        h.addProperty("request", q.clientId);
        sendFrame(p, FrameCodec.encode(new Frame(h, f.body())));
        for (ResultListener l : resultListeners) l.result(p, q.kind, q.args, r);
    }

    /** Sends one encoded frame to a player's client in parts; nothing when the client lacks the channel. */
    public void sendFrame(ServerPlayer p, byte[] frame) {
        Transport t = transport;
        if (!t.hasChannel(p)) return;
        long id = frameIds.computeIfAbsent(p.getUUID(), k -> new AtomicLong()).incrementAndGet();
        List<byte[]> parts = UiMessages.split(frame);
        for (int i = 0; i < parts.size(); i++) t.send(p, new UiPayload(UiPayload.FRAME, id, i, parts.size(), parts.get(i)));
    }

    /** The link state to one client (16, *Mod side*; silo L's {@code Link} calls this through the platform). */
    public void sendLink(ServerPlayer p, String wire) {
        Transport t = transport;
        if (t.hasChannel(p)) t.send(p, UiPayload.link(wire));
    }

    /** A player joined (or registered the channel): resend the last full state naming them. */
    public void playerJoined(ServerPlayer p) {
        Frame f = lastFull.get(p.getUUID());
        if (f != null && enabled()) sendFrame(p, FrameCodec.encode(f));
    }

    /** A player left: forget their parts counter and pending requests. */
    public void playerLeft(ServerPlayer p) {
        frameIds.remove(p.getUUID());
        pending.values().removeIf(q -> q.player.equals(p.getUUID()));
    }

    // ── clients → MCP ─────────────────────────────────────────────────────────────────────────

    /**
     * A client's {@link UiPayload#REQUEST}. Forwards it as a {@code ui.request} with the next number
     * and the player from the connection; answers the client itself when that can't be done (no MCP
     * with {@code ui}, a malformed request).
     */
    public void clientRequest(ServerPlayer p, UiPayload payload) {
        long clientId = 0;
        String kind;
        JsonObject args;
        try {
            JsonElement e = Json.parse(payload.text());
            if (!e.isJsonObject()) throw ProtocolException.badRequest(null, "a ui.request header must be an object");
            JsonObject h = e.getAsJsonObject();
            clientId = Json.reqLong(h, "request", null);
            kind = Json.reqString(h, "kind", null);
            args = h.has("args") ? Json.reqObject(h, "args", null) : new JsonObject();
        } catch (ProtocolException | RuntimeException ex) {
            reply(p, clientId, "bad_request", "the client sent a malformed request: " + ex.getMessage());
            return;
        }
        if (!enabled()) {
            reply(p, clientId, "internal", bridge.connected() ? "the Autosketch MCP server is too old for the in-game UI" : "the Autosketch MCP isn't connected");
            return;
        }
        long id = requests.incrementAndGet();
        pending.put(id, new Pending(p.getUUID(), clientId, kind, args));
        if (!bridge.send(new UiRequest(id, new Player(p.getGameProfile().getName(), p.getUUID()), kind, args).encode())) {
            pending.remove(id);
            reply(p, clientId, "internal", "the Autosketch MCP isn't connected");
        }
    }

    private void reply(ServerPlayer p, long clientId, String error, String message) {
        sendFrame(p, FrameCodec.encode(UiResult.error(Math.max(clientId, 1), p.getUUID(), error, message).encode()));
    }

    private void failPending(String message) {
        MinecraftServer server = Platform.get().currentServer();
        for (Pending q : List.copyOf(pending.values())) {
            ServerPlayer p = server == null ? null : server.getPlayerList().getPlayer(q.player);
            if (p != null) reply(p, q.clientId, "internal", message);
        }
        pending.clear();
    }
}
