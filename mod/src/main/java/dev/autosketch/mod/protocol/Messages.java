package dev.autosketch.mod.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import dev.autosketch.mod.protocol.BodyTypes.AckLists;
import dev.autosketch.mod.protocol.BodyTypes.Encoded;
import dev.autosketch.mod.protocol.BodyTypes.PatchBlock;
import dev.autosketch.mod.protocol.BodyTypes.SnapshotRegion;
import dev.autosketch.mod.protocol.BodyTypes.WorldBlock;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Pattern;
import org.jetbrains.annotations.Nullable;

/**
 * Typed messages (13, *Wire format*, *Message schemas*). Each record encodes to a {@link Frame} with
 * header keys in the order the schema tables list them, and decodes from one, turning a missing or
 * ill-typed field into {@code bad_request} for the request's id. {@code prompt}, {@code prompt.result}
 * and {@code chat} belong to the in-game requests package and use {@link Json} directly.
 */
public final class Messages {
    private Messages() {}

    public static final int PROTOCOL_VERSION = 1;

    private static final Pattern HASH = Pattern.compile("[0-9a-f]{16}");

    /** A 64-bit hash as 16 lowercase hex digits. */
    public static String hex(long hash) {
        return String.format(Locale.ROOT, "%016x", hash);
    }

    public static long parseHex(String s, @Nullable Long id) throws ProtocolException {
        if (!HASH.matcher(s).matches()) throw ProtocolException.badRequest(id, "hash \"" + s + "\" must be 16 lowercase hex digits");
        return Long.parseUnsignedLong(s, 16);
    }

    public static UUID parseUuid(String s, @Nullable Long id) throws ProtocolException {
        try {
            UUID u = UUID.fromString(s);
            if (!u.toString().equals(s)) throw new IllegalArgumentException();
            return u;
        } catch (IllegalArgumentException e) {
            throw ProtocolException.badRequest(id, "\"" + s + "\" is not a lowercase hyphenated UUID");
        }
    }

    private static long reqId(Frame f) throws ProtocolException {
        Long id = f.id();
        if (id == null || id < 0) throw ProtocolException.badRequest(null, f.type() + " needs an integer id");
        return id;
    }

    private static void expectType(Frame f, String type) {
        if (!f.type().equals(type)) throw new IllegalArgumentException("expected a " + type + " frame, got " + f.type());
    }

    /** A player as {@code {name, uuid}}. */
    public record Player(String name, UUID uuid) {
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.addProperty("name", name);
            o.addProperty("uuid", uuid.toString());
            return o;
        }

        public static Player fromJson(JsonObject o, @Nullable Long id) throws ProtocolException {
            return new Player(Json.reqString(o, "name", id), parseUuid(Json.reqString(o, "uuid", id), id));
        }
    }

    // ── handshake ─────────────────────────────────────────────────────────────────────────────

    /** {@code hello}, MCP → mod. {@code volatileKeys} is the volatile-key list (*Hashing*), possibly empty. */
    public record McpHello(int protocol, String token, String clientName, String clientVersion, JsonObject volatileKeys) {
        public Frame encode() {
            JsonObject h = Json.header("hello");
            h.addProperty("protocol", protocol);
            h.addProperty("token", token);
            JsonObject client = new JsonObject();
            client.addProperty("name", clientName);
            client.addProperty("version", clientVersion);
            h.add("client", client);
            h.add("volatile", volatileKeys);
            return new Frame(h);
        }

        /**
         * Decodes everything but leaves the version check to the caller, which must compare
         * {@link #readProtocol} first so a newer MCP gets {@code protocol_mismatch} rather than
         * {@code bad_request} for fields it may have changed.
         */
        public static McpHello decode(Frame f) throws ProtocolException {
            expectType(f, "hello");
            JsonObject h = f.header();
            JsonObject client = Json.reqObject(h, "client", null);
            return new McpHello(Json.reqInt(h, "protocol", null), Json.reqString(h, "token", null),
                    Json.reqString(client, "name", null), Json.reqString(client, "version", null), Json.reqObject(h, "volatile", null));
        }

        /** The {@code protocol} field alone, the part every protocol version keeps. */
        public static int readProtocol(Frame f) throws ProtocolException {
            return Json.reqInt(f.header(), "protocol", null);
        }
    }

    /** {@code hello}, mod → MCP. {@code host} is the singleplayer host, null on a dedicated server. */
    public record ModHello(String modVersion, String gameVersion, int dataVersion, String loader, String loaderVersion,
            boolean singleplayer, @Nullable Player host) {
        public Frame encode() {
            JsonObject h = Json.header("hello");
            h.addProperty("protocol", PROTOCOL_VERSION);
            JsonObject mod = new JsonObject();
            mod.addProperty("version", modVersion);
            h.add("mod", mod);
            JsonObject game = new JsonObject();
            game.addProperty("version", gameVersion);
            game.addProperty("dataVersion", dataVersion);
            game.addProperty("loader", loader);
            game.addProperty("loaderVersion", loaderVersion);
            h.add("game", game);
            h.addProperty("singleplayer", singleplayer);
            h.add("host", host == null ? JsonNull.INSTANCE : host.toJson());
            return new Frame(h);
        }

        public static ModHello decode(Frame f) throws ProtocolException {
            expectType(f, "hello");
            JsonObject h = f.header();
            JsonObject game = Json.reqObject(h, "game", null);
            JsonElement host = Json.req(h, "host", null);
            return new ModHello(Json.reqString(Json.reqObject(h, "mod", null), "version", null),
                    Json.reqString(game, "version", null), Json.reqInt(game, "dataVersion", null),
                    Json.reqString(game, "loader", null), Json.reqString(game, "loaderVersion", null),
                    Json.reqBool(h, "singleplayer", null),
                    host.isJsonNull() ? null : Player.fromJson(Json.reqObject(h, "host", null), null));
        }
    }

    // ── volumes ───────────────────────────────────────────────────────────────────────────────

    /**
     * {@code volumes}, mod → MCP. With {@code work} null (unlinked) only {@code link} is sent;
     * otherwise {@code dimension}, {@code context} and, while in force, {@code extended}.
     */
    public record Volumes(long link, @Nullable String dimension, @Nullable Box work, List<Box> context, @Nullable Box extended) {
        public static Volumes none(long link) {
            return new Volumes(link, null, null, List.of(), null);
        }

        public Frame encode() {
            JsonObject h = Json.header("volumes");
            h.addProperty("link", link);
            if (work == null) {
                h.add("work", JsonNull.INSTANCE);
                return new Frame(h);
            }
            h.addProperty("dimension", dimension);
            h.add("work", work.toJson());
            h.add("context", Json.boxes(context));
            if (extended != null) h.add("extended", extended.toJson());
            return new Frame(h);
        }

        public static Volumes decode(Frame f) throws ProtocolException {
            expectType(f, "volumes");
            JsonObject h = f.header();
            long link = Json.reqLong(h, "link", null);
            JsonElement work = Json.req(h, "work", null);
            if (work.isJsonNull()) return none(link);
            Box ext = h.has("extended") ? Box.fromJson(h.get("extended"), "extended", null) : null;
            return new Volumes(link, Json.reqString(h, "dimension", null), Box.fromJson(work, "work", null), Json.reqBoxes(h, "context", null), ext);
        }
    }

    /** {@code volumes.extend}, MCP → mod: the work volume extended to whole blocks. */
    public record VolumesExtend(long id, long link, Box work) {
        public Frame encode() {
            JsonObject h = Json.header("volumes.extend");
            h.addProperty("id", id);
            h.addProperty("link", link);
            h.add("work", work.toJson());
            return new Frame(h);
        }

        public static VolumesExtend decode(Frame f) throws ProtocolException {
            expectType(f, "volumes.extend");
            long id = reqId(f);
            return new VolumesExtend(id, Json.reqLong(f.header(), "link", id), Box.fromJson(Json.req(f.header(), "work", id), "work", id));
        }
    }

    // ── hashes ────────────────────────────────────────────────────────────────────────────────

    /** {@code hashes}, MCP → mod. {@code boxes} is non-empty. */
    public record HashesRequest(long id, String dimension, List<Box> boxes) {
        public Frame encode() {
            JsonObject h = Json.header("hashes");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.add("boxes", Json.boxes(boxes));
            return new Frame(h);
        }

        public static HashesRequest decode(Frame f) throws ProtocolException {
            expectType(f, "hashes");
            long id = reqId(f);
            List<Box> boxes = Json.reqBoxes(f.header(), "boxes", id);
            if (boxes.isEmpty()) throw ProtocolException.badRequest(id, "hashes needs at least one box");
            return new HashesRequest(id, Json.reqString(f.header(), "dimension", id), boxes);
        }
    }

    public record SectionHash(int sx, int sy, int sz, long hash) {}

    /** {@code hashes.result}, mod → MCP. Sections ascending by sy, then sz, then sx (the caller orders them). */
    public record HashesResult(long id, List<SectionHash> sections) {
        public Frame encode() {
            JsonObject h = Json.header("hashes.result");
            h.addProperty("id", id);
            JsonArray a = new JsonArray(sections.size());
            for (SectionHash s : sections) {
                JsonArray e = new JsonArray(4);
                e.add(s.sx());
                e.add(s.sy());
                e.add(s.sz());
                e.add(hex(s.hash()));
                a.add(e);
            }
            h.add("sections", a);
            return new Frame(h);
        }

        public static HashesResult decode(Frame f) throws ProtocolException {
            expectType(f, "hashes.result");
            long id = reqId(f);
            List<SectionHash> out = new ArrayList<>();
            for (JsonElement e : Json.reqArray(f.header(), "sections", id)) {
                if (!e.isJsonArray() || e.getAsJsonArray().size() != 4) throw ProtocolException.badRequest(id, "a section hash is [sx,sy,sz,hash]");
                JsonArray a = e.getAsJsonArray();
                JsonElement hash = a.get(3);
                if (!hash.isJsonPrimitive() || !hash.getAsJsonPrimitive().isString()) throw ProtocolException.badRequest(id, "section hash must be a string");
                out.add(new SectionHash(Json.asInt(a.get(0), "sx", id), Json.asInt(a.get(1), "sy", id), Json.asInt(a.get(2), "sz", id), parseHex(hash.getAsString(), id)));
            }
            return new HashesResult(id, out);
        }
    }

    // ── snapshot ──────────────────────────────────────────────────────────────────────────────

    /** A chunk section by section coordinates ({@code [x >> 4, y >> 4, z >> 4]}). */
    public record Section(int sx, int sy, int sz) {
        public Box box() {
            return Box.section(sx, sy, sz);
        }
    }

    /** {@code snapshot}, MCP → mod: exactly one of {@code boxes} or {@code sections} is non-null. */
    public record SnapshotRequest(long id, String dimension, @Nullable List<Box> boxes, @Nullable List<Section> sections) {
        /** The regions to read, in request order: the boxes, or each section's 16³ box. */
        public List<Box> regions() {
            if (boxes != null) return boxes;
            List<Box> out = new ArrayList<>(sections.size());
            for (Section s : sections) out.add(s.box());
            return out;
        }

        public Frame encode() {
            JsonObject h = Json.header("snapshot");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            if (boxes != null) h.add("boxes", Json.boxes(boxes));
            else {
                JsonArray a = new JsonArray(sections.size());
                for (Section s : sections) a.add(Json.vec(s.sx(), s.sy(), s.sz()));
                h.add("sections", a);
            }
            return new Frame(h);
        }

        public static SnapshotRequest decode(Frame f) throws ProtocolException {
            expectType(f, "snapshot");
            long id = reqId(f);
            JsonObject h = f.header();
            String dim = Json.reqString(h, "dimension", id);
            boolean hasBoxes = h.has("boxes"), hasSections = h.has("sections");
            if (hasBoxes == hasSections) throw ProtocolException.badRequest(id, "snapshot needs exactly one of boxes or sections");
            if (hasBoxes) return new SnapshotRequest(id, dim, Json.reqBoxes(h, "boxes", id), null);
            List<Section> sections = new ArrayList<>();
            for (JsonElement e : Json.reqArray(h, "sections", id)) {
                int[] s = Json.asVec(e, "section", id);
                // Section coordinates must name blocks that fit an int.
                if (s[0] < -(1 << 27) || s[0] >= (1 << 27) || s[1] < -(1 << 27) || s[1] >= (1 << 27) || s[2] < -(1 << 27) || s[2] >= (1 << 27))
                    throw ProtocolException.badRequest(id, "section out of range");
                sections.add(new Section(s[0], s[1], s[2]));
            }
            return new SnapshotRequest(id, dim, null, sections);
        }
    }

    /** {@code snapshot.result}, mod → MCP. Each region's states index {@code palette}. */
    public record SnapshotResult(long id, String dimension, List<String> palette, List<SnapshotRegion> regions) {
        public Frame encode() {
            JsonObject h = Json.header("snapshot.result");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.add("regions", Json.boxes(regions.stream().map(SnapshotRegion::box).toList()));
            return new Frame(h, Bodies.encodeSnapshot(palette, regions));
        }

        public static SnapshotResult decode(Frame f) throws ProtocolException {
            expectType(f, "snapshot.result");
            long id = reqId(f);
            List<Box> boxes = Json.reqBoxes(f.header(), "regions", id);
            Bodies.SnapshotBody body = Bodies.decodeSnapshot(f.body(), boxes);
            return new SnapshotResult(id, Json.reqString(f.header(), "dimension", id), body.palette(), body.regions());
        }
    }

    // ── patch ─────────────────────────────────────────────────────────────────────────────────

    /** {@code patch}, MCP → mod. {@code force} is {@code overwriteHandEdits}. */
    public record Patch(long id, long link, String dimension, boolean force, List<PatchBlock> blocks) {
        public Frame encode() {
            Encoded e = Bodies.encodePatch(blocks);
            JsonObject h = Json.header("patch");
            h.addProperty("id", id);
            h.addProperty("link", link);
            h.addProperty("dimension", dimension);
            if (force) h.addProperty("force", true);
            e.grid().writeTo(h);
            h.addProperty("count", blocks.size());
            return new Frame(h, e.body());
        }

        public static Patch decode(Frame f) throws ProtocolException {
            expectType(f, "patch");
            long id = reqId(f);
            JsonObject h = f.header();
            if (h.has("force") && !Json.reqBool(h, "force", id)) throw ProtocolException.badRequest(id, "force is true or omitted");
            Grid grid = Grid.readFrom(h, id);
            int count = Json.reqCount(h, "count", id);
            long link = Json.reqLong(h, "link", id);
            String dim = Json.reqString(h, "dimension", id);
            // A body that doesn't decode is treated as a malformed frame (bad_request, id null, close).
            return new Patch(id, link, dim, h.has("force"), Bodies.decodePatch(f.body(), grid, count));
        }
    }

    /** {@code patch.ack}, mod → MCP. The skipped, rejected and normalized counts come from the lists. */
    public record PatchAck(long id, int applied, int overwritten, AckLists lists) {
        public Frame encode() {
            Encoded e = Bodies.encodeAck(lists);
            JsonObject h = Json.header("patch.ack");
            h.addProperty("id", id);
            h.addProperty("applied", applied);
            h.addProperty("overwritten", overwritten);
            h.addProperty("skipped", lists.skipped().size());
            h.addProperty("rejected", lists.rejected().size());
            h.addProperty("normalized", lists.normalized().size());
            e.grid().writeTo(h);
            return new Frame(h, e.body());
        }

        public static PatchAck decode(Frame f) throws ProtocolException {
            expectType(f, "patch.ack");
            long id = reqId(f);
            JsonObject h = f.header();
            AckLists lists = Bodies.decodeAck(f.body(), Grid.readFrom(h, id), Json.reqCount(h, "skipped", id), Json.reqCount(h, "rejected", id), Json.reqCount(h, "normalized", id));
            return new PatchAck(id, Json.reqCount(h, "applied", id), Json.reqCount(h, "overwritten", id), lists);
        }
    }

    // ── dirty ─────────────────────────────────────────────────────────────────────────────────

    /** {@code dirty}, mod → MCP: changed positions, or {@code everything} with no body. */
    public record Dirty(boolean everything, List<WorldBlock> blocks) {
        public static final int CAP = 4096;

        public static Dirty all() {
            return new Dirty(true, List.of());
        }

        public Frame encode() {
            JsonObject h = Json.header("dirty");
            h.addProperty("everything", everything);
            if (everything) return new Frame(h);
            Encoded e = Bodies.encodeDirty(blocks);
            e.grid().writeTo(h);
            h.addProperty("count", blocks.size());
            return new Frame(h, e.body());
        }

        public static Dirty decode(Frame f) throws ProtocolException {
            expectType(f, "dirty");
            JsonObject h = f.header();
            if (Json.reqBool(h, "everything", null)) return all();
            return new Dirty(false, Bodies.decodeDirty(f.body(), Grid.readFrom(h, null), Json.reqCount(h, "count", null)));
        }
    }

    // ── notice ────────────────────────────────────────────────────────────────────────────────

    /** {@code notice}, MCP → mod: action-bar text for one player, or every op with notices on ({@code player} null). */
    public record Notice(String text, @Nullable UUID player) {
        public Frame encode() {
            JsonObject h = Json.header("notice");
            h.addProperty("text", text);
            h.add("player", Json.nullable(player == null ? null : player.toString()));
            return new Frame(h);
        }

        public static Notice decode(Frame f) throws ProtocolException {
            expectType(f, "notice");
            String p = Json.optString(f.header(), "player", null);
            return new Notice(Json.reqString(f.header(), "text", null), p == null ? null : parseUuid(p, null));
        }
    }
}
