package dev.autosketch.mod.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;

/** The in-game UI messages beyond the per-vector round trip (13, *In-game UI*, *Relay to the client*). */
class UiMessagesTest {
    private static String sha(byte[] b) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
    }

    @Test
    void relayPartsRebuildsTheLargeGhostAndSplitsItAsListed() throws Exception {
        JsonObject side = Golden.json("relay-parts");
        JsonObject h = side.getAsJsonObject("header");
        List<UiMessages.GhostSection> sections = new ArrayList<>();
        int k = 0;
        for (int sy = 0; sy < 2; sy++)
            for (int sz = 0; sz < 10; sz++)
                for (int sx = 0; sx < 13; sx++) {
                    int[] states = new int[4096];
                    for (int i = 0; i < 4096; i++) states[i] = (i + k) % 3;
                    sections.add(new UiMessages.GhostSection(sx, sy, sz, states));
                    k++;
                }
        int[] o = Json.reqVec(h, "origin", null);
        UiMessages.UiGhost ghost = new UiMessages.UiGhost(List.of(UUID.fromString(h.getAsJsonArray("players").get(0).getAsString())), h.get("ghost").getAsString(),
                h.get("dimension").getAsString(), o[0], o[1], o[2], UiMessages.parseColour(h.get("tint").getAsString()), true,
                List.of("minecraft:air", "minecraft:stone", "minecraft:glass"), sections);
        byte[] frame = FrameCodec.encode(ghost.encode());
        assertEquals(side.getAsJsonObject("frame").get("bytes").getAsInt(), frame.length);
        assertEquals(side.getAsJsonObject("frame").get("sha256").getAsString(), sha(frame));
        assertEquals(UiMessages.PART_BYTES, side.get("partBytes").getAsInt());
        List<byte[]> parts = UiMessages.split(frame);
        var listed = side.getAsJsonArray("parts");
        assertEquals(listed.size(), parts.size());
        assertTrue(parts.size() > 1);
        for (int i = 0; i < parts.size(); i++) {
            JsonObject p = listed.get(i).getAsJsonObject();
            assertEquals(p.get("bytes").getAsInt(), parts.get(i).length, "part " + i);
            assertEquals(p.get("sha256").getAsString(), sha(parts.get(i)), "part " + i);
        }
    }

    @Test
    void uiMessagesCarryNoIdAndNameTheirPlayers() throws Exception {
        for (String name : List.of("ui-state-full", "ui-flash", "ui-ghost-full", "ui-ghost-clear", "replay-frame-delta", "ui-result-conflict")) {
            Frame f = FrameCodec.decode(Golden.bin(name));
            assertEquals(null, f.id(), name);
            assertTrue(UiMessages.MCP_TYPES.contains(f.type()), name);
            assertTrue(!UiMessages.players(f).isEmpty(), name);
        }
    }

    @Test
    void refusesMalformedHeaders() throws Exception {
        assertThrows(ProtocolException.class, () -> UiMessages.players(edit("ui-state-full", h -> h.add("players", new com.google.gson.JsonArray()))));
        assertThrows(ProtocolException.class, () -> UiMessages.players(edit("ui-flash", h -> h.remove("players"))));
        assertThrows(ProtocolException.class, () -> UiMessages.UiState.decode(edit("ui-state-full", h -> h.remove("tokens"))));
        assertThrows(ProtocolException.class, () -> UiMessages.UiState.decode(edit("ui-state-full", h -> h.getAsJsonArray("jobs").get(0).getAsJsonObject().addProperty("colour", "red"))));
        assertThrows(ProtocolException.class, () -> UiMessages.UiGhost.decode(edit("ui-ghost-full", h -> {
            var s = h.getAsJsonArray("sections");
            JsonElement first = s.remove(0);
            s.add(first);
        })));
        assertThrows(ProtocolException.class, () -> UiMessages.UiResult.decode(edit("ui-result-conflict", h -> h.addProperty("error", "stale"))));
    }

    private interface Edit {
        void apply(JsonObject h);
    }

    private static Frame edit(String name, Edit e) throws Exception {
        Frame f = FrameCodec.decode(Golden.bin(name));
        JsonObject h = f.header().deepCopy();
        e.apply(h);
        return new Frame(h, f.body());
    }
}
