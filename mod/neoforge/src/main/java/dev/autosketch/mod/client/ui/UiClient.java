package dev.autosketch.mod.client.ui;

import com.google.gson.JsonObject;
import com.mojang.logging.LogUtils;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.UiMessages;
import dev.autosketch.mod.protocol.UiMessages.UiResult;
import dev.autosketch.mod.ui.UiNetwork;
import dev.autosketch.mod.ui.relay.UiPayload;
import java.io.ByteArrayOutputStream;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.neoforge.client.event.ClientPlayerNetworkEvent;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.common.NeoForge;
import org.slf4j.Logger;

/**
 * The client half's entry for the in-game UI (16, *Mod side*): takes {@code autosketch:ui} packets,
 * joins frame parts in order, decodes each frame with the shared codec ({@link UiMessages}) and
 * dispatches it by type to the handlers silos registered with {@link #register}; writes the link
 * state into {@link LinkState}; and sends requests ({@link #request}), matching each
 * {@code ui.result} to its callback by the client's own number. Nothing here decides anything
 * about scopes, steps, settings or the library: handlers draw what arrives.
 *
 * <p>Until a feature registers, every kind goes to a handler that only logs it (and counts it,
 * {@link #received}), so the path is testable end to end.
 */
public final class UiClient {
    private UiClient() {}

    private static final Logger LOG = LogUtils.getLogger();

    /** A handler for one message type: the frame and its decoded message ({@code UiMessages.UiState}, ...). */
    @FunctionalInterface
    public interface Handler {
        void handle(Frame frame, Record message);
    }

    private static final Map<String, List<Handler>> handlers = new ConcurrentHashMap<>();
    private static final Map<String, Integer> counts = new ConcurrentHashMap<>();
    private static final Map<Long, Consumer<UiResult>> waiting = new ConcurrentHashMap<>();
    private static long nextRequest;
    private static long partsId = -1;
    private static int partsNext;
    private static ByteArrayOutputStream partsBuffer = new ByteArrayOutputStream();

    /** Wires the client half: packets, key mappings, the link state's reset on leaving. Called once from {@code AutosketchClient}. */
    public static void init(IEventBus modBus) {
        UiNetwork.clientSink = UiClient::accept;
        modBus.addListener(AutosketchKeys::register);
        NeoForge.EVENT_BUS.addListener(AutosketchKeys::tick);
        NeoForge.EVENT_BUS.addListener((ClientPlayerNetworkEvent.LoggingOut e) -> reset());
    }

    /** Adds a handler for one MCP → mod type ({@code ui.state}, {@code ui.ghost}, {@code replay.frame}, ...). */
    public static void register(String type, Handler handler) {
        handlers.computeIfAbsent(type, k -> new CopyOnWriteArrayList<>()).add(handler);
    }

    /** How many messages of a type arrived since the client started (for tests). */
    public static int received(String type) {
        return counts.getOrDefault(type, 0);
    }

    /**
     * Sends a {@code ui.request} through the server half; {@code onResult} runs on the client thread
     * with the answer (an error result when the server half or the MCP couldn't serve it). Callers
     * check {@link LinkState#connected()} first.
     */
    public static void request(String kind, JsonObject args, Consumer<UiResult> onResult) {
        long id = ++nextRequest;
        waiting.put(id, onResult);
        JsonObject h = Json.header("ui.request");
        h.addProperty("request", id);
        h.addProperty("kind", kind);
        h.add("args", args);
        UiNetwork.sendToServer(UiPayload.request(Json.write(h)));
    }

    /** Client thread: one packet from the server half. */
    static void accept(UiPayload p) {
        switch (p.op()) {
            case UiPayload.LINK -> LinkState.set(LinkState.State.fromWire(p.text()));
            case UiPayload.FRAME -> part(p);
            default -> LOG.debug("Autosketch UI: ignoring packet op {}", p.op());
        }
    }

    private static void part(UiPayload p) {
        if (p.part() == 0) {
            partsId = p.id();
            partsNext = 0;
            partsBuffer = new ByteArrayOutputStream();
        }
        if (p.id() != partsId || p.part() != partsNext) {
            LOG.warn("Autosketch UI: dropped part {} of {} (frame {}), expected part {} of frame {}", p.part(), p.parts(), p.id(), partsNext, partsId);
            partsId = -1;
            return;
        }
        partsBuffer.writeBytes(p.data());
        partsNext++;
        if (partsNext < p.parts()) return;
        byte[] bytes = partsBuffer.toByteArray();
        partsBuffer = new ByteArrayOutputStream();
        partsId = -1;
        try {
            dispatch(FrameCodec.decode(bytes));
        } catch (ProtocolException | RuntimeException e) {
            LOG.warn("Autosketch UI: dropped an undecodable frame of {} bytes: {}", bytes.length, e.getMessage());
        }
    }

    static void dispatch(Frame f) throws ProtocolException {
        Record m = UiMessages.decode(f);
        counts.merge(f.type(), 1, Integer::sum);
        if (m instanceof UiResult r) {
            Consumer<UiResult> c = waiting.remove(r.request());
            if (c != null) c.accept(r);
        }
        List<Handler> hs = handlers.get(f.type());
        if (hs == null || hs.isEmpty()) {
            LOG.debug("Autosketch UI: {} ({} bytes of body), no handler yet", f.type(), f.body().length);
            return;
        }
        for (Handler h : hs) h.handle(f, m);
    }

    private static void reset() {
        LinkState.set(LinkState.State.OFFLINE);
        waiting.clear();
        partsId = -1;
        partsBuffer = new ByteArrayOutputStream();
    }
}
