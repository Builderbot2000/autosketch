package dev.autosketch.mod.protocol;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.autosketch.mod.protocol.BodyTypes.SnapshotRegion;
import dev.autosketch.mod.protocol.Messages.ChunkXZ;
import dev.autosketch.mod.protocol.Messages.Section;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import net.minecraft.core.BlockPos;
import org.jetbrains.annotations.Nullable;

/**
 * Select on the wire (18, *Wire*; 13, *Message schemas*, *Select*; mod feature {@code select}, added
 * within protocol 3): {@code search}, {@code fill}, {@code expand} and their answers, and the
 * {@code snapshot} kinds {@code mask} and {@code coarse}. Header keys are written in the schema
 * tables' order; decoding turns a bad field into {@code bad_request} for the request's id, and a body
 * that doesn't decode into a malformed frame, as {@link Messages} does.
 */
public final class SelectMessages {
    private SelectMessages() {}

    /** Interim defaults (18, *Measure first*; the mod's config holds the ones it serves). */
    public static final int MASK_MARGIN = 8, SEARCH_GAP = 2, SEARCH_STOP = 1, SELECT_CHUNKS = 256, FILL_CONNECTIVITY = 26, FILL_AREA = 1;
    /** The match entry for every non-air block. */
    public static final String MATCH_SOLID = "solid";
    /** Bytes in one section's bitset. */
    public static final int MASK_BYTES = 512;
    public static final List<String> FILL_STOPS = List.of("complete", "edge", "budget");
    public static final List<String> DIRECTIONS = List.of("north", "south", "west", "east");
    /** Face-mask bits: down, up, north, south, west, east. */
    public static final int FACE_DOWN = 1, FACE_UP = 2, FACE_NORTH = 4, FACE_SOUTH = 8, FACE_WEST = 16, FACE_EAST = 32;

    /** A block id or canonical state ({@code ns:path}, {@code ns:path[k=v,…]}), or a tag {@code #ns:path}. */
    private static final Pattern MATERIAL = Pattern.compile("#[a-z0-9_.-]+:[a-z0-9_./-]+|[a-z0-9_.-]+:[a-z0-9_./-]+(\\[[a-z0-9_]+=[a-z0-9_]+(,[a-z0-9_]+=[a-z0-9_]+)*\\])?");

    /** Whether a frame is one of this class's messages (a {@code snapshot} by its kind). */
    public static boolean handles(Frame f) {
        return switch (f.type()) {
            case "search", "search.result", "fill", "fill.result", "expand" -> true;
            case "snapshot" -> {
                String k = f.header().has("kind") && f.header().get("kind").isJsonPrimitive() ? f.header().get("kind").getAsString() : "";
                yield k.equals("mask") || k.equals("coarse");
            }
            case "snapshot.result" -> f.header().has("kind") && f.header().get("kind").isJsonPrimitive() && f.header().get("kind").getAsString().equals("coarse");
            default -> false;
        };
    }

    /** Decodes any message {@link #handles} accepts. */
    public static Object decode(Frame f) throws ProtocolException {
        return switch (f.type()) {
            case "search" -> SearchRequest.decode(f);
            case "search.result" -> SearchResult.decode(f);
            case "fill" -> FillRequest.decode(f);
            case "fill.result" -> FillResult.decode(f);
            case "expand" -> ExpandRequest.decode(f);
            case "snapshot" -> Messages.snapshotKind(f).equals("mask") ? MaskSnapshotRequest.decode(f) : CoarseSnapshotRequest.decode(f);
            case "snapshot.result" -> CoarseResult.decode(f);
            default -> throw new IllegalArgumentException("not a select message: " + f.type());
        };
    }

    // ── shared pieces ─────────────────────────────────────────────────────────────────────────

    private static long reqId(Frame f) throws ProtocolException {
        Long id = f.id();
        if (id == null || id < 1) throw ProtocolException.badRequest(null, f.type() + " needs an integer id ≥ 1");
        return id;
    }

    private static void expectType(Frame f, String type) {
        if (!f.type().equals(type)) throw new IllegalArgumentException("expected a " + type + " frame, got " + f.type());
    }

    private static int positive(JsonObject o, String key, long id) throws ProtocolException {
        int v = Json.reqInt(o, key, id);
        if (v < 1) throw ProtocolException.badRequest(id, "\"" + key + "\" must be an integer ≥ 1");
        return v;
    }

    private static long positiveLong(JsonObject o, String key, long id) throws ProtocolException {
        long v = Json.reqLong(o, key, id);
        if (v < 1) throw ProtocolException.badRequest(id, "\"" + key + "\" must be an integer ≥ 1");
        return v;
    }

    private static boolean trueOrAbsent(JsonObject o, String key, long id) throws ProtocolException {
        if (!o.has(key)) return false;
        if (!Json.reqBool(o, key, id)) throw ProtocolException.badRequest(id, key + " is true or omitted");
        return true;
    }

    /** A non-empty, duplicate-free material list; {@code solid} allowed only where a fill takes it. */
    private static List<String> readMaterials(JsonObject o, String key, boolean solid, long id) throws ProtocolException {
        List<String> list = Json.optStrings(o, key, id);
        if (list == null || list.isEmpty()) throw ProtocolException.badRequest(id, "\"" + key + "\" must be a non-empty list of materials");
        for (String m : list)
            if (!(solid && m.equals(MATCH_SOLID)) && !MATERIAL.matcher(m).matches())
                throw ProtocolException.badRequest(id, key + ": \"" + m + "\" is not a block id, a state or a #tag");
        if (new HashSet<>(list).size() != list.size()) throw ProtocolException.badRequest(id, "\"" + key + "\" must be unique");
        return list;
    }

    private static JsonArray pair(int a, int b) {
        JsonArray e = new JsonArray(2);
        e.add(a);
        e.add(b);
        return e;
    }

    private static BlockPos pos(JsonObject h, String key, long id) throws ProtocolException {
        int[] v = Json.reqVec(h, key, id);
        return new BlockPos(v[0], v[1], v[2]);
    }

    private static void writeGaps(ByteWriter w, long[] ascending, String what) {
        long prev = -1;
        for (long v : ascending) {
            if (v <= prev) throw new IllegalArgumentException(what + ": entries must be unique and in ascending order");
            w.varint(v - prev - 1);
            prev = v;
        }
    }

    private static long[] readGaps(ByteReader r, int n, long limit, String what) throws ProtocolException {
        long[] out = new long[n];
        long prev = -1;
        for (int i = 0; i < n; i++) {
            prev = prev + r.varint() + 1;
            if (prev >= limit) throw ProtocolException.malformed(what + ": index " + prev + " beyond " + limit);
            out[i] = prev;
        }
        return out;
    }

    // ── snapshot kinds mask and coarse ────────────────────────────────────────────────────────

    /**
     * {@code snapshot} kind {@code mask}, MCP → mod (18, piece 5): the listed sections plus every
     * position within {@code margin} blocks of them, answered by a blocks {@code snapshot.result} laid
     * out by {@link #regions()}. {@code margin} null means {@link #MASK_MARGIN}.
     */
    public record MaskSnapshotRequest(long id, String dimension, List<Section> sections, @Nullable Integer margin) {
        public int effectiveMargin() {
            return margin == null ? MASK_MARGIN : margin;
        }

        /** The answer's regions ({@link SelectMessages#maskRegions}). */
        public List<Box> regions() {
            return maskRegions(sections, effectiveMargin());
        }

        public Frame encode() {
            JsonObject h = Json.header("snapshot");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.addProperty("kind", "mask");
            JsonArray a = new JsonArray(sections.size());
            for (Section s : sections) a.add(Json.vec(s.sx(), s.sy(), s.sz()));
            h.add("sections", a);
            if (margin != null) h.addProperty("margin", margin);
            return new Frame(h);
        }

        public static MaskSnapshotRequest decode(Frame f) throws ProtocolException {
            expectType(f, "snapshot");
            long id = reqId(f);
            JsonObject h = f.header();
            if (!"mask".equals(Json.optString(h, "kind", id))) throw ProtocolException.badRequest(id, "not a mask snapshot");
            for (String k : List.of("boxes", "columns", "ceiling", "cell")) if (h.has(k)) throw ProtocolException.badRequest(id, "a mask snapshot takes sections and margin only");
            List<Section> sections = new ArrayList<>();
            Set<Section> seen = new HashSet<>();
            for (JsonElement e : Json.reqArray(h, "sections", id)) {
                int[] s = Json.asVec(e, "section", id);
                if (s[0] < -(1 << 27) || s[0] >= (1 << 27) || s[1] < -(1 << 27) || s[1] >= (1 << 27) || s[2] < -(1 << 27) || s[2] >= (1 << 27))
                    throw ProtocolException.badRequest(id, "section out of range");
                Section sec = new Section(s[0], s[1], s[2]);
                if (!seen.add(sec)) throw ProtocolException.badRequest(id, "sections must be unique");
                sections.add(sec);
            }
            if (sections.isEmpty()) throw ProtocolException.badRequest(id, "sections must not be empty");
            Integer margin = h.has("margin") ? Json.reqCount(h, "margin", id) : null;
            if (margin != null && margin > 16) throw ProtocolException.badRequest(id, "margin must be 0 to 16");
            return new MaskSnapshotRequest(id, Json.reqString(h, "dimension", id), List.copyOf(sections), margin);
        }
    }

    /**
     * The regions a mask snapshot is answered with (13, *Message schemas*): each listed section's box in
     * request order, then, ascending by sy, sz, sx, for each unlisted section within {@code margin} of a
     * listed one, the bounding box of its positions within {@code margin} (Chebyshev) of the listed
     * sections' boxes. With margin 0, the listed sections only.
     */
    public static List<Box> maskRegions(List<Section> sections, int margin) {
        List<Box> out = new ArrayList<>();
        for (Section s : sections) out.add(s.box());
        if (margin <= 0) return out;
        Set<Section> listed = new HashSet<>(sections);
        Map<Section, Box> extra = new LinkedHashMap<>();
        for (Section s : sections) {
            Box grown = s.box().grow(margin);
            for (int dy = -1; dy <= 1; dy++)
                for (int dz = -1; dz <= 1; dz++)
                    for (int dx = -1; dx <= 1; dx++) {
                        Section n = new Section(s.sx() + dx, s.sy() + dy, s.sz() + dz);
                        if (listed.contains(n)) continue;
                        Box nb = n.box();
                        Box part = new Box(Math.max(nb.minX(), grown.minX()), Math.max(nb.minY(), grown.minY()), Math.max(nb.minZ(), grown.minZ()),
                                Math.min(nb.maxX(), grown.maxX()), Math.min(nb.maxY(), grown.maxY()), Math.min(nb.maxZ(), grown.maxZ()));
                        extra.merge(n, part, (a, b) -> new Box(Math.min(a.minX(), b.minX()), Math.min(a.minY(), b.minY()), Math.min(a.minZ(), b.minZ()),
                                Math.max(a.maxX(), b.maxX()), Math.max(a.maxY(), b.maxY()), Math.max(a.maxZ(), b.maxZ())));
                    }
        }
        List<Section> order = new ArrayList<>(extra.keySet());
        order.sort((a, b) -> a.sy() != b.sy() ? Integer.compare(a.sy(), b.sy()) : a.sz() != b.sz() ? Integer.compare(a.sz(), b.sz()) : Integer.compare(a.sx(), b.sx()));
        for (Section n : order) out.add(extra.get(n));
        return out;
    }

    /** A box grown outward to whole cells of the world grid. */
    public static Box align(Box b, int cell) {
        return new Box(Math.floorDiv(b.minX(), cell) * cell, Math.floorDiv(b.minY(), cell) * cell, Math.floorDiv(b.minZ(), cell) * cell,
                Math.floorDiv(b.maxX(), cell) * cell + cell - 1, Math.floorDiv(b.maxY(), cell) * cell + cell - 1, Math.floorDiv(b.maxZ(), cell) * cell + cell - 1);
    }

    /** An aligned box's cell grid, as a box in cell coordinates. */
    private static Box cells(Box b, int cell, @Nullable Long id) throws ProtocolException {
        if (Math.floorMod(b.minX(), cell) != 0 || Math.floorMod(b.minY(), cell) != 0 || Math.floorMod(b.minZ(), cell) != 0
                || Math.floorMod(b.maxX() + 1, cell) != 0 || Math.floorMod(b.maxY() + 1, cell) != 0 || Math.floorMod(b.maxZ() + 1, cell) != 0)
            throw ProtocolException.badRequest(id, "coarse region " + b + " isn't aligned to cells of " + cell);
        return new Box(Math.floorDiv(b.minX(), cell), Math.floorDiv(b.minY(), cell), Math.floorDiv(b.minZ(), cell),
                Math.floorDiv(b.maxX() + 1, cell) - 1, Math.floorDiv(b.maxY() + 1, cell) - 1, Math.floorDiv(b.maxZ() + 1, cell) - 1);
    }

    private static int readCell(JsonObject h, long id) throws ProtocolException {
        int c = Json.reqInt(h, "cell", id);
        if (c != 2 && c != 4) throw ProtocolException.badRequest(id, "cell must be 2 or 4");
        return c;
    }

    /**
     * {@code snapshot} kind {@code coarse}, MCP → mod (18, piece 5): each box grown outward to whole
     * cells ({@link #align}), one block per cell: the most common non-air state (ties: the one met first
     * in index order), air when the cell is all air.
     */
    public record CoarseSnapshotRequest(long id, String dimension, int cell, List<Box> boxes) {
        public Frame encode() {
            JsonObject h = Json.header("snapshot");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.addProperty("kind", "coarse");
            h.addProperty("cell", cell);
            h.add("boxes", Json.boxes(boxes));
            return new Frame(h);
        }

        public static CoarseSnapshotRequest decode(Frame f) throws ProtocolException {
            expectType(f, "snapshot");
            long id = reqId(f);
            JsonObject h = f.header();
            if (!"coarse".equals(Json.optString(h, "kind", id))) throw ProtocolException.badRequest(id, "not a coarse snapshot");
            for (String k : List.of("sections", "columns", "ceiling", "margin")) if (h.has(k)) throw ProtocolException.badRequest(id, "a coarse snapshot takes cell and boxes only");
            int cell = readCell(h, id);
            List<Box> boxes = Json.reqBoxes(h, "boxes", id);
            if (boxes.isEmpty()) throw ProtocolException.badRequest(id, "boxes must not be empty");
            return new CoarseSnapshotRequest(id, Json.reqString(h, "dimension", id), cell, boxes);
        }
    }

    /** One coarse region: its aligned box and a palette index per cell (x fastest, then z, then y). */
    public record CoarseRegion(Box box, int[] states) {}

    /**
     * {@code snapshot.result} kind {@code coarse}, mod → MCP: {@code snapshot.result}'s body over each
     * region's cell grid, NBT list empty. {@code missing}: ungenerated chunks the regions touch (they
     * read as air), ascending by cz, then cx; null or empty is omitted.
     */
    public record CoarseResult(long id, String dimension, int cell, List<String> palette, List<CoarseRegion> regions, @Nullable List<ChunkXZ> missing) {
        public Frame encode() {
            JsonObject h = Json.header("snapshot.result");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.addProperty("kind", "coarse");
            h.addProperty("cell", cell);
            h.add("regions", Json.boxes(regions.stream().map(CoarseRegion::box).toList()));
            if (missing != null && !missing.isEmpty()) h.add("missing", Messages.chunks(missing));
            List<SnapshotRegion> grids = new ArrayList<>(regions.size());
            for (CoarseRegion r : regions) {
                try {
                    grids.add(new SnapshotRegion(cells(r.box(), cell, id), r.states(), List.of()));
                } catch (ProtocolException e) {
                    throw new IllegalArgumentException(e.getMessage());
                }
            }
            return new Frame(h, Bodies.encodeSnapshot(palette, grids));
        }

        public static CoarseResult decode(Frame f) throws ProtocolException {
            expectType(f, "snapshot.result");
            long id = reqId(f);
            JsonObject h = f.header();
            if (!"coarse".equals(Json.optString(h, "kind", id))) throw ProtocolException.badRequest(id, "not a coarse result");
            int cell = readCell(h, id);
            List<Box> boxes = Json.reqBoxes(h, "regions", id);
            List<Box> grids = new ArrayList<>(boxes.size());
            for (Box b : boxes) grids.add(cells(b, cell, id));
            List<ChunkXZ> missing = h.has("missing") ? Messages.readChunks(h, "missing", id) : null;
            if (missing != null && missing.isEmpty()) throw ProtocolException.badRequest(id, "missing is omitted when empty");
            Bodies.SnapshotBody body = Bodies.decodeSnapshot(f.body(), grids);
            List<CoarseRegion> regions = new ArrayList<>(boxes.size());
            for (int i = 0; i < boxes.size(); i++) {
                if (!body.regions().get(i).blockEntities().isEmpty()) throw ProtocolException.malformed("coarse snapshot: carries no NBT");
                regions.add(new CoarseRegion(boxes.get(i), body.regions().get(i).states()));
            }
            return new CoarseResult(id, Json.reqString(h, "dimension", id), cell, body.palette(), regions, missing);
        }
    }

    // ── search ────────────────────────────────────────────────────────────────────────────────

    /**
     * {@code search}, MCP → mod (18, piece 2). With {@code cont} (the header's {@code continue}) only
     * {@code stop} may be given: the grant's last search walks on. Otherwise {@code materials} is
     * non-empty and the rest null means the mod's default ({@code radius}: {@code selectChunks};
     * {@code around}: the select request's player; {@code gap} {@link #SEARCH_GAP}; {@code stop}
     * {@link #SEARCH_STOP}).
     */
    public record SearchRequest(long id, String dimension, boolean cont, @Nullable List<String> materials, @Nullable Integer radius, @Nullable BlockPos around,
            @Nullable Integer gap, @Nullable Integer stop) {
        public Frame encode() {
            JsonObject h = Json.header("search");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            if (cont) h.addProperty("continue", true);
            else {
                h.add("materials", Json.strings(materials));
                if (radius != null) h.addProperty("radius", radius);
                if (around != null) h.add("around", Json.vec(around.getX(), around.getY(), around.getZ()));
                if (gap != null) h.addProperty("gap", gap);
            }
            if (stop != null) h.addProperty("stop", stop);
            return new Frame(h);
        }

        public static SearchRequest decode(Frame f) throws ProtocolException {
            expectType(f, "search");
            long id = reqId(f);
            JsonObject h = f.header();
            String dim = Json.reqString(h, "dimension", id);
            Integer stop = h.has("stop") ? positive(h, "stop", id) : null;
            if (trueOrAbsent(h, "continue", id)) {
                for (String k : List.of("materials", "radius", "around", "gap")) if (h.has(k)) throw ProtocolException.badRequest(id, "a continuing search takes only stop");
                return new SearchRequest(id, dim, true, null, null, null, null, stop);
            }
            return new SearchRequest(id, dim, false, readMaterials(h, "materials", false, id), h.has("radius") ? Json.reqCount(h, "radius", id) : null,
                    h.has("around") ? pos(h, "around", id) : null, h.has("gap") ? positive(h, "gap", id) : null, stop);
        }
    }

    /** A cluster of touching (edge or corner) matching chunks, chunk coordinates. */
    public record SearchCluster(int minX, int minZ, int maxX, int maxZ, int chunks, long blocks, boolean closed) {}

    /** One matching chunk: per material its count, its cluster, and the section ys with matches (ascending). */
    public record SearchChunk(int cx, int cz, long[] counts, int cluster, int[] sections) {}

    /**
     * {@code search.result}, mod → MCP, with a body: the whole walk so far. {@code chunks} ascending by
     * cz, then cx; {@code clusters} in walk order of each cluster's first chunk; {@code missing} the
     * walked ungenerated chunks, ascending by cz, then cx.
     */
    public record SearchResult(long id, String dimension, List<String> materials, int centreX, int centreZ, int radius, boolean clipped, int reached, int minSection,
            List<SearchCluster> clusters, List<SearchChunk> chunks, List<ChunkXZ> missing) {
        /** The chunk grid: the square of {@code radius} around the centre, x fastest, then z. */
        Grid grid() {
            return new Grid(centreX - radius, 0, centreZ - radius, 2 * radius + 1, 1, 2 * radius + 1);
        }

        public Frame encode() {
            JsonObject h = Json.header("search.result");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.add("materials", Json.strings(materials));
            h.add("centre", pair(centreX, centreZ));
            h.addProperty("radius", radius);
            if (clipped) h.addProperty("clipped", true);
            h.addProperty("reached", reached);
            h.addProperty("minSection", minSection);
            JsonArray cs = new JsonArray(clusters.size());
            for (SearchCluster c : clusters) {
                JsonObject o = new JsonObject();
                o.add("min", pair(c.minX(), c.minZ()));
                o.add("max", pair(c.maxX(), c.maxZ()));
                o.addProperty("chunks", c.chunks());
                o.addProperty("blocks", c.blocks());
                o.addProperty("closed", c.closed());
                cs.add(o);
            }
            h.add("clusters", cs);
            h.addProperty("chunks", chunks.size());
            h.addProperty("missing", missing.size());
            Grid g = grid();
            ByteWriter w = new ByteWriter(1024 + chunks.size() * (materials.size() + 6) + missing.size() * 2);
            long[] idx = new long[chunks.size()];
            for (int i = 0; i < idx.length; i++) idx[i] = g.indexOf(chunks.get(i).cx(), 0, chunks.get(i).cz());
            writeGaps(w, idx, "search chunks");
            for (SearchChunk c : chunks) {
                if (c.counts().length != materials.size()) throw new IllegalArgumentException("search chunk " + c.cx() + "," + c.cz() + ": counts for every material");
                if (c.cluster() < 0 || c.cluster() >= clusters.size()) throw new IllegalArgumentException("search chunk " + c.cx() + "," + c.cz() + ": no cluster " + c.cluster());
                for (long n : c.counts()) w.varint(n);
                w.varint(c.cluster());
                w.varint(c.sections().length);
                long[] offs = new long[c.sections().length];
                for (int i = 0; i < offs.length; i++) {
                    offs[i] = (long) c.sections()[i] - minSection;
                    if (offs[i] < 0) throw new IllegalArgumentException("search chunk " + c.cx() + "," + c.cz() + ": section below minSection");
                }
                writeGaps(w, offs, "search sections");
            }
            long[] mis = new long[missing.size()];
            for (int i = 0; i < mis.length; i++) mis[i] = g.indexOf(missing.get(i).cx(), 0, missing.get(i).cz());
            writeGaps(w, mis, "search missing");
            return new Frame(h, w.toByteArray());
        }

        public static SearchResult decode(Frame f) throws ProtocolException {
            expectType(f, "search.result");
            long id = reqId(f);
            JsonObject h = f.header();
            String dim = Json.reqString(h, "dimension", id);
            List<String> materials = readMaterials(h, "materials", false, id);
            int[] centre = Area.pair(Json.req(h, "centre", id), "centre", id);
            int radius = Json.reqCount(h, "radius", id);
            boolean clipped = trueOrAbsent(h, "clipped", id);
            int reached = Json.reqCount(h, "reached", id);
            if (reached > radius) throw ProtocolException.badRequest(id, "reached is past the radius");
            int minSection = Json.reqInt(h, "minSection", id);
            List<SearchCluster> clusters = new ArrayList<>();
            for (JsonElement e : Json.reqArray(h, "clusters", id)) {
                if (!e.isJsonObject()) throw ProtocolException.badRequest(id, "a cluster is an object");
                JsonObject o = e.getAsJsonObject();
                int[] min = Area.pair(Json.req(o, "min", id), "min", id), max = Area.pair(Json.req(o, "max", id), "max", id);
                if (min[0] > max[0] || min[1] > max[1]) throw ProtocolException.badRequest(id, "a cluster's min must not exceed its max");
                long blocks = Json.reqLong(o, "blocks", id);
                if (blocks < 0) throw ProtocolException.badRequest(id, "blocks must not be negative");
                clusters.add(new SearchCluster(min[0], min[1], max[0], max[1], positive(o, "chunks", id), blocks, Json.reqBool(o, "closed", id)));
            }
            int nChunks = Json.reqCount(h, "chunks", id), nMissing = Json.reqCount(h, "missing", id);
            SearchResult head = new SearchResult(id, dim, materials, centre[0], centre[1], radius, clipped, reached, minSection, clusters, List.of(), List.of());
            Grid g = head.grid();
            ByteReader r = new ByteReader(f.body());
            long[] idx = readGaps(r, nChunks, g.volume(), "search chunks");
            List<SearchChunk> chunks = new ArrayList<>(nChunks);
            for (long i : idx) {
                BlockPos p = g.posAt(i);
                long[] counts = new long[materials.size()];
                for (int m = 0; m < counts.length; m++) counts[m] = r.varint();
                int cluster = r.count(clusters.size() - 1L, "search cluster");
                int s = r.count(r.remaining(), "search section count");
                long[] offs = readGaps(r, s, Integer.MAX_VALUE, "search sections");
                int[] sections = new int[s];
                for (int k = 0; k < s; k++) sections[k] = Math.toIntExact(minSection + offs[k]);
                chunks.add(new SearchChunk(p.getX(), p.getZ(), counts, cluster, sections));
            }
            List<ChunkXZ> missing = new ArrayList<>(nMissing);
            for (long i : readGaps(r, nMissing, g.volume(), "search missing")) {
                BlockPos p = g.posAt(i);
                missing.add(new ChunkXZ(p.getX(), p.getZ()));
            }
            r.expectEnd("search");
            return new SearchResult(id, dim, materials, centre[0], centre[1], radius, clipped, reached, minSection, clusters, chunks, missing);
        }
    }

    // ── fill and expand ───────────────────────────────────────────────────────────────────────

    /**
     * {@code fill}, MCP → mod (18, piece 3): grows a shape from {@code seed} through {@code match},
     * depth-first as {@code {connected}}, inside a read area of chunks and the select grant. Null
     * fields mean the defaults: connectivity {@link #FILL_CONNECTIVITY}, budget {@code contextCap},
     * area {@link #FILL_AREA}.
     */
    public record FillRequest(long id, String dimension, BlockPos seed, List<String> match, @Nullable Integer connectivity, @Nullable Long budget, @Nullable Integer area) {
        public Frame encode() {
            JsonObject h = Json.header("fill");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.add("seed", Json.vec(seed.getX(), seed.getY(), seed.getZ()));
            h.add("match", Json.strings(match));
            if (connectivity != null) h.addProperty("connectivity", connectivity);
            if (budget != null) h.addProperty("budget", budget);
            if (area != null) h.addProperty("area", area);
            return new Frame(h);
        }

        public static FillRequest decode(Frame f) throws ProtocolException {
            expectType(f, "fill");
            long id = reqId(f);
            JsonObject h = f.header();
            Integer conn = h.has("connectivity") ? Json.reqInt(h, "connectivity", id) : null;
            if (conn != null && conn != 6 && conn != 18 && conn != 26) throw ProtocolException.badRequest(id, "connectivity must be 6, 18 or 26");
            return new FillRequest(id, Json.reqString(h, "dimension", id), pos(h, "seed", id), readMaterials(h, "match", true, id), conn,
                    h.has("budget") ? positiveLong(h, "budget", id) : null, h.has("area") ? Json.reqCount(h, "area", id) : null);
        }
    }

    /** How {@code expand} grows the read area: {@link #FRONTIER}, a direction and a chunk count, or a box. */
    public record ExpandBy(@Nullable String direction, int chunks, @Nullable Box box) {
        public static final ExpandBy FRONTIER = new ExpandBy(null, 0, null);

        public boolean frontier() {
            return direction == null && box == null;
        }

        JsonElement toJson() {
            if (frontier()) return new com.google.gson.JsonPrimitive("frontier");
            JsonObject o = new JsonObject();
            if (box != null) o.add("box", box.toJson());
            else {
                o.addProperty("direction", direction);
                o.addProperty("chunks", chunks);
            }
            return o;
        }
    }

    /** {@code expand}, MCP → mod (18, piece 4): grows the current fill's read area and resumes it with a fresh budget. */
    public record ExpandRequest(long id, String dimension, ExpandBy by, @Nullable Long budget) {
        public Frame encode() {
            JsonObject h = Json.header("expand");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.add("by", by.toJson());
            if (budget != null) h.addProperty("budget", budget);
            return new Frame(h);
        }

        public static ExpandRequest decode(Frame f) throws ProtocolException {
            expectType(f, "expand");
            long id = reqId(f);
            JsonObject h = f.header();
            JsonElement b = Json.req(h, "by", id);
            ExpandBy by;
            if (b.isJsonPrimitive() && b.getAsJsonPrimitive().isString() && b.getAsString().equals("frontier")) by = ExpandBy.FRONTIER;
            else {
                JsonObject o = Json.reqObject(h, "by", id);
                if (o.has("box")) {
                    if (o.has("direction") || o.has("chunks")) throw ProtocolException.badRequest(id, "by takes a box, or a direction and chunks");
                    by = new ExpandBy(null, 0, Box.fromJson(o.get("box"), "by.box", id));
                } else {
                    String dir = Json.reqString(o, "direction", id);
                    if (!DIRECTIONS.contains(dir)) throw ProtocolException.badRequest(id, "by.direction must be north, south, west or east");
                    by = new ExpandBy(dir, positive(o, "chunks", id), null);
                }
            }
            return new ExpandRequest(id, Json.reqString(h, "dimension", id), by, h.has("budget") ? positiveLong(h, "budget", id) : null);
        }
    }

    /** One section of a shape: {@code mask} a 512-byte bitset (bit {@code x + 16·(z + 16·y)}, LSB first), or null for every position. */
    public record MaskSection(int sx, int sy, int sz, byte @Nullable [] mask) {
        public boolean full() {
            return mask == null;
        }
    }

    /** Frontier positions of one section: local indices ascending, each with a face mask (1 to 63). */
    public record FrontierSection(int sx, int sy, int sz, int[] index, int[] faces) {}

    /**
     * {@code fill.result}, mod → MCP, with a body: the answer to {@code fill} and {@code expand}.
     * {@code box} null exactly when {@code count} is 0; {@code delta} (an expand's answer) lists only
     * the changed sections; {@code sections} and {@code frontier} ascending by sy, then sz, then sx.
     */
    public record FillResult(long id, String dimension, BlockPos seed, long count, @Nullable Box box, String stopped, boolean delta, List<ChunkXZ> missing,
            List<MaskSection> sections, List<FrontierSection> frontier) {
        /** The tight section grid over both lists. */
        Grid grid() {
            List<BlockPos> all = new ArrayList<>();
            for (MaskSection s : sections) all.add(new BlockPos(s.sx(), s.sy(), s.sz()));
            for (FrontierSection s : frontier) all.add(new BlockPos(s.sx(), s.sy(), s.sz()));
            return Grid.around(all);
        }

        public Frame encode() {
            if ((box == null) != (count == 0)) throw new IllegalArgumentException("fill.result: box is null exactly when count is 0");
            if (!FILL_STOPS.contains(stopped)) throw new IllegalArgumentException("fill.result: stopped " + stopped);
            JsonObject h = Json.header("fill.result");
            h.addProperty("id", id);
            h.addProperty("dimension", dimension);
            h.add("seed", Json.vec(seed.getX(), seed.getY(), seed.getZ()));
            h.addProperty("count", count);
            h.add("box", box == null ? com.google.gson.JsonNull.INSTANCE : box.toJson());
            h.addProperty("stopped", stopped);
            if (delta) h.addProperty("delta", true);
            h.add("missing", Messages.chunks(missing));
            Grid g = grid();
            g.writeTo(h);
            h.addProperty("sections", sections.size());
            h.addProperty("frontier", frontier.size());
            ByteWriter w = new ByteWriter(1024 + sections.size() * (MASK_BYTES + 4));
            long[] idx = new long[sections.size()];
            for (int i = 0; i < idx.length; i++) idx[i] = g.indexOf(sections.get(i).sx(), sections.get(i).sy(), sections.get(i).sz());
            writeGaps(w, idx, "fill sections");
            for (MaskSection s : sections) {
                if (s.full()) {
                    w.varint(0);
                    continue;
                }
                if (s.mask().length != MASK_BYTES) throw new IllegalArgumentException("fill section: a mask is " + MASK_BYTES + " bytes");
                if (uniform(s.mask(), (byte) 0) || uniform(s.mask(), (byte) 0xff)) throw new IllegalArgumentException("fill section: a bitset is neither empty nor full (send full as full)");
                w.varint(1);
                w.bytes(s.mask());
            }
            long[] fidx = new long[frontier.size()];
            for (int i = 0; i < fidx.length; i++) fidx[i] = g.indexOf(frontier.get(i).sx(), frontier.get(i).sy(), frontier.get(i).sz());
            writeGaps(w, fidx, "fill frontier");
            for (FrontierSection s : frontier) {
                if (s.index().length == 0 || s.index().length != s.faces().length) throw new IllegalArgumentException("frontier section: as many faces as positions, at least one");
                w.varint(s.index().length);
                long[] li = new long[s.index().length];
                for (int i = 0; i < li.length; i++) {
                    if (s.index()[i] < 0 || s.index()[i] > 4095) throw new IllegalArgumentException("frontier index out of the section");
                    li[i] = s.index()[i];
                }
                writeGaps(w, li, "frontier positions");
                for (int fc : s.faces()) {
                    if (fc < 1 || fc > 63) throw new IllegalArgumentException("a face mask is 1 to 63");
                    w.u8(fc);
                }
            }
            return new Frame(h, w.toByteArray());
        }

        private static boolean uniform(byte[] b, byte v) {
            for (byte x : b) if (x != v) return false;
            return true;
        }

        public static FillResult decode(Frame f) throws ProtocolException {
            expectType(f, "fill.result");
            long id = reqId(f);
            JsonObject h = f.header();
            String dim = Json.reqString(h, "dimension", id);
            BlockPos seed = pos(h, "seed", id);
            long count = Json.reqLong(h, "count", id);
            if (count < 0) throw ProtocolException.badRequest(id, "count must not be negative");
            JsonElement be = Json.req(h, "box", id);
            Box box = be.isJsonNull() ? null : Box.fromJson(be, "box", id);
            if ((box == null) != (count == 0)) throw ProtocolException.badRequest(id, "box is null exactly when count is 0");
            String stopped = Json.reqString(h, "stopped", id);
            if (!FILL_STOPS.contains(stopped)) throw ProtocolException.badRequest(id, "stopped must be complete, edge or budget");
            boolean delta = trueOrAbsent(h, "delta", id);
            List<ChunkXZ> missing = Messages.readChunks(h, "missing", id);
            Grid g = Grid.readFrom(h, id);
            int nSections = Json.reqCount(h, "sections", id), nFrontier = Json.reqCount(h, "frontier", id);
            ByteReader r = new ByteReader(f.body());
            List<MaskSection> sections = new ArrayList<>(nSections);
            for (long i : readGaps(r, nSections, g.volume(), "fill sections")) {
                BlockPos s = g.posAt(i);
                long kind = r.varint();
                if (kind == 0) sections.add(new MaskSection(s.getX(), s.getY(), s.getZ(), null));
                else if (kind == 1) {
                    byte[] mask = r.bytes(MASK_BYTES);
                    if (uniform(mask, (byte) 0) || uniform(mask, (byte) 0xff)) throw ProtocolException.malformed("fill section: a bitset is neither empty nor full");
                    sections.add(new MaskSection(s.getX(), s.getY(), s.getZ(), mask));
                } else throw ProtocolException.malformed("fill section: kind " + kind + " is neither 0 (full) nor 1 (bitset)");
            }
            List<FrontierSection> frontier = new ArrayList<>(nFrontier);
            for (long i : readGaps(r, nFrontier, g.volume(), "fill frontier")) {
                BlockPos s = g.posAt(i);
                int n = r.count(4096, "frontier positions");
                if (n < 1) throw ProtocolException.malformed("frontier section without positions");
                long[] li = readGaps(r, n, 4096, "frontier positions");
                int[] index = new int[n], faces = new int[n];
                for (int k = 0; k < n; k++) index[k] = (int) li[k];
                for (int k = 0; k < n; k++) {
                    faces[k] = r.u8();
                    if (faces[k] < 1 || faces[k] > 63) throw ProtocolException.malformed("a face mask is 1 to 63");
                }
                frontier.add(new FrontierSection(s.getX(), s.getY(), s.getZ(), index, faces));
            }
            r.expectEnd("fill");
            return new FillResult(id, dim, seed, count, box, stopped, delta, missing, sections, frontier);
        }
    }
}
