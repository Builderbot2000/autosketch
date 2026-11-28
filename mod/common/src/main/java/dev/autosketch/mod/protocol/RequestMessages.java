package dev.autosketch.mod.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import dev.autosketch.mod.protocol.Messages.Player;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.jetbrains.annotations.Nullable;

/**
 * Request control and the canvas on the wire (19; 13, *Message schemas*, *Request control and
 * canvas*), features {@code requests} and {@code canvas}, added within protocol 4: the status line
 * ({@code chat} kind {@code status}), {@code request.control} (the server-side commands
 * {@code /autosketch stop}, {@code queue}, {@code queue cancel <n>}), {@code canvas} and
 * {@code canvas.set}. The queued {@code prompt.result} is {@link Messages.PromptResult}, the
 * request-control {@code ui.request} kinds are in {@link UiMessages#REQUEST_KINDS}. Header keys are
 * written in the schema tables' order; a bad field is {@code bad_request}.
 */
public final class RequestMessages {
    private RequestMessages() {}

    /**
     * The features, each in both hellos. {@code requests}: the MCP sends status lines and answers the
     * request-control kinds and {@code request.control}; the mod shows the lines and sends those.
     * {@code canvas}: the mod has a canvas, sends {@code canvas}, accepts {@code canvas.set} and serves
     * reads inside the canvas. Neither side sends a feature's message unless both hellos list it
     * ({@code canvas.set} needs the mod's, {@code request.control} and {@code canvas} the MCP's).
     */
    public static final String FEATURE_REQUESTS = "requests", FEATURE_CANVAS = "canvas";

    /** Status-line states (19, *Status line*). */
    public static final List<String> STATES = List.of("working", "stopping", "done", "stopped", "queued");
    /** What a {@code request.control} asks. */
    public static final List<String> CONTROL_ACTIONS = List.of("stop", "queue", "queue.cancel");
    /** The request-control {@code ui.request} kinds; each takes {@code {request}}. */
    public static final List<String> UI_KINDS = List.of("request.stop", "queue.send", "queue.cancel", "request.undo");
    /** Most prompts one player's queue holds; past it the MCP refuses {@code busy}. */
    public static final int QUEUE_MAX = 8;
    /** The default {@code canvasChunks}: the most chunks a canvas spans on either horizontal axis. */
    public static final int CANVAS_CHUNKS = 256;

    /** Whether a {@code chat} frame is a status line (route it to {@link Status#decode}, not {@link Messages.Chat#decode}). */
    public static boolean isStatus(Frame f) {
        JsonElement k = f.header().get("kind");
        return f.type().equals("chat") && k != null && k.isJsonPrimitive() && k.getAsString().equals("status");
    }

    /** Whether a frame is one of this class's messages. */
    public static boolean handles(Frame f) {
        return switch (f.type()) {
            case "request.control", "canvas", "canvas.set" -> true;
            case "chat" -> isStatus(f);
            default -> false;
        };
    }

    /** Decodes any message {@link #handles} accepts. */
    public static Record decode(Frame f) throws ProtocolException {
        return switch (f.type()) {
            case "chat" -> Status.decode(f);
            case "request.control" -> RequestControl.decode(f);
            case "canvas" -> Canvas.decode(f);
            case "canvas.set" -> CanvasSet.decode(f);
            default -> throw new IllegalArgumentException("not a request or canvas message: " + f.type());
        };
    }

    // ── status line ───────────────────────────────────────────────────────────────────────────

    /**
     * A button on a status line: clicking it makes the client send the {@code ui.request}
     * {@code kind} with {@code args}. {@code label} is the button's text without brackets.
     */
    public record StatusAction(String label, String kind, JsonObject args) {}

    /**
     * {@code chat} kind {@code status}, MCP → mod (19, *Status line*): a request's one status line,
     * kept by {@code request}. {@code lines} holds exactly one line, the plain text for a client
     * without the client half. {@code queuePos} is set exactly when {@code state} is {@code queued};
     * {@code noTurnSignal} only on {@code done}.
     */
    public record Status(long request, UUID player, List<String> lines, String state, String text, long calls, long elapsedMs, @Nullable Integer queuePos,
            boolean noTurnSignal, List<StatusAction> actions) {
        public Status {
            lines = List.copyOf(lines);
            actions = List.copyOf(actions);
        }

        /** The one plain line. */
        public String line() {
            return lines.get(0);
        }

        public Frame encode() {
            JsonObject h = Json.header("chat");
            h.addProperty("request", request);
            h.addProperty("player", player.toString());
            h.addProperty("kind", "status");
            h.add("lines", Json.strings(lines));
            h.addProperty("state", state);
            h.addProperty("text", text);
            h.addProperty("calls", calls);
            h.addProperty("elapsedMs", elapsedMs);
            if (queuePos != null) h.addProperty("queuePos", queuePos);
            if (noTurnSignal) h.addProperty("noTurnSignal", true);
            JsonArray a = new JsonArray();
            for (StatusAction x : actions) {
                JsonObject o = new JsonObject();
                o.addProperty("label", x.label());
                o.addProperty("kind", x.kind());
                o.add("args", x.args());
                a.add(o);
            }
            h.add("actions", a);
            return new Frame(h);
        }

        public static Status decode(Frame f) throws ProtocolException {
            if (!isStatus(f)) throw new IllegalArgumentException("not a status line");
            JsonObject h = f.header();
            long request = Json.reqLong(h, "request", null);
            if (request < 1) throw ProtocolException.badRequest(null, "\"request\" must be at least 1");
            UUID player = Messages.parseUuid(Json.reqString(h, "player", null), null);
            List<String> lines = new ArrayList<>();
            for (JsonElement e : Json.reqArray(h, "lines", null)) {
                if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) throw ProtocolException.badRequest(null, "\"lines\" must be strings");
                lines.add(e.getAsString());
            }
            if (lines.size() != 1) throw ProtocolException.badRequest(null, "a status line has exactly one line");
            String state = Json.reqString(h, "state", null);
            if (!STATES.contains(state)) throw ProtocolException.badRequest(null, "unknown status state " + state);
            Integer queuePos = h.has("queuePos") ? Json.reqInt(h, "queuePos", null) : null;
            if (queuePos != null && queuePos < 1) throw ProtocolException.badRequest(null, "\"queuePos\" must be at least 1");
            if ((queuePos != null) != state.equals("queued")) throw ProtocolException.badRequest(null, "queuePos goes exactly with state queued");
            boolean noTurnSignal = false;
            if (h.has("noTurnSignal")) {
                if (!Json.reqBool(h, "noTurnSignal", null) || !state.equals("done")) throw ProtocolException.badRequest(null, "noTurnSignal is true, only on done, or omitted");
                noTurnSignal = true;
            }
            if (h.has("action")) throw ProtocolException.badRequest(null, "a status line's buttons go in actions");
            List<StatusAction> actions = new ArrayList<>();
            for (JsonElement e : Json.reqArray(h, "actions", null)) {
                if (!e.isJsonObject()) throw ProtocolException.badRequest(null, "\"actions\" must be objects");
                JsonObject a = e.getAsJsonObject();
                String label = Json.reqString(a, "label", null), kind = Json.reqString(a, "kind", null);
                if (label.isEmpty() || kind.isEmpty()) throw ProtocolException.badRequest(null, "an action's label and kind must be non-empty");
                actions.add(new StatusAction(label, kind, Json.reqObject(a, "args", null)));
            }
            return new Status(request, player, lines, state, Json.reqString(h, "text", null), Json.reqLong(h, "calls", null), Json.reqLong(h, "elapsedMs", null),
                    queuePos, noTurnSignal, actions);
        }
    }

    // ── request.control ───────────────────────────────────────────────────────────────────────

    /**
     * {@code request.control}, mod → MCP (the MCP's hello lists {@code requests}): a player ran
     * {@code /autosketch stop}, {@code queue} or {@code queue cancel <n>}. {@code position} is set
     * exactly for {@code queue.cancel}, 1-based as {@code queue} numbers the entries. The MCP answers
     * {@code stop} and {@code queue.cancel} with a {@code notice} to the player, {@code queue} with a
     * {@code chat} reply (request null) listing the queue.
     */
    public record RequestControl(Player player, String action, @Nullable Integer position) {
        public Frame encode() {
            JsonObject h = Json.header("request.control");
            h.add("player", player.toJson());
            h.addProperty("action", action);
            if (position != null) h.addProperty("position", position);
            return new Frame(h);
        }

        public static RequestControl decode(Frame f) throws ProtocolException {
            JsonObject h = f.header();
            String action = Json.reqString(h, "action", null);
            if (!CONTROL_ACTIONS.contains(action)) throw ProtocolException.badRequest(null, "unknown request.control action " + action);
            Integer position = h.has("position") ? Json.reqInt(h, "position", null) : null;
            if (position != null && position < 1) throw ProtocolException.badRequest(null, "\"position\" must be at least 1");
            if ((position != null) != action.equals("queue.cancel")) throw ProtocolException.badRequest(null, "position goes exactly with queue.cancel");
            return new RequestControl(Player.fromJson(Json.reqObject(h, "player", null), null), action, position);
        }
    }

    // ── canvas ────────────────────────────────────────────────────────────────────────────────

    /**
     * {@code canvas}, mod → MCP (the MCP's hello lists {@code canvas}): after the hello and on every
     * change, like {@code volumes}. {@code box} is whole chunk columns over the full build height, or
     * null when none is set (then {@code dimension} is null too). {@code id} only on the
     * {@code canvas} that confirms a {@code canvas.set}.
     */
    public record Canvas(@Nullable Long id, @Nullable String dimension, @Nullable Box box) {
        public static Canvas none() {
            return new Canvas(null, null, null);
        }

        public Frame encode() {
            JsonObject h = Json.header("canvas");
            if (box == null) {
                h.add("box", JsonNull.INSTANCE);
                return new Frame(h);
            }
            if (id != null) h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.add("box", box.toJson());
            return new Frame(h);
        }

        public static Canvas decode(Frame f) throws ProtocolException {
            JsonObject h = f.header();
            JsonElement box = Json.req(h, "box", null);
            if (box.isJsonNull()) {
                if (h.has("id") || h.has("dimension")) throw ProtocolException.badRequest(null, "a canvas without a box has no id or dimension");
                return none();
            }
            Long id = h.has("id") ? Json.reqLong(h, "id", null) : null;
            if (id != null && id < 1) throw ProtocolException.badRequest(null, "\"id\" must be at least 1");
            return new Canvas(id, Json.reqString(h, "dimension", id), Box.fromJson(box, "box", id));
        }

        /** A box widened to whole chunk columns between {@code minY} and {@code maxY}, as every canvas is (19, *Setting the canvas*). */
        public static Box widen(Box b, int minY, int maxY) {
            return new Box((b.minX() >> 4) << 4, minY, (b.minZ() >> 4) << 4, ((b.maxX() >> 4) << 4) + 15, maxY, ((b.maxZ() >> 4) << 4) + 15);
        }

        /** Chunks the box spans on its wider horizontal axis (what {@code canvasChunks} caps). */
        public static int chunksAcross(Box b) {
            return Math.max((b.maxX() >> 4) - (b.minX() >> 4) + 1, (b.maxZ() >> 4) - (b.minZ() >> 4) + 1);
        }
    }

    /**
     * {@code canvas.set}, MCP → mod (the mod's hello lists {@code canvas}), a request with an id: sets
     * the canvas as if the player had marked it. The mod widens {@code box} ({@link Canvas#widen})
     * and answers with a {@code canvas} carrying the id, or {@code error} {@code bad_volumes} (over
     * {@code canvasChunks} across) or {@code wrong_dimension}.
     */
    public record CanvasSet(long id, String dimension, Box box) {
        public Frame encode() {
            JsonObject h = Json.header("canvas.set");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.add("box", box.toJson());
            return new Frame(h);
        }

        public static CanvasSet decode(Frame f) throws ProtocolException {
            Long id = f.id();
            if (id == null || id < 1) throw ProtocolException.badRequest(null, "canvas.set needs an integer id ≥ 1");
            JsonObject h = f.header();
            return new CanvasSet(id, Json.reqString(h, "dimension", id), Box.fromJson(Json.req(h, "box", id), "box", id));
        }
    }
}
