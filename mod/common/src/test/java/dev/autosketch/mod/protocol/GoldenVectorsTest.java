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
import dev.autosketch.mod.protocol.BodyTypes.WorldBlock;
import dev.autosketch.mod.protocol.Messages.Dirty;
import dev.autosketch.mod.protocol.Messages.HashesRequest;
import dev.autosketch.mod.protocol.Messages.HashesResult;
import dev.autosketch.mod.protocol.Messages.McpHello;
import dev.autosketch.mod.protocol.Messages.ModHello;
import dev.autosketch.mod.protocol.Messages.Notice;
import dev.autosketch.mod.protocol.Messages.Patch;
import dev.autosketch.mod.protocol.Messages.PatchAck;
import dev.autosketch.mod.protocol.Messages.SnapshotRequest;
import dev.autosketch.mod.protocol.Messages.SnapshotResult;
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
        assertTrue(names.size() >= 36, "found " + names.size() + " vectors in " + Golden.dir());
    }

    @TestFactory
    Stream<DynamicTest> vectors() {
        return Golden.frameNames().stream().map(name -> DynamicTest.dynamicTest(name, () -> check(name)));
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
            return; // prompt, prompt.result, chat: header-only messages of the in-game requests package
        }
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
            case "snapshot" -> SnapshotRequest.decode(f);
            case "snapshot.result" -> SnapshotResult.decode(f);
            case "patch" -> Patch.decode(f);
            case "patch.ack" -> PatchAck.decode(f);
            case "dirty" -> Dirty.decode(f);
            case "notice" -> Notice.decode(f);
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
            case SnapshotRequest x -> x.encode();
            case SnapshotResult x -> x.encode();
            case Patch x -> x.encode();
            case PatchAck x -> x.encode();
            case Dirty x -> x.encode();
            case Notice x -> x.encode();
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
            case "snapshot.result" -> snapshotResult(h, body);
            // Header-only messages: the typed decoder applied to the sidecar's header.
            default -> decodeTyped(new Frame(h), sender);
        };
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
        return new SnapshotResult(h.get("id").getAsLong(), h.get("dimension").getAsString(), palette, regions);
    }

    private static void assertSameContent(Object expected, Object actual) {
        if (expected instanceof SnapshotResult e && actual instanceof SnapshotResult a) {
            assertEquals(e.id(), a.id());
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
