package dev.autosketch.mod.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.autosketch.mod.protocol.Messages.Section;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Select on the wire (18; 13, *Message schemas*, *Select*): the mask layout rule, cell alignment and the decoders' checks. */
class SelectMessagesTest {
    private static Frame header(String json) {
        return new Frame(Json.parse(json).getAsJsonObject());
    }

    private static void refused(String json) {
        ProtocolException e = assertThrows(ProtocolException.class, () -> SelectMessages.decode(header(json)));
        assertEquals("bad_request", e.code());
    }

    @Test
    void maskRegionsMatchTheSharedVector() throws Exception {
        JsonObject file = Golden.json("mask-regions");
        int n = 0;
        for (JsonElement c : file.getAsJsonArray("cases")) {
            JsonObject o = c.getAsJsonObject();
            List<Section> sections = new ArrayList<>();
            for (JsonElement s : o.getAsJsonArray("sections")) {
                var a = s.getAsJsonArray();
                sections.add(new Section(a.get(0).getAsInt(), a.get(1).getAsInt(), a.get(2).getAsInt()));
            }
            List<Box> want = new ArrayList<>();
            for (JsonElement b : o.getAsJsonArray("regions")) want.add(Box.fromJson(b, "region", null));
            assertEquals(want, SelectMessages.maskRegions(sections, o.get("margin").getAsInt()), o.get("description").getAsString());
            n++;
        }
        assertEquals(3, n);
    }

    @Test
    void alignsCoarseBoxesOutwardToTheWorldGrid() {
        assertEquals(new Box(-8, 64, 32, -1, 71, 39), SelectMessages.align(new Box(-7, 64, 33, -1, 70, 38), 4));
        assertEquals(new Box(0, -64, 0, 1, -63, 1), SelectMessages.align(new Box(1, -63, 0, 1, -63, 0), 2));
    }

    @Test
    void refusesMalformedSelectRequests() {
        refused("{\"type\":\"search\",\"id\":1,\"dimension\":\"minecraft:overworld\",\"materials\":[]}");
        refused("{\"type\":\"search\",\"id\":1,\"dimension\":\"minecraft:overworld\",\"materials\":[\"stone_bricks\"]}");
        refused("{\"type\":\"search\",\"id\":1,\"dimension\":\"minecraft:overworld\",\"materials\":[\"solid\"]}");
        refused("{\"type\":\"search\",\"id\":1,\"dimension\":\"minecraft:overworld\",\"continue\":true,\"materials\":[\"minecraft:stone\"]}");
        refused("{\"type\":\"search\",\"id\":1,\"dimension\":\"minecraft:overworld\",\"materials\":[\"minecraft:stone\"],\"stop\":0}");
        refused("{\"type\":\"fill\",\"id\":1,\"dimension\":\"minecraft:overworld\",\"seed\":[0,0,0],\"match\":[\"minecraft:stone\"],\"connectivity\":8}");
        refused("{\"type\":\"expand\",\"id\":1,\"dimension\":\"minecraft:overworld\",\"by\":{\"direction\":\"up\",\"chunks\":1}}");
        refused("{\"type\":\"expand\",\"id\":1,\"dimension\":\"minecraft:overworld\",\"by\":\"everything\"}");
        refused("{\"type\":\"snapshot\",\"id\":1,\"dimension\":\"minecraft:overworld\",\"kind\":\"mask\",\"sections\":[[0,4,0]],\"margin\":17}");
        refused("{\"type\":\"snapshot\",\"id\":1,\"dimension\":\"minecraft:overworld\",\"kind\":\"mask\",\"sections\":[[0,4,0],[0,4,0]]}");
        refused("{\"type\":\"snapshot\",\"id\":1,\"dimension\":\"minecraft:overworld\",\"kind\":\"coarse\",\"cell\":3,\"boxes\":[{\"min\":[0,0,0],\"max\":[1,1,1]}]}");
    }

    @Test
    void aModWithoutTheKindsRefusesThemAsABlocksSnapshot() {
        ProtocolException e = assertThrows(ProtocolException.class,
                () -> Messages.SnapshotRequest.decode(header("{\"type\":\"snapshot\",\"id\":7,\"dimension\":\"minecraft:overworld\",\"kind\":\"mask\",\"sections\":[[0,4,0]]}")));
        assertEquals("bad_request", e.code());
        assertTrue(Messages.REQUEST_MODES.contains("select"));
    }

    @Test
    void fillResultsKeepMasksCanonical() {
        var full = new SelectMessages.MaskSection(0, 4, 0, new byte[SelectMessages.MASK_BYTES]);
        java.util.Arrays.fill(full.mask(), (byte) 0xff);
        var r = new SelectMessages.FillResult(1, "minecraft:overworld", new net.minecraft.core.BlockPos(0, 64, 0), 4096, new Box(0, 64, 0, 15, 79, 15), "complete", false,
                List.of(), List.of(full), List.of());
        assertThrows(IllegalArgumentException.class, r::encode);
        var none = new SelectMessages.FillResult(1, "minecraft:overworld", new net.minecraft.core.BlockPos(0, 64, 0), 0, new Box(0, 64, 0, 0, 64, 0), "complete", false,
                List.of(), List.of(), List.of());
        assertThrows(IllegalArgumentException.class, none::encode);
    }
}
