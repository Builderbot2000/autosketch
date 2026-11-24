package dev.autosketch.mod.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import dev.autosketch.mod.protocol.BodyTypes.AckLists;
import dev.autosketch.mod.protocol.BodyTypes.Encoded;
import dev.autosketch.mod.protocol.BodyTypes.PatchBlock;
import dev.autosketch.mod.protocol.BodyTypes.SnapshotRegion;
import dev.autosketch.mod.protocol.BodyTypes.SurfaceLayer;
import dev.autosketch.mod.protocol.BodyTypes.UpgradeData;
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
 * ill-typed field into {@code bad_request} for the request's id. {@code prompt.result} belongs to the
 * in-game requests package and uses {@link Json} directly.
 */
public final class Messages {
    private Messages() {}

    /** The one protocol version the mod speaks (13, *Versions and features*). */
    public static final int PROTOCOL_VERSION = 4;

    /**
     * Request modes (13, B6), named by the player's subcommand; {@code select} (18, piece 1) needs
     * feature {@code select}. Protocol 4 retired {@code scan} (18, *Removal*).
     */
    public static final List<String> REQUEST_MODES = List.of("ask", "plan", "build", "select");

    /** Optional mod capabilities a mod hello lists in {@code features} (13, *Versions and features*). */
    public static final String FEATURE_MODES = "modes", FEATURE_VOLUMES_SET = "volumes.set";
    /** Protocol 3 features (14, *Version-specific data lives in the mod*). */
    public static final String FEATURE_REGISTRY = "registry", FEATURE_UPGRADE = "upgrade";
    /**
     * Added within protocol 3 (18): the mod serves {@code search}, {@code fill}, {@code expand}, the
     * {@code mask} and {@code coarse} snapshots and select-mode reads (surface snapshots included,
     * which protocols 2 and 3 listed under {@code scan}), and sends mode {@code select}
     * ({@link SelectMessages}). A mod lists it only once it serves all of them.
     */
    public static final String FEATURE_SELECT = "select";
    /**
     * Optional MCP capabilities an MCP hello lists in {@code features}, mirroring the mod's list: the
     * mod uses an addition only when the MCP lists it. {@code prompt.close}: the MCP handles
     * {@code prompt.close} ({@code /autosketch done}, 13, B6).
     */
    public static final String MCP_FEATURE_PROMPT_CLOSE = "prompt.close";

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

    /**
     * {@code hello}, MCP → mod. {@code volatileKeys} is the volatile-key list (*Hashing*), possibly
     * empty. {@code modes} (protocol 2) the request modes the MCP enforces; null when absent, which
     * means {@code ["build"]} ({@link #effectiveModes}). {@code features} the MCP's optional
     * capabilities ({@code prompt.close}); null when absent, which means none.
     */
    public record McpHello(int protocol, String token, String clientName, String clientVersion, JsonObject volatileKeys, @Nullable List<String> modes,
            @Nullable List<String> features) {
        public McpHello(int protocol, String token, String clientName, String clientVersion, JsonObject volatileKeys) {
            this(protocol, token, clientName, clientVersion, volatileKeys, null, null);
        }

        /** The modes the hello lists, or {@code ["build"]} when it lists none. */
        public List<String> effectiveModes() {
            return modes == null ? List.of("build") : modes;
        }

        /** The features the hello lists, or none. */
        public List<String> effectiveFeatures() {
            return features == null ? List.of() : features;
        }

        public Frame encode() {
            JsonObject h = Json.header("hello");
            h.addProperty("protocol", protocol);
            h.addProperty("token", token);
            JsonObject client = new JsonObject();
            client.addProperty("name", clientName);
            client.addProperty("version", clientVersion);
            h.add("client", client);
            h.add("volatile", volatileKeys);
            if (modes != null) h.add("modes", Json.strings(modes));
            if (features != null) h.add("features", Json.strings(features));
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
                    Json.reqString(client, "name", null), Json.reqString(client, "version", null), Json.reqObject(h, "volatile", null),
                    Json.optStrings(h, "modes", null), Json.optStrings(h, "features", null));
        }

        /** The {@code protocol} field alone, the part every protocol version keeps. */
        public static int readProtocol(Frame f) throws ProtocolException {
            return Json.reqInt(f.header(), "protocol", null);
        }
    }

    /**
     * {@code hello}, mod → MCP. {@code host} is the singleplayer host, null on a dedicated server.
     * {@code features} (protocol 2) the optional capabilities the mod has; null when absent (none).
     */
    public record ModHello(String modVersion, String gameVersion, int dataVersion, String loader, String loaderVersion,
            boolean singleplayer, @Nullable Player host, @Nullable List<String> features) {
        public ModHello(String modVersion, String gameVersion, int dataVersion, String loader, String loaderVersion, boolean singleplayer, @Nullable Player host) {
            this(modVersion, gameVersion, dataVersion, loader, loaderVersion, singleplayer, host, null);
        }

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
            if (features != null) h.add("features", Json.strings(features));
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
                    host.isJsonNull() ? null : Player.fromJson(Json.reqObject(h, "host", null), null),
                    Json.optStrings(h, "features", null));
        }
    }

    // ── volumes ───────────────────────────────────────────────────────────────────────────────

    /**
     * {@code volumes}, mod → MCP. With {@code work} null (unlinked) only {@code link} is sent;
     * otherwise {@code dimension}, {@code context} and, while in force, {@code extended}. {@code id}
     * (protocol 2) only on the {@code volumes} that confirms a {@code volumes.set}.
     */
    public record Volumes(@Nullable Long id, long link, @Nullable String dimension, @Nullable Box work, List<Box> context, @Nullable Box extended) {
        public Volumes(long link, @Nullable String dimension, @Nullable Box work, List<Box> context, @Nullable Box extended) {
            this(null, link, dimension, work, context, extended);
        }

        public static Volumes none(long link) {
            return new Volumes(link, null, null, List.of(), null);
        }

        /** The same message confirming the {@code volumes.set} with this id. */
        public Volumes confirming(long requestId) {
            return new Volumes(requestId, link, dimension, work, context, extended);
        }

        public Frame encode() {
            JsonObject h = Json.header("volumes");
            if (id != null) h.addProperty("id", id);
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
            Long id = h.has("id") ? Json.reqLong(h, "id", null) : null;
            long link = Json.reqLong(h, "link", null);
            JsonElement work = Json.req(h, "work", null);
            if (work.isJsonNull()) return new Volumes(id, link, null, null, List.of(), null);
            Box ext = h.has("extended") ? Box.fromJson(h.get("extended"), "extended", null) : null;
            return new Volumes(id, link, Json.reqString(h, "dimension", null), Box.fromJson(work, "work", null), Json.reqBoxes(h, "context", null), ext);
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

    /**
     * {@code volumes.set}, MCP → mod, protocol 2 (feature {@code volumes.set}; 13, B4): the agent sets
     * the volumes as if the player had marked them. {@code context} null means the default context.
     */
    public record VolumesSet(long id, String dimension, Box work, @Nullable List<Box> context) {
        public Frame encode() {
            JsonObject h = Json.header("volumes.set");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.add("work", work.toJson());
            if (context != null) h.add("context", Json.boxes(context));
            return new Frame(h);
        }

        public static VolumesSet decode(Frame f) throws ProtocolException {
            expectType(f, "volumes.set");
            long id = reqId(f);
            JsonObject h = f.header();
            List<Box> context = h.has("context") ? Json.reqBoxes(h, "context", id) : null;
            return new VolumesSet(id, Json.reqString(h, "dimension", id), Box.fromJson(Json.req(h, "work", id), "work", id), context);
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
            String kind = Json.optString(h, "kind", id);
            if (kind != null && !kind.equals("blocks")) throw ProtocolException.badRequest(id, "not a blocks snapshot (kind " + kind + ")");
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

    /**
     * {@code snapshot.result}, mod → MCP. Each region's states index {@code palette}. {@code missing}
     * (select reads, 18): the chunks the regions touch that aren't generated, ascending by cz, then cx;
     * null or empty is omitted.
     */
    public record SnapshotResult(long id, String dimension, List<String> palette, List<SnapshotRegion> regions, @Nullable List<ChunkXZ> missing) {
        public SnapshotResult(long id, String dimension, List<String> palette, List<SnapshotRegion> regions) {
            this(id, dimension, palette, regions, null);
        }

        public Frame encode() {
            JsonObject h = Json.header("snapshot.result");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.add("regions", Json.boxes(regions.stream().map(SnapshotRegion::box).toList()));
            if (missing != null && !missing.isEmpty()) h.add("missing", chunks(missing));
            return new Frame(h, Bodies.encodeSnapshot(palette, regions));
        }

        public static SnapshotResult decode(Frame f) throws ProtocolException {
            expectType(f, "snapshot.result");
            long id = reqId(f);
            List<Box> boxes = Json.reqBoxes(f.header(), "regions", id);
            List<ChunkXZ> missing = f.header().has("missing") ? readChunks(f.header(), "missing", id) : null;
            if (missing != null && missing.isEmpty()) throw ProtocolException.badRequest(id, "missing is omitted when empty");
            Bodies.SnapshotBody body = Bodies.decodeSnapshot(f.body(), boxes);
            return new SnapshotResult(id, Json.reqString(f.header(), "dimension", id), body.palette(), body.regions(), missing);
        }
    }

    /** Chunks as {@code [[cx,cz],…]}. */
    public static JsonArray chunks(List<ChunkXZ> list) {
        JsonArray m = new JsonArray(list.size());
        for (ChunkXZ c : list) {
            JsonArray e = new JsonArray(2);
            e.add(c.cx());
            e.add(c.cz());
            m.add(e);
        }
        return m;
    }

    /** Chunks {@code [[cx,cz],…]}, unique and ascending by cz, then cx. */
    public static List<ChunkXZ> readChunks(JsonObject h, String key, @Nullable Long id) throws ProtocolException {
        List<ChunkXZ> out = new ArrayList<>();
        for (JsonElement e : Json.reqArray(h, key, id)) {
            int[] c = Area.pair(e, key, id);
            ChunkXZ next = new ChunkXZ(c[0], c[1]);
            if (!out.isEmpty()) {
                ChunkXZ prev = out.get(out.size() - 1);
                if (prev.cz() > next.cz() || (prev.cz() == next.cz() && prev.cx() >= next.cx()))
                    throw ProtocolException.badRequest(id, key + " must be unique and ascending by cz, then cx");
            }
            out.add(next);
        }
        return List.copyOf(out);
    }

    /** The snapshot kind a {@code snapshot} request asks for: {@code blocks} (the default) or {@code surface} (protocol 2). */
    public static String snapshotKind(Frame f) throws ProtocolException {
        String kind = Json.optString(f.header(), "kind", f.id());
        return kind == null ? "blocks" : kind;
    }

    /**
     * {@code snapshot} kind {@code surface}, MCP → mod, protocol 2 (feature {@code select} since protocol 4; 18, piece 10): per
     * column of {@code columns}, the topmost non-air block, and with {@code ceiling} also the lowest
     * non-air block at or above that y.
     */
    public record SurfaceRequest(long id, String dimension, Area columns, @Nullable Integer ceiling) {
        public Frame encode() {
            JsonObject h = Json.header("snapshot");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.addProperty("kind", "surface");
            h.add("columns", columns.toJson());
            if (ceiling != null) h.addProperty("ceiling", ceiling);
            return new Frame(h);
        }

        public static SurfaceRequest decode(Frame f) throws ProtocolException {
            expectType(f, "snapshot");
            long id = reqId(f);
            JsonObject h = f.header();
            if (!"surface".equals(Json.optString(h, "kind", id))) throw ProtocolException.badRequest(id, "not a surface snapshot");
            Integer ceiling = h.has("ceiling") ? Json.reqInt(h, "ceiling", id) : null;
            return new SurfaceRequest(id, Json.reqString(h, "dimension", id), Area.fromJson(Json.req(h, "columns", id), "columns", id), ceiling);
        }
    }

    /** A chunk by chunk coordinates, for {@code missing}. */
    public record ChunkXZ(int cx, int cz) {}

    /**
     * {@code snapshot.result} kind {@code surface}, mod → MCP, protocol 2. The layers' states index
     * {@code palette}; {@code ceilings} is present exactly when {@code ceiling} is. {@code missing}
     * ascending by cz, then cx.
     */
    public record SurfaceResult(long id, String dimension, Area columns, int minY, @Nullable Integer ceiling, List<ChunkXZ> missing,
            List<String> palette, SurfaceLayer surface, @Nullable SurfaceLayer ceilings) {
        public Frame encode() {
            if ((ceiling == null) != (ceilings == null)) throw new IllegalArgumentException("ceilings go with ceiling");
            JsonObject h = Json.header("snapshot.result");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.addProperty("kind", "surface");
            h.add("columns", columns.toJson());
            h.addProperty("minY", minY);
            if (ceiling != null) h.addProperty("ceiling", ceiling);
            JsonArray m = new JsonArray(missing.size());
            for (ChunkXZ c : missing) {
                JsonArray e = new JsonArray(2);
                e.add(c.cx());
                e.add(c.cz());
                m.add(e);
            }
            h.add("missing", m);
            return new Frame(h, Bodies.encodeSurface(palette, columns.columns(), surface, ceilings));
        }

        public static SurfaceResult decode(Frame f) throws ProtocolException {
            expectType(f, "snapshot.result");
            long id = reqId(f);
            JsonObject h = f.header();
            if (!"surface".equals(Json.optString(h, "kind", id))) throw ProtocolException.badRequest(id, "not a surface result");
            Area columns = Area.fromJson(Json.req(h, "columns", id), "columns", id);
            Integer ceiling = h.has("ceiling") ? Json.reqInt(h, "ceiling", id) : null;
            List<ChunkXZ> missing = new ArrayList<>();
            for (JsonElement e : Json.reqArray(h, "missing", id)) {
                int[] c = Area.pair(e, "missing", id);
                missing.add(new ChunkXZ(c[0], c[1]));
            }
            Bodies.SurfaceBody body = Bodies.decodeSurface(f.body(), columns.columns(), ceiling != null);
            return new SurfaceResult(id, Json.reqString(h, "dimension", id), columns, Json.reqInt(h, "minY", id), ceiling, missing,
                    body.palette(), body.surface(), body.ceilings());
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

    // ── prompt ────────────────────────────────────────────────────────────────────────────────

    /**
     * {@code prompt}, mod → MCP: an in-game request. {@code context} is the game context object
     * ({@code prompt}'s {@code context.*} rows), built by the prompt package. {@code mode} (protocol 2,
     * feature {@code modes}) is null when absent.
     */
    public record Prompt(long id, Player player, String text, JsonObject context, @Nullable String mode) {
        public Frame encode() {
            JsonObject h = Json.header("prompt");
            h.addProperty("id", id);
            h.add("player", player.toJson());
            h.addProperty("text", text);
            h.add("context", context);
            if (mode != null) h.addProperty("mode", mode);
            return new Frame(h);
        }

        public static Prompt decode(Frame f) throws ProtocolException {
            expectType(f, "prompt");
            long id = reqId(f);
            JsonObject h = f.header();
            String mode = Json.optString(h, "mode", id);
            return new Prompt(id, Player.fromJson(Json.reqObject(h, "player", id), id), Json.reqString(h, "text", id), Json.reqObject(h, "context", id), mode);
        }
    }

    /**
     * {@code prompt.close}, mod to MCP: the player ran {@code /autosketch done} to end the open
     * read-only request (13, B6). Sent only when the MCP's hello lists {@code prompt.close}; the MCP
     * answers on the player's action bar with a {@code notice}.
     */
    public record PromptClose(Player player) {
        public Frame encode() {
            JsonObject h = Json.header("prompt.close");
            h.add("player", player.toJson());
            return new Frame(h);
        }

        public static PromptClose decode(Frame f) throws ProtocolException {
            expectType(f, "prompt.close");
            return new PromptClose(Player.fromJson(Json.reqObject(f.header(), "player", null), null));
        }
    }

    /** {@code prompt.result}, MCP → mod. {@code reason} only when not delivered (protocol 2 adds {@code unsupported_mode}). */
    public record PromptResult(long id, boolean delivered, @Nullable String reason) {
        public Frame encode() {
            JsonObject h = Json.header("prompt.result");
            h.addProperty("id", id);
            h.addProperty("delivered", delivered);
            if (reason != null) h.addProperty("reason", reason);
            return new Frame(h);
        }

        public static PromptResult decode(Frame f) throws ProtocolException {
            expectType(f, "prompt.result");
            long id = reqId(f);
            JsonObject h = f.header();
            boolean delivered = Json.reqBool(h, "delivered", id);
            return new PromptResult(id, delivered, delivered ? null : Json.optString(h, "reason", id));
        }
    }

    // ── registry report and upgrades (protocol 3) ──────────────────────────────────────────────

    /**
     * {@code registry}, MCP → mod, protocol 3 (feature {@code registry}): asks for the registry report.
     * {@code have} is the hash of the report the MCP holds, or null.
     */
    public record RegistryRequest(long id, @Nullable Long have) {
        public Frame encode() {
            JsonObject h = Json.header("registry");
            h.addProperty("id", id);
            if (have != null) h.addProperty("have", hex(have));
            return new Frame(h);
        }

        public static RegistryRequest decode(Frame f) throws ProtocolException {
            expectType(f, "registry");
            long id = reqId(f);
            String have = Json.optString(f.header(), "have", id);
            return new RegistryRequest(id, have == null ? null : parseHex(have, id));
        }
    }

    /**
     * {@code registry.result}, mod → MCP, protocol 3: the report's hash (over its uncompressed JSON) and
     * DataVersion, and the gzip report file as the body; {@code report} null means {@code unchanged}.
     */
    public record RegistryResult(long id, long hash, int dataVersion, byte @Nullable [] report) {
        public Frame encode() {
            JsonObject h = Json.header("registry.result");
            h.addProperty("id", id);
            h.addProperty("hash", hex(hash));
            h.addProperty("dataVersion", dataVersion);
            if (report == null) {
                h.addProperty("unchanged", true);
                return new Frame(h);
            }
            if (report.length == 0) throw new IllegalArgumentException("a registry report needs content");
            return new Frame(h, report);
        }

        public static RegistryResult decode(Frame f) throws ProtocolException {
            expectType(f, "registry.result");
            long id = reqId(f);
            JsonObject h = f.header();
            long hash = parseHex(Json.reqString(h, "hash", id), id);
            int dataVersion = Json.reqInt(h, "dataVersion", id);
            if (h.has("unchanged")) {
                if (!Json.reqBool(h, "unchanged", id)) throw ProtocolException.badRequest(id, "unchanged is true or omitted");
                if (f.hasBody()) throw ProtocolException.badRequest(id, "an unchanged registry.result carries no body");
                return new RegistryResult(id, hash, dataVersion, null);
            }
            if (!f.hasBody()) throw ProtocolException.badRequest(id, "registry.result needs the report as its body");
            return new RegistryResult(id, hash, dataVersion, f.body());
        }
    }

    private static String upgradeKind(JsonObject h, long id) throws ProtocolException {
        String kind = Json.reqString(h, "kind", id);
        if (!kind.equals("elements") && !kind.equals("structure")) throw ProtocolException.badRequest(id, "kind must be elements or structure");
        return kind;
    }

    /**
     * {@code upgrade}, MCP → mod, protocol 3 (feature {@code upgrade}): run the game's data fixer over
     * {@code data} from DataVersion {@code from} to the running one.
     */
    public record UpgradeRequest(long id, int from, UpgradeData data) {
        public Frame encode() {
            JsonObject h = Json.header("upgrade");
            h.addProperty("id", id);
            h.addProperty("from", from);
            h.addProperty("kind", data.kind());
            return new Frame(h, Bodies.encodeUpgrade(data));
        }

        public static UpgradeRequest decode(Frame f) throws ProtocolException {
            expectType(f, "upgrade");
            long id = reqId(f);
            JsonObject h = f.header();
            int from = Json.reqInt(h, "from", id);
            return new UpgradeRequest(id, from, Bodies.decodeUpgrade(f.body(), upgradeKind(h, id)));
        }
    }

    /**
     * {@code upgrade.result}, mod → MCP, protocol 3: the upgraded data in the request's order and
     * counts, {@code to} the running DataVersion, {@code failed} how many elements the fixer threw on
     * (returned unchanged; omitted when 0).
     */
    public record UpgradeResult(long id, int to, int failed, UpgradeData data) {
        public Frame encode() {
            JsonObject h = Json.header("upgrade.result");
            h.addProperty("id", id);
            h.addProperty("to", to);
            h.addProperty("kind", data.kind());
            if (failed > 0) h.addProperty("failed", failed);
            return new Frame(h, Bodies.encodeUpgrade(data));
        }

        public static UpgradeResult decode(Frame f) throws ProtocolException {
            expectType(f, "upgrade.result");
            long id = reqId(f);
            JsonObject h = f.header();
            int failed = h.has("failed") ? Json.reqCount(h, "failed", id) : 0;
            return new UpgradeResult(id, Json.reqInt(h, "to", id), failed, Bodies.decodeUpgrade(f.body(), upgradeKind(h, id)));
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

    /**
     * {@code chat}, MCP → mod: lines for the requesting player's chat. {@code action} (a reply only,
     * feature {@code ui}; 17, piece 3) makes {@code lines[action.line]} clickable: the click makes the
     * player's client send the {@code ui.request} {@code action.kind} with {@code action.args}. A mod
     * or client that doesn't handle it shows the line as plain text.
     */
    public record Chat(@Nullable Long request, @Nullable UUID player, String kind, List<String> lines, @Nullable ChatAction action) {
        public static final String ACTIVITY = "activity", REPLY = "reply";

        public Chat {
            lines = List.copyOf(lines);
        }

        public boolean reply() {
            return kind.equals(REPLY);
        }

        public Frame encode() {
            JsonObject h = Json.header("chat");
            h.add("request", Json.nullable(request));
            h.add("player", Json.nullable(player == null ? null : player.toString()));
            h.addProperty("kind", kind);
            h.add("lines", Json.strings(lines));
            if (action != null) {
                JsonObject a = new JsonObject();
                a.addProperty("line", action.line());
                a.addProperty("kind", action.kind());
                a.add("args", action.args());
                h.add("action", a);
            }
            return new Frame(h);
        }

        public static Chat decode(Frame f) throws ProtocolException {
            expectType(f, "chat");
            JsonObject h = f.header();
            Long request = Json.reqNullableLong(h, "request", null);
            String p = Json.optString(h, "player", null);
            String kind = Json.reqString(h, "kind", null);
            if (!kind.equals(ACTIVITY) && !kind.equals(REPLY)) throw ProtocolException.badRequest(null, "\"kind\" must be \"activity\" or \"reply\"");
            List<String> lines = new ArrayList<>();
            for (JsonElement e : Json.reqArray(h, "lines", null)) {
                if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) throw ProtocolException.badRequest(null, "\"lines\" must be strings");
                lines.add(e.getAsString());
            }
            ChatAction action = null;
            if (h.has("action")) {
                if (!kind.equals(REPLY)) throw ProtocolException.badRequest(null, "only a reply carries an action");
                JsonObject a = Json.reqObject(h, "action", null);
                int line = Json.reqInt(a, "line", null);
                if (line < 0 || line >= lines.size()) throw ProtocolException.badRequest(null, "action.line " + line + " names no line");
                String k = Json.reqString(a, "kind", null);
                if (k.isEmpty()) throw ProtocolException.badRequest(null, "action.kind must be non-empty");
                action = new ChatAction(line, k, Json.reqObject(a, "args", null));
            }
            return new Chat(request, p == null ? null : parseUuid(p, null), kind, lines, action);
        }
    }

    /** A clickable reply line: the {@code ui.request} the client sends when {@code lines[line]} is clicked. */
    public record ChatAction(int line, String kind, JsonObject args) {}
}
