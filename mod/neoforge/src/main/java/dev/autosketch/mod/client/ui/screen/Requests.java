package dev.autosketch.mod.client.ui.screen;

import com.google.gson.JsonObject;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.UiClient;
import dev.autosketch.mod.protocol.UiMessages.UiResult;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;

/**
 * The screens' way to send {@code ui.request}s (13, *Request kinds*): one request of a kind in
 * flight at a time, the rest queued in order, so the screens never trip the MCP's {@code busy}
 * (a second request of the same kind while the first is served). A library grid asks for a dozen
 * thumbnails at once; they go one after another. Client thread only.
 *
 * <p>Offline, nothing is sent: the callback gets an {@code internal} error at once, worded like
 * the relay's own answer.
 */
final class Requests {
    private Requests() {}

    private record Pending(JsonObject args, Consumer<UiResult> callback) {}

    private static final Map<String, ArrayDeque<Pending>> queues = new HashMap<>();
    private static final Map<String, Boolean> inFlight = new HashMap<>();

    static void send(String kind, JsonObject args, Consumer<UiResult> callback) {
        if (!LinkState.connected()) {
            callback.accept(UiResult.error(0, new java.util.UUID(0, 0), "internal", "the Autosketch MCP isn't connected"));
            return;
        }
        queues.computeIfAbsent(kind, k -> new ArrayDeque<>()).add(new Pending(args, callback));
        if (!inFlight.getOrDefault(kind, false)) next(kind);
    }

    /** Drops every queued (not yet sent) request; their callbacks never run. */
    static void clearQueued() {
        queues.clear();
    }

    private static void next(String kind) {
        ArrayDeque<Pending> q = queues.get(kind);
        Pending p = q == null ? null : q.poll();
        if (p == null) {
            inFlight.put(kind, false);
            return;
        }
        inFlight.put(kind, true);
        UiClient.request(kind, p.args, r -> {
            try {
                p.callback.accept(r);
            } finally {
                next(kind);
            }
        });
    }

    /** Resets after a disconnect (UiClient drops its waiting callbacks then, so nothing would free the kinds). */
    static void reset() {
        queues.clear();
        inFlight.clear();
    }

    /** Args builder: {@code args("root", r, "name", n)}; values are strings, booleans or JSON. */
    static JsonObject args(Object... kv) {
        JsonObject o = new JsonObject();
        for (int i = 0; i + 1 < kv.length; i += 2) {
            String k = (String) kv[i];
            Object v = kv[i + 1];
            if (v == null) o.add(k, com.google.gson.JsonNull.INSTANCE);
            else if (v instanceof Boolean b) o.addProperty(k, b);
            else if (v instanceof Number n) o.addProperty(k, n);
            else if (v instanceof com.google.gson.JsonElement e) o.add(k, e);
            else o.addProperty(k, v.toString());
        }
        return o;
    }
}
