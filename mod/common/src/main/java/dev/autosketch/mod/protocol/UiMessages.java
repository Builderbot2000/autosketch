package dev.autosketch.mod.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.autosketch.mod.protocol.BodyTypes.SnapshotRegion;
import dev.autosketch.mod.protocol.BodyTypes.WorldBlock;
import dev.autosketch.mod.protocol.Messages.Player;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;
import org.jetbrains.annotations.Nullable;

/**
 * The in-game UI messages (13, *Message schemas*, *In-game UI*; 16), feature {@code ui}, added within
 * protocol 3. None carries an {@code id}: {@code ui.request} and {@code ui.result} pair up by
 * {@code request}, from the mod's UI counter. Every MCP → mod message names its {@code players}
 * ({@code ui.result} its one {@code player}). The relay (server half) reads only {@link #players};
 * the client half decodes the rest with these classes, so both halves share one codec with the MCP.
 */
public final class UiMessages {
    private UiMessages() {}

    /** The feature name both hellos list (13, *Versions and features*). */
    public static final String FEATURE_UI = "ui";

    /** Every MCP → mod message type the feature adds (the relay forwards exactly these). */
    public static final Set<String> MCP_TYPES = Set.of("ui.state", "ui.flash", "ui.ghost", "ui.ghost.clear", "replay.frame", "ui.result");

    /** The coalescing window the MCP keeps for {@code ui.state}, {@code ui.flash} and ghost updates. */
    public static final int COALESCE_MS = 250;

    /** Largest piece of a frame in one relay packet to a client (13, *Relay to the client*). */
    public static final int PART_BYTES = 1_000_000;

    /** Request kinds (13, *Request kinds*); the MCP answers any other with {@code bad_request}. */
    public static final List<String> REQUEST_KINDS = List.of("resync", "settings.list", "settings.set", "settings.unset", "library.list", "library.entry",
            "library.thumbnail", "library.preview", "library.rename", "library.duplicate", "library.delete", "library.trash", "library.restore", "library.hide",
            "library.copy", "library.empty_trash", "logs.list", "replay.open", "replay.seek", "replay.close", "ghost.anchor", "ghost.clear",
            "candidates.open", "candidates.ghost", "candidates.ghost.clear", "candidates.submit");

    /** {@code ui.result} error codes; {@code answered} (17, piece 3): the candidates were already answered. */
    public static final List<String> ERRORS = List.of("not_allowed", "conflict", "not_found", "bad_request", "busy", "internal", "answered");

    /** The id of the session's candidate ghost, the {@code ghost} a {@code candidates.ghost} answers (17, piece 3). */
    public static final String CANDIDATE_GHOST = "candidate";

    public static final List<String> MARKERS = List.of("fork", "merge", "refusal", "checkpoint");

    private static final Pattern COLOUR = Pattern.compile("#[0-9a-f]{6}");

    // ── shared pieces ─────────────────────────────────────────────────────────────────────────

    /**
     * The players an MCP → mod {@code ui} message is for: {@code players}, or {@code player} on a
     * {@code ui.result}. What the relay checks before forwarding; anything malformed is
     * {@code bad_request}.
     */
    public static List<UUID> players(Frame f) throws ProtocolException {
        if (f.type().equals("ui.result")) return List.of(Messages.parseUuid(Json.reqString(f.header(), "player", null), null));
        return readPlayers(f.header());
    }

    static List<UUID> readPlayers(JsonObject h) throws ProtocolException {
        JsonArray a = Json.reqArray(h, "players", null);
        if (a.isEmpty()) throw ProtocolException.badRequest(null, "\"players\" must not be empty");
        List<UUID> out = new ArrayList<>(a.size());
        for (JsonElement e : a) {
            if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) throw ProtocolException.badRequest(null, "\"players\" must hold UUIDs");
            out.add(Messages.parseUuid(e.getAsString(), null));
        }
        return List.copyOf(out);
    }

    static JsonArray writePlayers(List<UUID> players) {
        JsonArray a = new JsonArray(players.size());
        for (UUID u : players) a.add(u.toString());
        return a;
    }

    /** {@code "#rrggbb"} as 0xRRGGBB. */
    public static int parseColour(String s) throws ProtocolException {
        if (!COLOUR.matcher(s).matches()) throw ProtocolException.badRequest(null, "colour \"" + s + "\" must be #rrggbb, lowercase");
        return Integer.parseInt(s.substring(1), 16);
    }

    public static String colour(int rgb) {
        return String.format(Locale.ROOT, "#%06x", rgb & 0xFFFFFF);
    }

    private static JsonObject obj(JsonElement e, String what) throws ProtocolException {
        if (!e.isJsonObject()) throw ProtocolException.badRequest(null, what + " must be an object");
        return e.getAsJsonObject();
    }

    private static List<String> strings(JsonObject h, String key) throws ProtocolException {
        List<String> l = Json.optStrings(h, key, null);
        if (l == null) throw ProtocolException.badRequest(null, "\"" + key + "\" is missing");
        return l;
    }

    /** A job as the overlays draw it (13, *In-game UI*, Job). */
    public record Job(String id, int colour, String brief, String dimension, Box work, List<Box> context) {
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("id", id);
            o.addProperty("colour", UiMessages.colour(colour));
            o.addProperty("brief", brief);
            o.addProperty("dimension", dimension);
            o.add("work", work.toJson());
            o.add("context", Json.boxes(context));
            return o;
        }

        public static Job fromJson(JsonElement e) throws ProtocolException {
            JsonObject o = obj(e, "a job");
            return new Job(Json.reqString(o, "id", null), parseColour(Json.reqString(o, "colour", null)), Json.reqString(o, "brief", null),
                    Json.reqString(o, "dimension", null), Box.fromJson(Json.req(o, "work", null), "work", null), Json.reqBoxes(o, "context", null));
        }
    }

    /** Boxes one job just changed (13, *In-game UI*, Flash). */
    public record Flash(String job, int colour, String dimension, List<Box> boxes) {
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("job", job);
            o.addProperty("colour", UiMessages.colour(colour));
            o.addProperty("dimension", dimension);
            o.add("boxes", Json.boxes(boxes));
            return o;
        }

        public static Flash fromJson(JsonElement e) throws ProtocolException {
            JsonObject o = obj(e, "a flash");
            List<Box> boxes = Json.reqBoxes(o, "boxes", null);
            if (boxes.isEmpty()) throw ProtocolException.badRequest(null, "a flash needs boxes");
            return new Flash(Json.reqString(o, "job", null), parseColour(Json.reqString(o, "colour", null)), Json.reqString(o, "dimension", null), boxes);
        }
    }

    private static JsonArray jobs(List<Job> jobs) {
        JsonArray a = new JsonArray();
        for (Job j : jobs) a.add(j.toJson());
        return a;
    }

    private static List<Job> readJobs(JsonObject h) throws ProtocolException {
        List<Job> out = new ArrayList<>();
        for (JsonElement e : Json.reqArray(h, "jobs", null)) out.add(Job.fromJson(e));
        return List.copyOf(out);
    }

    private static JsonArray flashes(List<Flash> flashes) {
        JsonArray a = new JsonArray();
        for (Flash f : flashes) a.add(f.toJson());
        return a;
    }

    private static List<Flash> readFlashes(JsonObject h) throws ProtocolException {
        List<Flash> out = new ArrayList<>();
        for (JsonElement e : Json.reqArray(h, "flashes", null)) out.add(Flash.fromJson(e));
        return List.copyOf(out);
    }

    // ── ui.state ──────────────────────────────────────────────────────────────────────────────

    /** The open in-game request. */
    public record RequestInfo(long id, String mode, String text) {}

    /** Token totals of the current prompt; {@code cost} in US dollars, null when none was reported. */
    public record Tokens(long input, long output, long cacheRead, long cacheCreation, @Nullable Double cost) {}

    public record Refusal(String code, String text) {}

    /**
     * {@code ui.state}. Full: {@code jobs} and the three optional fields are all given (an empty
     * {@link Optional} means none). Changes: {@code jobs} holds the added or changed jobs whole
     * (replace by id), {@code removed} the ended ones, and each optional field is null when unchanged,
     * empty when cleared.
     */
    public record UiState(List<UUID> players, long seq, boolean full, List<Job> jobs, List<String> removed, @Nullable Optional<RequestInfo> request,
            @Nullable Optional<Tokens> tokens, @Nullable Optional<Refusal> refusal) {
        public Frame encode() {
            JsonObject h = Json.header("ui.state");
            h.add("players", writePlayers(players));
            h.addProperty("seq", seq);
            h.addProperty("full", full);
            if (full || !jobs.isEmpty()) h.add("jobs", UiMessages.jobs(jobs));
            if (!full && !removed.isEmpty()) h.add("removed", Json.strings(removed));
            if (request != null) h.add("request", request.map(r -> {
                JsonObject o = new JsonObject();
                o.addProperty("id", r.id());
                o.addProperty("mode", r.mode());
                o.addProperty("text", r.text());
                return (JsonElement) o;
            }).orElse(com.google.gson.JsonNull.INSTANCE));
            if (tokens != null) h.add("tokens", tokens.map(t -> {
                JsonObject o = new JsonObject();
                o.addProperty("input", t.input());
                o.addProperty("output", t.output());
                o.addProperty("cacheRead", t.cacheRead());
                o.addProperty("cacheCreation", t.cacheCreation());
                if (t.cost() != null) o.addProperty("cost", t.cost());
                return (JsonElement) o;
            }).orElse(com.google.gson.JsonNull.INSTANCE));
            if (refusal != null) h.add("refusal", refusal.map(r -> {
                JsonObject o = new JsonObject();
                o.addProperty("code", r.code());
                o.addProperty("text", r.text());
                return (JsonElement) o;
            }).orElse(com.google.gson.JsonNull.INSTANCE));
            return new Frame(h);
        }

        public static UiState decode(Frame f) throws ProtocolException {
            JsonObject h = f.header();
            List<UUID> players = readPlayers(h);
            long seq = Json.reqLong(h, "seq", null);
            if (seq < 1) throw ProtocolException.badRequest(null, "\"seq\" must be at least 1");
            boolean full = Json.reqBool(h, "full", null);
            List<Job> jobs = full || h.has("jobs") ? readJobs(h) : List.of();
            if (full && h.has("removed")) throw ProtocolException.badRequest(null, "a full ui.state removes nothing");
            List<String> removed = h.has("removed") ? strings(h, "removed") : List.of();
            Optional<RequestInfo> request = field(h, "request", full, o -> {
                String mode = Json.reqString(o, "mode", null);
                if (!Messages.REQUEST_MODES.contains(mode)) throw ProtocolException.badRequest(null, "unknown mode " + mode);
                return new RequestInfo(Json.reqLong(o, "id", null), mode, Json.reqString(o, "text", null));
            });
            Optional<Tokens> tokens = field(h, "tokens", full, o -> new Tokens(Json.reqLong(o, "input", null), Json.reqLong(o, "output", null),
                    Json.reqLong(o, "cacheRead", null), Json.reqLong(o, "cacheCreation", null), o.has("cost") ? o.get("cost").getAsDouble() : null));
            Optional<Refusal> refusal = field(h, "refusal", full, o -> new Refusal(Json.reqString(o, "code", null), Json.reqString(o, "text", null)));
            return new UiState(players, seq, full, jobs, removed, request, tokens, refusal);
        }
    }

    private interface Reader<T> {
        T read(JsonObject o) throws ProtocolException;
    }

    /** A field that is absent (null: unchanged; required when {@code full}), {@code null} (empty: none) or an object. */
    private static <T> @Nullable Optional<T> field(JsonObject h, String key, boolean full, Reader<T> r) throws ProtocolException {
        if (!h.has(key)) {
            if (full) throw ProtocolException.badRequest(null, "a full ui.state gives \"" + key + "\"");
            return null;
        }
        JsonElement e = h.get(key);
        return e.isJsonNull() ? Optional.empty() : Optional.of(r.read(obj(e, "\"" + key + "\"")));
    }

    // ── ui.flash ──────────────────────────────────────────────────────────────────────────────

    public record UiFlash(List<UUID> players, List<Flash> flashes) {
        public Frame encode() {
            JsonObject h = Json.header("ui.flash");
            h.add("players", writePlayers(players));
            h.add("flashes", UiMessages.flashes(flashes));
            return new Frame(h);
        }

        public static UiFlash decode(Frame f) throws ProtocolException {
            List<UUID> players = readPlayers(f.header());
            List<Flash> flashes = readFlashes(f.header());
            if (flashes.isEmpty()) throw ProtocolException.badRequest(null, "ui.flash needs flashes");
            return new UiFlash(players, flashes);
        }
    }

    // ── ui.ghost, ui.ghost.clear ──────────────────────────────────────────────────────────────

    /** One whole 16³ section of a ghost's local grid: a palette index per position, x fastest, then z, then y. */
    public record GhostSection(int sx, int sy, int sz, int[] states) {
        public Box box() {
            return Box.section(sx, sy, sz);
        }
    }

    /**
     * {@code ui.ghost}: whole sections of the ghost's local grid at {@code origin} (world), states only.
     * {@code full}: these are the whole ghost; otherwise they replace those sections. {@code palette}
     * may hold unused or out-of-order entries; the encoder writes the used ones in first-use order.
     */
    public record UiGhost(List<UUID> players, String ghost, String dimension, int originX, int originY, int originZ, int tint, boolean full, List<String> palette,
            List<GhostSection> sections) {
        public Frame encode() {
            JsonObject h = Json.header("ui.ghost");
            h.add("players", writePlayers(players));
            h.addProperty("ghost", ghost);
            h.addProperty("dimension", dimension);
            h.add("origin", Json.vec(originX, originY, originZ));
            h.addProperty("tint", colour(tint));
            h.addProperty("full", full);
            JsonArray s = new JsonArray();
            List<SnapshotRegion> regions = new ArrayList<>(sections.size());
            for (GhostSection g : sections) {
                s.add(Json.vec(g.sx, g.sy, g.sz));
                regions.add(new SnapshotRegion(g.box(), g.states, List.of()));
            }
            h.add("sections", s);
            return new Frame(h, Bodies.encodeSnapshot(palette, regions));
        }

        public static UiGhost decode(Frame f) throws ProtocolException {
            JsonObject h = f.header();
            List<UUID> players = readPlayers(h);
            int[] o = Json.reqVec(h, "origin", null);
            List<int[]> secs = new ArrayList<>();
            for (JsonElement e : Json.reqArray(h, "sections", null)) {
                int[] s = Json.asVec(e, "a section", null);
                if (!secs.isEmpty()) {
                    int[] p = secs.get(secs.size() - 1);
                    int cmp = p[1] != s[1] ? Integer.compare(p[1], s[1]) : p[2] != s[2] ? Integer.compare(p[2], s[2]) : Integer.compare(p[0], s[0]);
                    if (cmp >= 0) throw ProtocolException.badRequest(null, "ui.ghost: sections must be unique and ascending by sy, then sz, then sx");
                }
                secs.add(s);
            }
            Bodies.SnapshotBody body = Bodies.decodeSnapshot(f.body(), secs.stream().map(s -> Box.section(s[0], s[1], s[2])).toList());
            List<GhostSection> sections = new ArrayList<>(secs.size());
            for (int i = 0; i < secs.size(); i++) {
                SnapshotRegion r = body.regions().get(i);
                if (!r.blockEntities().isEmpty()) throw ProtocolException.badRequest(null, "ui.ghost carries no NBT");
                sections.add(new GhostSection(secs.get(i)[0], secs.get(i)[1], secs.get(i)[2], r.states()));
            }
            return new UiGhost(players, Json.reqString(h, "ghost", null), Json.reqString(h, "dimension", null), o[0], o[1], o[2],
                    parseColour(Json.reqString(h, "tint", null)), Json.reqBool(h, "full", null), body.palette(), List.copyOf(sections));
        }
    }

    public record UiGhostClear(List<UUID> players, String ghost) {
        public Frame encode() {
            JsonObject h = Json.header("ui.ghost.clear");
            h.add("players", writePlayers(players));
            h.addProperty("ghost", ghost);
            return new Frame(h);
        }

        public static UiGhostClear decode(Frame f) throws ProtocolException {
            return new UiGhostClear(readPlayers(f.header()), Json.reqString(f.header(), "ghost", null));
        }
    }

    // ── replay.frame ──────────────────────────────────────────────────────────────────────────

    public record Hud(String call, @Nullable String brief, @Nullable String note) {}

    public record Marker(long step, String kind, String label) {}

    /**
     * {@code replay.frame}. A keyframe ({@code keyframe}) has {@code regions} (every position, states
     * only, indexing {@code palette}) and {@code markers}; a delta has {@code from} and {@code blocks}
     * (states only, no NBT), and the other two lists empty.
     */
    public record ReplayFrame(List<UUID> players, String replay, long step, long steps, boolean keyframe, long from, String dimension, List<String> palette,
            List<SnapshotRegion> regions, List<WorldBlock> blocks, String time, Hud hud, List<Job> jobs, List<Flash> flashes, List<Marker> markers) {
        public Frame encode() {
            JsonObject h = Json.header("replay.frame");
            h.add("players", writePlayers(players));
            h.addProperty("replay", replay);
            h.addProperty("step", step);
            h.addProperty("steps", steps);
            h.addProperty("keyframe", keyframe);
            byte[] body;
            if (keyframe) {
                h.addProperty("dimension", dimension);
                h.add("regions", Json.boxes(regions.stream().map(SnapshotRegion::box).toList()));
                body = Bodies.encodeSnapshot(palette, regions);
            } else {
                h.addProperty("from", from);
                h.addProperty("dimension", dimension);
                BodyTypes.Encoded e = Bodies.encodeDirty(blocks);
                e.grid().writeTo(h);
                h.addProperty("count", blocks.size());
                body = e.body();
            }
            h.addProperty("time", time);
            JsonObject hd = new JsonObject();
            hd.addProperty("call", hud.call());
            hd.add("brief", Json.nullable(hud.brief()));
            if (hud.note() != null) hd.addProperty("note", hud.note());
            h.add("hud", hd);
            h.add("jobs", UiMessages.jobs(jobs));
            h.add("flashes", UiMessages.flashes(flashes));
            if (keyframe) {
                JsonArray m = new JsonArray();
                for (Marker k : markers) {
                    JsonObject o = new JsonObject();
                    o.addProperty("step", k.step());
                    o.addProperty("kind", k.kind());
                    o.addProperty("label", k.label());
                    m.add(o);
                }
                h.add("markers", m);
            }
            return new Frame(h, body);
        }

        public static ReplayFrame decode(Frame f) throws ProtocolException {
            JsonObject h = f.header();
            List<UUID> players = readPlayers(h);
            boolean keyframe = Json.reqBool(h, "keyframe", null);
            JsonObject hd = Json.reqObject(h, "hud", null);
            Hud hud = new Hud(Json.reqString(hd, "call", null), Json.optString(hd, "brief", null), Json.optString(hd, "note", null));
            String dimension = Json.reqString(h, "dimension", null);
            List<String> palette = List.of();
            List<SnapshotRegion> regions = List.of();
            List<WorldBlock> blocks = List.of();
            List<Marker> markers = List.of();
            long from = 0;
            if (keyframe) {
                if (h.has("from") || h.has("origin")) throw ProtocolException.badRequest(null, "a replay keyframe has regions, not from, origin or size");
                Bodies.SnapshotBody body = Bodies.decodeSnapshot(f.body(), Json.reqBoxes(h, "regions", null));
                for (SnapshotRegion r : body.regions()) if (!r.blockEntities().isEmpty()) throw ProtocolException.badRequest(null, "replay.frame carries no NBT");
                palette = body.palette();
                regions = body.regions();
                List<Marker> ms = new ArrayList<>();
                for (JsonElement e : Json.reqArray(h, "markers", null)) {
                    JsonObject o = obj(e, "a marker");
                    String kind = Json.reqString(o, "kind", null);
                    if (!MARKERS.contains(kind)) throw ProtocolException.badRequest(null, "unknown marker kind " + kind);
                    ms.add(new Marker(Json.reqLong(o, "step", null), kind, Json.reqString(o, "label", null)));
                }
                markers = List.copyOf(ms);
            } else {
                if (h.has("regions") || h.has("markers")) throw ProtocolException.badRequest(null, "regions and markers belong to a replay keyframe");
                from = Json.reqLong(h, "from", null);
                blocks = Bodies.decodeDirty(f.body(), Grid.readFrom(h, null), Json.reqCount(h, "count", null));
                for (WorldBlock b : blocks) if (b.nbt() != null) throw ProtocolException.badRequest(null, "replay.frame carries no NBT");
            }
            return new ReplayFrame(players, Json.reqString(h, "replay", null), Json.reqLong(h, "step", null), Json.reqLong(h, "steps", null), keyframe, from,
                    dimension, palette, regions, blocks, Json.reqString(h, "time", null), hud, readJobs(h), readFlashes(h), markers);
        }
    }

    // ── ui.request, ui.result ─────────────────────────────────────────────────────────────────

    /** {@code ui.request}, mod → MCP: numbered by {@code request} from the mod's UI counter; {@code player} set by the server half. */
    public record UiRequest(long request, Player player, String kind, JsonObject args) {
        public Frame encode() {
            JsonObject h = Json.header("ui.request");
            h.addProperty("request", request);
            h.add("player", player.toJson());
            h.addProperty("kind", kind);
            h.add("args", args);
            return new Frame(h);
        }

        public static UiRequest decode(Frame f) throws ProtocolException {
            JsonObject h = f.header();
            long request = Json.reqLong(h, "request", null);
            if (request < 1) throw ProtocolException.badRequest(null, "\"request\" must be at least 1");
            return new UiRequest(request, Player.fromJson(Json.reqObject(h, "player", null), null), Json.reqString(h, "kind", null), Json.reqObject(h, "args", null));
        }
    }

    /**
     * {@code ui.result}, MCP → mod. {@code ok}: {@code result} is set and {@code body} may hold the
     * kind's binary result (a PNG, a preview region); otherwise {@code error} and {@code message}.
     */
    public record UiResult(long request, UUID player, boolean ok, @Nullable JsonObject result, @Nullable String error, @Nullable String message, byte[] body) {
        public static UiResult ok(long request, UUID player, JsonObject result) {
            return new UiResult(request, player, true, result, null, null, new byte[0]);
        }

        public static UiResult error(long request, UUID player, String error, String message) {
            return new UiResult(request, player, false, null, error, message, new byte[0]);
        }

        public Frame encode() {
            JsonObject h = Json.header("ui.result");
            h.addProperty("request", request);
            h.addProperty("player", player.toString());
            h.addProperty("ok", ok);
            if (ok) {
                h.add("result", result == null ? new JsonObject() : result);
                return new Frame(h, body);
            }
            h.addProperty("error", error);
            h.addProperty("message", message);
            return new Frame(h);
        }

        public static UiResult decode(Frame f) throws ProtocolException {
            JsonObject h = f.header();
            long request = Json.reqLong(h, "request", null);
            UUID player = Messages.parseUuid(Json.reqString(h, "player", null), null);
            if (Json.reqBool(h, "ok", null)) return new UiResult(request, player, true, Json.reqObject(h, "result", null), null, null, f.body());
            if (f.hasBody()) throw ProtocolException.badRequest(null, "a failed ui.result carries no body");
            String error = Json.reqString(h, "error", null);
            if (!ERRORS.contains(error)) throw ProtocolException.badRequest(null, "unknown ui.result error " + error);
            return new UiResult(request, player, false, null, error, Json.reqString(h, "message", null), f.body());
        }
    }

    /** Decodes any MCP → mod {@code ui} message by its type (the client half's entry point). */
    public static Record decode(Frame f) throws ProtocolException {
        return switch (f.type()) {
            case "ui.state" -> UiState.decode(f);
            case "ui.flash" -> UiFlash.decode(f);
            case "ui.ghost" -> UiGhost.decode(f);
            case "ui.ghost.clear" -> UiGhostClear.decode(f);
            case "replay.frame" -> ReplayFrame.decode(f);
            case "ui.result" -> UiResult.decode(f);
            case "ui.request" -> UiRequest.decode(f);
            default -> throw ProtocolException.badRequest(null, "not a ui message: " + f.type());
        };
    }

    /** Splits an encoded frame into the relay's parts of at most {@link #PART_BYTES} (13, *Relay to the client*). */
    public static List<byte[]> split(byte[] frame) {
        List<byte[]> out = new ArrayList<>();
        for (int p = 0; p < frame.length; p += PART_BYTES) out.add(java.util.Arrays.copyOfRange(frame, p, Math.min(frame.length, p + PART_BYTES)));
        if (out.isEmpty()) out.add(frame);
        return out;
    }
}
