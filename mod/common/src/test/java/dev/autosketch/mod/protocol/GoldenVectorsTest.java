package dev.autosketch.mod.protocol;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.autosketch.mod.protocol.BodyTypes.AckLists;
import dev.autosketch.mod.protocol.BodyTypes.BlockEntityNbt;
import dev.autosketch.mod.protocol.BodyTypes.Normalized;
import dev.autosketch.mod.protocol.BodyTypes.PatchBlock;
import dev.autosketch.mod.protocol.BodyTypes.Rejected;
import dev.autosketch.mod.protocol.BodyTypes.SnapshotRegion;
import dev.autosketch.mod.protocol.BodyTypes.SurfaceLayer;
import dev.autosketch.mod.protocol.BodyTypes.UpgradeData;
import dev.autosketch.mod.protocol.BodyTypes.WorldBlock;
import dev.autosketch.mod.protocol.Messages.Dirty;
import dev.autosketch.mod.protocol.Messages.HashesRequest;
import dev.autosketch.mod.protocol.Messages.HashesResult;
import dev.autosketch.mod.protocol.Messages.McpHello;
import dev.autosketch.mod.protocol.Messages.ModHello;
import dev.autosketch.mod.protocol.Messages.Chat;
import dev.autosketch.mod.protocol.Messages.Notice;
import dev.autosketch.mod.protocol.Messages.Patch;
import dev.autosketch.mod.protocol.Messages.PatchAck;
import dev.autosketch.mod.protocol.Messages.SnapshotRequest;
import dev.autosketch.mod.protocol.Messages.SnapshotResult;
import dev.autosketch.mod.protocol.Messages.ChunkXZ;
import dev.autosketch.mod.protocol.Messages.Prompt;
import dev.autosketch.mod.protocol.Messages.PromptClose;
import dev.autosketch.mod.protocol.Messages.PromptResult;
import dev.autosketch.mod.protocol.Messages.RegistryRequest;
import dev.autosketch.mod.protocol.Messages.RegistryResult;
import dev.autosketch.mod.protocol.Messages.UpgradeRequest;
import dev.autosketch.mod.protocol.Messages.UpgradeResult;
import dev.autosketch.mod.protocol.Messages.SurfaceRequest;
import dev.autosketch.mod.protocol.Messages.SurfaceResult;
import dev.autosketch.mod.protocol.Messages.VolumesSet;
import dev.autosketch.mod.protocol.Messages.Volumes;
import dev.autosketch.mod.protocol.Messages.VolumesExtend;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;

/**
 * Every golden vector (13, *Golden vectors*): the frame decodes to its sidecar's header, the typed
 * message decodes to the sidecar's body, and both the decoded message and one built from the sidecar
 * alone re-encode to the same bytes.
 */
class GoldenVectorsTest {
    @Test
    void everyMessageKindHasAVector() {
        List<String> names = Golden.frameNames();
        assertTrue(names.size() >= 150, "found " + names.size() + " vectors in " + Golden.dir());
        assertTrue(Golden.frameNames("v3/").size() >= 127, "the frozen version-3 vectors");
        assertTrue(Golden.frameNames("v2/").size() >= 48, "the frozen version-2 vectors");
        assertTrue(Golden.frameNames("v1/").size() >= 36, "the frozen version-1 vectors");
    }

    @TestFactory
    Stream<DynamicTest> vectors() {
        return Golden.frameNames().stream().map(name -> DynamicTest.dynamicTest(name, () -> check(name)));
    }

    /**
     * Frozen frames carrying {@code prompt.scan}, which protocol 4 retired (18, *Removal*): the
     * typed {@code prompt} no longer has the field, so they decode but don't re-encode byte for byte.
     */
    static final List<String> RETIRED = List.of("v2/prompt-scan", "v3/prompt-scan");

    /** The version-3 frames (the MCP's N−1) still decode and re-encode unchanged, but for the retired scan grant. */
    @TestFactory
    Stream<DynamicTest> version3Vectors() {
        return frozen("v3/");
    }

    /** The version-2 frames, no longer spoken, kept as a check that the codec only grew additively until protocol 4. */
    @TestFactory
    Stream<DynamicTest> version2Vectors() {
        return frozen("v2/");
    }

    private static Stream<DynamicTest> frozen(String dir) {
        return Golden.frameNames(dir).stream().map(name -> DynamicTest.dynamicTest(name, () -> {
            if (RETIRED.contains(name)) Messages.Prompt.decode(FrameCodec.decode(Golden.bin(name)));
            else check(name);
        }));
    }

    /** The version-1 frames, no longer spoken, kept as a check that the codec only grew additively. */
    @TestFactory
    Stream<DynamicTest> version1Vectors() {
        return Golden.frameNames("v1/").stream().map(name -> DynamicTest.dynamicTest(name, () -> check(name)));
    }

    private static void check(String name) throws Exception {
        byte[] bin = Golden.bin(name);
        JsonObject side = Golden.json(name);
        Frame frame = FrameCodec.decode(bin);
        assertEquals(side.get("header"), frame.header(), "header");
        assertArrayEquals(bin, FrameCodec.encode(frame), "frame re-encodes byte for byte");

        String sender = side.get("sender").getAsString();
        Object decoded = decodeTyped(frame, sender);
        if (decoded == null) {
            assertFalse(frame.hasBody());
            return; // a message with no typed decoder
        }
        // The mod speaks one version, its own, so its typed hello always says 4: an older mod
        // hello only has to decode.
        if (decoded instanceof ModHello && Json.reqInt(frame.header(), "protocol", null) != Messages.PROTOCOL_VERSION) return;
        assertArrayEquals(bin, FrameCodec.encode(encodeTyped(decoded)), "typed message re-encodes byte for byte");

        Object built = fromSidecar(frame.type(), sender, side);
        assertSameContent(built, decoded);
        assertArrayEquals(bin, FrameCodec.encode(encodeTyped(built)), "message built from the sidecar encodes to the vector");
    }

    private static Object decodeTyped(Frame f, String sender) throws ProtocolException {
        return switch (f.type()) {
            case "hello" -> sender.equals("mcp") ? McpHello.decode(f) : ModHello.decode(f);
            case "error" -> ErrorMessage.decode(f);
            case "volumes" -> Volumes.decode(f);
            case "volumes.extend" -> VolumesExtend.decode(f);
            case "hashes" -> HashesRequest.decode(f);
            case "hashes.result" -> HashesResult.decode(f);
            case "volumes.set" -> VolumesSet.decode(f);
            case "snapshot" -> SelectMessages.handles(f) ? SelectMessages.decode(f) : Messages.snapshotKind(f).equals("surface") ? SurfaceRequest.decode(f) : SnapshotRequest.decode(f);
            case "snapshot.result" -> SelectMessages.handles(f) ? SelectMessages.decode(f) : "surface".equals(Json.optString(f.header(), "kind", null)) ? SurfaceResult.decode(f) : SnapshotResult.decode(f);
            case "search", "search.result", "fill", "fill.result", "expand" -> SelectMessages.decode(f);
            case "prompt" -> Prompt.decode(f);
            case "prompt.result" -> PromptResult.decode(f);
            case "prompt.close" -> PromptClose.decode(f);
            case "patch" -> Patch.decode(f);
            case "patch.ack" -> PatchAck.decode(f);
            case "dirty" -> Dirty.decode(f);
            case "notice" -> Notice.decode(f);
            case "chat" -> RequestMessages.isStatus(f) ? RequestMessages.Status.decode(f) : Chat.decode(f);
            case "request.control", "canvas", "canvas.set", "patch.drop" -> RequestMessages.decode(f);
            case "registry" -> RegistryRequest.decode(f);
            case "registry.result" -> RegistryResult.decode(f);
            case "upgrade" -> UpgradeRequest.decode(f);
            case "upgrade.result" -> UpgradeResult.decode(f);
            case "ui.state", "ui.flash", "ui.ghost", "ui.ghost.clear", "replay.frame", "ui.request", "ui.result" -> UiMessages.decode(f);
            default -> null;
        };
    }

    private static Frame encodeTyped(Object m) {
        return switch (m) {
            case McpHello x -> x.encode();
            case ModHello x -> x.encode();
            case ErrorMessage x -> x.encode();
            case Volumes x -> x.encode();
            case VolumesExtend x -> x.encode();
            case HashesRequest x -> x.encode();
            case HashesResult x -> x.encode();
            case VolumesSet x -> x.encode();
            case SnapshotRequest x -> x.encode();
            case SurfaceRequest x -> x.encode();
            case SnapshotResult x -> x.encode();
            case SurfaceResult x -> x.encode();
            case Prompt x -> x.encode();
            case PromptResult x -> x.encode();
            case PromptClose x -> x.encode();
            case Patch x -> x.encode();
            case PatchAck x -> x.encode();
            case Dirty x -> x.encode();
            case Notice x -> x.encode();
            case Chat x -> x.encode();
            case RegistryRequest x -> x.encode();
            case RegistryResult x -> x.encode();
            case UpgradeRequest x -> x.encode();
            case UpgradeResult x -> x.encode();
            case UiMessages.UiState x -> x.encode();
            case UiMessages.UiFlash x -> x.encode();
            case UiMessages.UiGhost x -> x.encode();
            case UiMessages.UiGhostClear x -> x.encode();
            case UiMessages.ReplayFrame x -> x.encode();
            case UiMessages.UiRequest x -> x.encode();
            case UiMessages.UiResult x -> x.encode();
            case SelectMessages.SearchRequest x -> x.encode();
            case SelectMessages.SearchResult x -> x.encode();
            case SelectMessages.FillRequest x -> x.encode();
            case SelectMessages.ExpandRequest x -> x.encode();
            case SelectMessages.FillResult x -> x.encode();
            case SelectMessages.MaskSnapshotRequest x -> x.encode();
            case SelectMessages.CoarseSnapshotRequest x -> x.encode();
            case SelectMessages.CoarseResult x -> x.encode();
            case RequestMessages.Status x -> x.encode();
            case RequestMessages.RequestControl x -> x.encode();
            case RequestMessages.Canvas x -> x.encode();
            case RequestMessages.CanvasSet x -> x.encode();
            case RequestMessages.PatchDrop x -> x.encode();
            default -> throw new IllegalArgumentException(m.toString());
        };
    }

    // ── messages built from the sidecar alone ─────────────────────────────────────────────────

    private static Object fromSidecar(String type, String sender, JsonObject side) throws ProtocolException {
        JsonObject h = side.getAsJsonObject("header");
        JsonObject body = side.getAsJsonObject("body");
        return switch (type) {
            case "patch" -> new Patch(h.get("id").getAsLong(), h.get("link").getAsLong(), h.get("dimension").getAsString(),
                    h.has("force"), side.has("generated") ? largePatch() : patchBlocks(body));
            case "patch.ack" -> new PatchAck(h.get("id").getAsLong(), h.get("applied").getAsInt(), h.get("overwritten").getAsInt(), ackLists(body));
            case "dirty" -> h.get("everything").getAsBoolean() ? Dirty.all() : new Dirty(false, worldBlocks(body.getAsJsonArray("blocks")));
            case "snapshot.result" -> !h.has("kind") ? snapshotResult(h, body) : h.get("kind").getAsString().equals("coarse") ? coarseResult(h, body) : surfaceResult(h, body);
            case "search.result" -> searchResult(h, body);
            case "fill.result" -> fillResult(h, body);
            case "registry.result" -> new RegistryResult(h.get("id").getAsLong(), Long.parseUnsignedLong(h.get("hash").getAsString(), 16), h.get("dataVersion").getAsInt(),
                    body == null ? null : java.util.Base64.getDecoder().decode(body.get("bytes").getAsString()));
            case "upgrade" -> new UpgradeRequest(h.get("id").getAsLong(), h.get("from").getAsInt(), upgradeData(h, body));
            case "upgrade.result" -> new UpgradeResult(h.get("id").getAsLong(), h.get("to").getAsInt(), h.has("failed") ? h.get("failed").getAsInt() : 0, upgradeData(h, body));
            case "ui.ghost" -> uiGhost(h, body);
            case "replay.frame" -> replayFrame(h, body);
            case "ui.result" -> {
                UiMessages.UiResult r = UiMessages.UiResult.decode(new Frame(h));
                yield body == null ? r : new UiMessages.UiResult(r.request(), r.player(), r.ok(), r.result(), r.error(), r.message(), java.util.Base64.getDecoder().decode(body.get("bytes").getAsString()));
            }
            // Header-only messages: the typed decoder applied to the sidecar's header.
            default -> decodeTyped(new Frame(h), sender);
        };
    }

    private static int[] ints(JsonElement a) {
        var arr = a.getAsJsonArray();
        int[] out = new int[arr.size()];
        for (int i = 0; i < out.length; i++) out[i] = arr.get(i).getAsInt();
        return out;
    }

    private static List<String> strings(JsonElement a) {
        List<String> out = new ArrayList<>();
        for (JsonElement e : a.getAsJsonArray()) out.add(e.getAsString());
        return out;
    }

    /** A ghost from its sidecar: the header's fields with the body's palette and sections. */
    private static UiMessages.UiGhost uiGhost(JsonObject h, JsonObject body) throws ProtocolException {
        UiMessages.UiGhost head = UiMessages.UiGhost.decode(new Frame(withoutSections(h), new byte[] {0, 0}));
        List<UiMessages.GhostSection> sections = new ArrayList<>();
        for (JsonElement e : body.getAsJsonArray("sections")) {
            int[] s = ints(e.getAsJsonObject().get("section"));
            sections.add(new UiMessages.GhostSection(s[0], s[1], s[2], ints(e.getAsJsonObject().get("states"))));
        }
        return new UiMessages.UiGhost(head.players(), head.ghost(), head.dimension(), head.originX(), head.originY(), head.originZ(), head.tint(), head.full(),
                strings(body.get("palette")), sections);
    }

    private static JsonObject withoutSections(JsonObject h) {
        JsonObject c = h.deepCopy();
        c.add("sections", new com.google.gson.JsonArray());
        return c;
    }

    /** A replay frame from its sidecar: the header, then the body's keyframe regions or delta blocks. */
    private static UiMessages.ReplayFrame replayFrame(JsonObject h, JsonObject body) throws ProtocolException {
        JsonObject c = h.deepCopy();
        boolean keyframe = h.get("keyframe").getAsBoolean();
        List<SnapshotRegion> regions = new ArrayList<>();
        List<WorldBlock> blocks = new ArrayList<>();
        if (keyframe) {
            List<Box> boxes = Json.reqBoxes(h, "regions", null);
            for (int i = 0; i < boxes.size(); i++) regions.add(new SnapshotRegion(boxes.get(i), ints(body.getAsJsonArray("regions").get(i).getAsJsonObject().get("states")), List.of()));
            c.add("regions", new com.google.gson.JsonArray());
        } else {
            blocks.addAll(worldBlocks(body.getAsJsonArray("blocks")));
            c.add("origin", Json.vec(0, 0, 0));
            c.add("size", Json.vec(0, 0, 0));
            c.addProperty("count", 0);
        }
        UiMessages.ReplayFrame head = UiMessages.ReplayFrame.decode(new Frame(c, keyframe ? new byte[] {0, 0} : new byte[] {0, 0, 0}));
        return new UiMessages.ReplayFrame(head.players(), head.replay(), head.step(), head.steps(), keyframe, head.from(), head.dimension(),
                keyframe ? strings(body.get("palette")) : List.of(), regions, blocks, head.time(), head.hud(), head.jobs(), head.flashes(), head.markers());
    }

    private static UpgradeData upgradeData(JsonObject h, JsonObject body) {
        if (h.get("kind").getAsString().equals("structure")) return UpgradeData.structure(Golden.snbt(body.get("structure").getAsString()));
        List<String> states = new ArrayList<>();
        for (JsonElement e : body.getAsJsonArray("states")) states.add(e.getAsString());
        List<CompoundTag> bes = new ArrayList<>(), ents = new ArrayList<>();
        for (JsonElement e : body.getAsJsonArray("blockEntities")) bes.add(Golden.snbt(e.getAsString()));
        for (JsonElement e : body.getAsJsonArray("entities")) ents.add(Golden.snbt(e.getAsString()));
        return UpgradeData.elements(states, bes, ents);
    }

    private static List<PatchBlock> patchBlocks(JsonObject body) {
        List<PatchBlock> out = new ArrayList<>();
        for (JsonElement e : body.getAsJsonArray("blocks")) {
            JsonObject b = e.getAsJsonObject();
            Long hash = b.has("expectedNbtHash") ? Long.parseUnsignedLong(b.get("expectedNbtHash").getAsString(), 16) : null;
            out.add(new PatchBlock(Golden.pos(b.get("pos")), b.get("expected").getAsString(), b.get("state").getAsString(), hash, nbt(b)));
        }
        return out;
    }

    /** The rule in patch-large.json's {@code generated}. */
    private static List<PatchBlock> largePatch() {
        String[] states = {"minecraft:oak_planks", "minecraft:stone_bricks", "minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]", "minecraft:glass"};
        List<PatchBlock> out = new ArrayList<>();
        for (int dy = 0; dy < 16; dy++)
            for (int dz = 0; dz < 40; dz++)
                for (int dx = 0; dx < 40; dx++) {
                    if ((dx + 3 * dy + 7 * dz) % 5 == 0) continue;
                    out.add(new PatchBlock(new BlockPos(100 + dx, 64 + dy, -200 + dz), dy < 8 ? "minecraft:air" : "minecraft:stone", states[(dx + dy + dz) % 4], null, null));
                }
        assertEquals(20480, out.size());
        return out;
    }

    private static CompoundTag nbt(JsonObject o) {
        return o.has("nbt") ? Golden.snbt(o.get("nbt").getAsString()) : null;
    }

    private static List<WorldBlock> worldBlocks(com.google.gson.JsonArray a) {
        List<WorldBlock> out = new ArrayList<>();
        for (JsonElement e : a) {
            JsonObject b = e.getAsJsonObject();
            out.add(new WorldBlock(Golden.pos(b.get("pos")), b.get("state").getAsString(), nbt(b)));
        }
        return out;
    }

    private static AckLists ackLists(JsonObject body) {
        List<Rejected> rej = new ArrayList<>();
        for (JsonElement e : body.getAsJsonArray("rejected")) rej.add(new Rejected(Golden.pos(e.getAsJsonObject().get("pos")), e.getAsJsonObject().get("reason").getAsString()));
        List<Normalized> norm = new ArrayList<>();
        for (JsonElement e : body.getAsJsonArray("normalized")) norm.add(new Normalized(Golden.pos(e.getAsJsonObject().get("pos")), nbt(e.getAsJsonObject())));
        return new AckLists(worldBlocks(body.getAsJsonArray("skipped")), rej, norm);
    }

    private static SnapshotResult snapshotResult(JsonObject h, JsonObject body) throws ProtocolException {
        List<Box> boxes = Json.reqBoxes(h, "regions", null);
        List<String> palette = new ArrayList<>();
        for (JsonElement e : body.getAsJsonArray("palette")) palette.add(e.getAsString());
        List<SnapshotRegion> regions = new ArrayList<>();
        var rs = body.getAsJsonArray("regions");
        for (int i = 0; i < boxes.size(); i++) {
            JsonObject r = rs.get(i).getAsJsonObject();
            var st = r.getAsJsonArray("states");
            int[] states = new int[st.size()];
            for (int j = 0; j < states.length; j++) states[j] = st.get(j).getAsInt();
            List<BlockEntityNbt> bes = new ArrayList<>();
            for (JsonElement e : r.getAsJsonArray("blockEntities")) bes.add(new BlockEntityNbt(Golden.pos(e.getAsJsonObject().get("pos")), nbt(e.getAsJsonObject())));
            regions.add(new SnapshotRegion(boxes.get(i), states, bes));
        }
        List<ChunkXZ> missing = null;
        if (h.has("missing")) {
            missing = new ArrayList<>();
            for (JsonElement e : h.getAsJsonArray("missing")) missing.add(new ChunkXZ(e.getAsJsonArray().get(0).getAsInt(), e.getAsJsonArray().get(1).getAsInt()));
        }
        return new SnapshotResult(h.get("id").getAsLong(), h.get("dimension").getAsString(), palette, regions, missing);
    }

    private static List<ChunkXZ> chunkList(JsonElement a) {
        List<ChunkXZ> out = new ArrayList<>();
        for (JsonElement e : a.getAsJsonArray()) out.add(new ChunkXZ(e.getAsJsonArray().get(0).getAsInt(), e.getAsJsonArray().get(1).getAsInt()));
        return out;
    }

    /** A coarse result from its sidecar: the header with the body's palette and per-cell states. */
    private static SelectMessages.CoarseResult coarseResult(JsonObject h, JsonObject body) throws ProtocolException {
        List<Box> boxes = Json.reqBoxes(h, "regions", null);
        List<SelectMessages.CoarseRegion> regions = new ArrayList<>();
        for (int i = 0; i < boxes.size(); i++) regions.add(new SelectMessages.CoarseRegion(boxes.get(i), ints(body.getAsJsonArray("regions").get(i).getAsJsonObject().get("states"))));
        return new SelectMessages.CoarseResult(h.get("id").getAsLong(), h.get("dimension").getAsString(), h.get("cell").getAsInt(), strings(body.get("palette")), regions,
                h.has("missing") ? chunkList(h.get("missing")) : null);
    }

    /** A search result from its sidecar: the header's fields with the body's chunks and missing chunks. */
    private static SelectMessages.SearchResult searchResult(JsonObject h, JsonObject body) throws ProtocolException {
        JsonObject c = h.deepCopy();
        c.addProperty("chunks", 0);
        c.addProperty("missing", 0);
        SelectMessages.SearchResult head = SelectMessages.SearchResult.decode(new Frame(c));
        List<SelectMessages.SearchChunk> chunks = new ArrayList<>();
        for (JsonElement e : body.getAsJsonArray("chunks")) {
            JsonObject o = e.getAsJsonObject();
            int[] at = ints(o.get("chunk"));
            int[] counts = ints(o.get("counts"));
            long[] lc = new long[counts.length];
            for (int i = 0; i < counts.length; i++) lc[i] = counts[i];
            chunks.add(new SelectMessages.SearchChunk(at[0], at[1], lc, o.get("cluster").getAsInt(), ints(o.get("sections"))));
        }
        return new SelectMessages.SearchResult(head.id(), head.dimension(), head.materials(), head.centreX(), head.centreZ(), head.radius(), head.clipped(), head.reached(),
                head.minSection(), head.clusters(), chunks, chunkList(body.get("missing")));
    }

    /** A fill result from its sidecar: the header's fields with the body's sections (hex bitsets) and frontier. */
    private static SelectMessages.FillResult fillResult(JsonObject h, JsonObject body) throws ProtocolException {
        JsonObject c = h.deepCopy();
        c.add("origin", Json.vec(0, 0, 0));
        c.add("size", Json.vec(0, 0, 0));
        c.addProperty("sections", 0);
        c.addProperty("frontier", 0);
        SelectMessages.FillResult head = SelectMessages.FillResult.decode(new Frame(c));
        List<SelectMessages.MaskSection> sections = new ArrayList<>();
        for (JsonElement e : body.getAsJsonArray("sections")) {
            JsonObject o = e.getAsJsonObject();
            int[] s = ints(o.get("section"));
            String mask = o.get("mask").getAsString();
            sections.add(new SelectMessages.MaskSection(s[0], s[1], s[2], mask.equals("full") ? null : java.util.HexFormat.of().parseHex(mask)));
        }
        List<SelectMessages.FrontierSection> frontier = new ArrayList<>();
        for (JsonElement e : body.getAsJsonArray("frontier")) {
            JsonObject o = e.getAsJsonObject();
            int[] s = ints(o.get("section"));
            frontier.add(new SelectMessages.FrontierSection(s[0], s[1], s[2], ints(o.get("index")), ints(o.get("faces"))));
        }
        return new SelectMessages.FillResult(head.id(), head.dimension(), head.seed(), head.count(), head.box(), head.stopped(), head.delta(), head.missing(), sections, frontier);
    }

    private static SurfaceResult surfaceResult(JsonObject h, JsonObject body) throws ProtocolException {
        List<String> palette = new ArrayList<>();
        for (JsonElement e : body.getAsJsonArray("palette")) palette.add(e.getAsString());
        List<ChunkXZ> missing = new ArrayList<>();
        for (JsonElement e : h.getAsJsonArray("missing")) missing.add(new ChunkXZ(e.getAsJsonArray().get(0).getAsInt(), e.getAsJsonArray().get(1).getAsInt()));
        Integer ceiling = h.has("ceiling") ? h.get("ceiling").getAsInt() : null;
        return new SurfaceResult(h.get("id").getAsLong(), h.get("dimension").getAsString(), Area.fromJson(h.get("columns"), "columns", null),
                h.get("minY").getAsInt(), ceiling, missing, palette, layer(body.getAsJsonObject("surface")),
                body.has("ceilings") ? layer(body.getAsJsonObject("ceilings")) : null);
    }

    private static SurfaceLayer layer(JsonObject o) {
        var hs = o.getAsJsonArray("heights");
        var ss = o.getAsJsonArray("states");
        SurfaceLayer l = SurfaceLayer.of(hs.size());
        for (int i = 0; i < hs.size(); i++) {
            l.heights()[i] = hs.get(i).getAsInt();
            l.states()[i] = ss.get(i).getAsInt();
        }
        return l;
    }

    private static void assertSameContent(Object expected, Object actual) {
        // ui messages holding arrays (ghost sections, replay regions, result bodies): compare what they encode to.
        if (expected instanceof UiMessages.UiGhost || expected instanceof UiMessages.ReplayFrame || expected instanceof UiMessages.UiResult
                || expected instanceof SelectMessages.SearchResult || expected instanceof SelectMessages.FillResult || expected instanceof SelectMessages.CoarseResult) {
            assertEquals(expected.getClass(), actual.getClass());
            assertArrayEquals(FrameCodec.encode(encodeTyped(expected)), FrameCodec.encode(encodeTyped(actual)), "decoded content matches the sidecar");
            return;
        }
        if (expected instanceof RegistryResult e && actual instanceof RegistryResult a) {
            assertEquals(e.id(), a.id());
            assertEquals(e.hash(), a.hash());
            assertEquals(e.dataVersion(), a.dataVersion());
            assertEquals(e.report() == null, a.report() == null);
            if (e.report() != null) assertArrayEquals(e.report(), a.report(), "report bytes");
            return;
        }
        if (expected instanceof SurfaceResult e && actual instanceof SurfaceResult a) {
            assertEquals(e.id(), a.id());
            assertEquals(e.columns(), a.columns());
            assertEquals(e.minY(), a.minY());
            assertEquals(e.ceiling(), a.ceiling());
            assertEquals(e.missing(), a.missing());
            assertEquals(e.palette(), a.palette(), "palette in first-use order");
            assertArrayEquals(e.surface().heights(), a.surface().heights(), "surface heights");
            assertArrayEquals(e.surface().states(), a.surface().states(), "surface states");
            assertEquals(e.ceilings() == null, a.ceilings() == null);
            if (e.ceilings() != null) {
                assertArrayEquals(e.ceilings().heights(), a.ceilings().heights(), "ceiling heights");
                assertArrayEquals(e.ceilings().states(), a.ceilings().states(), "ceiling states");
            }
            return;
        }
        if (expected instanceof SnapshotResult e && actual instanceof SnapshotResult a) {
            assertEquals(e.id(), a.id());
            assertEquals(e.missing(), a.missing());
            assertEquals(e.dimension(), a.dimension());
            assertEquals(e.palette(), a.palette(), "palette in first-use order");
            assertEquals(e.regions().size(), a.regions().size());
            for (int i = 0; i < e.regions().size(); i++) {
                assertEquals(e.regions().get(i).box(), a.regions().get(i).box());
                assertArrayEquals(e.regions().get(i).states(), a.regions().get(i).states(), "region " + i + " states");
                assertEquals(e.regions().get(i).blockEntities(), a.regions().get(i).blockEntities(), "region " + i + " block entities");
            }
            return;
        }
        assertEquals(expected, actual, "decoded content matches the sidecar");
    }
}
