package dev.autosketch.mod.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertNull;

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

    /** 17, piece 3: a reply's clickable line, the candidates kinds and the {@code answered} code. */
    @Test
    void candidatesWire() throws Exception {
        Messages.Chat chat = Messages.Chat.decode(FrameCodec.decode(Golden.bin("chat-reply-action")));
        assertEquals(1, chat.action().line());
        assertEquals("candidates.open", chat.action().kind());
        assertEquals("c1", chat.action().args().get("id").getAsString());
        assertEquals(null, Messages.Chat.decode(FrameCodec.decode(Golden.bin("chat-reply"))).action());
        assertThrows(ProtocolException.class, () -> Messages.Chat.decode(edit("chat-reply-action", h -> h.addProperty("kind", "activity"))));
        assertThrows(ProtocolException.class, () -> Messages.Chat.decode(edit("chat-reply-action", h -> h.getAsJsonObject("action").addProperty("line", 2))));
        assertThrows(ProtocolException.class, () -> Messages.Chat.decode(edit("chat-reply-action", h -> h.getAsJsonObject("action").addProperty("line", -1))));
        assertThrows(ProtocolException.class, () -> Messages.Chat.decode(edit("chat-reply-action", h -> h.getAsJsonObject("action").add("args", new com.google.gson.JsonArray()))));
        for (String k : List.of("candidates.open", "candidates.ghost", "candidates.ghost.clear", "candidates.submit")) assertTrue(UiMessages.REQUEST_KINDS.contains(k), k);
        UiMessages.UiResult answered = UiMessages.UiResult.decode(FrameCodec.decode(Golden.bin("ui-result-answered")));
        assertEquals("answered", answered.error());
        UiMessages.UiResult ghost = UiMessages.UiResult.decode(FrameCodec.decode(Golden.bin("ui-result-candidates-ghost")));
        assertEquals(UiMessages.CANDIDATE_GHOST, ghost.result().get("ghost").getAsString());
    }

    /** 17, pieces 6 and 8: the editor write kinds with their hash, and the save flash. */
    @Test
    void editorWritesAndSaveFlash() throws Exception {
        for (String k : UiMessages.LIBRARY_WRITE_KINDS) assertTrue(UiMessages.REQUEST_KINDS.contains(k), k);
        for (String n : List.of("prefab", "prefab-new", "palette", "procedure", "knowledge")) {
            UiMessages.UiRequest r = UiMessages.UiRequest.decode(FrameCodec.decode(Golden.bin("ui-request-library-write-" + n)));
            assertTrue(UiMessages.LIBRARY_WRITE_KINDS.contains(r.kind()), r.kind());
            assertTrue(r.args().get("hash").getAsString().length() > 0, n);
        }
        UiMessages.UiResult ok = UiMessages.UiResult.decode(FrameCodec.decode(Golden.bin("ui-result-library-write")));
        assertEquals(64, ok.result().get("hash").getAsString().length());
        assertEquals("conflict", UiMessages.UiResult.decode(FrameCodec.decode(Golden.bin("ui-result-library-write-conflict"))).error());
        UiMessages.UiFlash f = UiMessages.UiFlash.decode(FrameCodec.decode(Golden.bin("ui-flash-save")));
        assertEquals(UiMessages.SAVE_FLASH_JOB, f.flashes().get(0).job());
        assertEquals(UiMessages.SAVE_FLASH_COLOUR, f.flashes().get(0).colour());
    }

    /** 18, pieces 7 and 8: the choice kind, the steady fill record and proposed hits' flashes. */
    @Test
    void choicesAndFills() throws Exception {
        assertTrue(UiMessages.REQUEST_KINDS.contains("choices.pick"));
        Messages.Chat chat = Messages.Chat.decode(FrameCodec.decode(Golden.bin("chat-reply-choice")));
        assertEquals("choices.pick", chat.action().kind());
        assertEquals(0, chat.action().args().get("index").getAsInt());
        UiMessages.UiRequest pick = UiMessages.UiRequest.decode(FrameCodec.decode(Golden.bin("ui-request-choices-pick")));
        assertEquals("q1", pick.args().get("id").getAsString());
        assertEquals("answered", UiMessages.UiResult.decode(FrameCodec.decode(Golden.bin("ui-result-choices-answered"))).error());

        // Folding (feature choices.fold): the question tag on a choice line and on the closing line, and choices.answered.
        assertNull(chat.question());
        Messages.Chat tagged = Messages.Chat.decode(FrameCodec.decode(Golden.bin("chat-reply-choice-question")));
        assertEquals("q1", tagged.question());
        assertEquals(1, tagged.action().args().get("index").getAsInt());
        Messages.Chat end = Messages.Chat.decode(FrameCodec.decode(Golden.bin("chat-reply-choices-end")));
        assertEquals("q1", end.question());
        assertNull(end.action());
        Messages.ChoicesAnswered answered = Messages.ChoicesAnswered.decode(FrameCodec.decode(Golden.bin("choices-answered")));
        assertEquals(new Messages.ChoicesAnswered("q1", 1), answered);
        assertEquals(Golden.json("choices-answered").getAsJsonObject("header"), answered.encode().header());
        assertEquals(Golden.json("chat-reply-choice-question").getAsJsonObject("header"), tagged.encode().header());

        UiMessages.UiState s = UiMessages.UiState.decode(FrameCodec.decode(Golden.bin("ui-state-fill")));
        UiMessages.Fill f = s.fills().get(0);
        assertEquals(UiMessages.CANDIDATE_FILL, f.id());
        assertEquals(64, f.alpha());
        assertEquals(0xe84de0, f.colour());
        assertEquals(6, f.faces().size());
        assertEquals(12, f.edges().size());
        assertEquals(List.of(-230, -220), List.of(f.edges().get(8)[2], f.edges().get(8)[5]));
        assertEquals(List.of("candidate"), UiMessages.UiState.decode(FrameCodec.decode(Golden.bin("ui-state-fill-removed"))).fillsRemoved());
        assertTrue(UiMessages.UiState.decode(FrameCodec.decode(Golden.bin("ui-state-full"))).fills().isEmpty());
        assertEquals(UiMessages.CANDIDATE_FILL, UiMessages.UiFlash.decode(FrameCodec.decode(Golden.bin("ui-flash-hits"))).flashes().get(0).job());

        Edit[] bad = {
            h -> fill(h).addProperty("alpha", 0),
            h -> fill(h).addProperty("alpha", 256),
            h -> fill(h).getAsJsonArray("faces").set(0, Json.parse("[128,64,-240,129,80,-208]")),
            h -> fill(h).getAsJsonArray("faces").set(0, Json.parse("[128,64,-240,128,64,-208]")),
            h -> fill(h).getAsJsonArray("edges").set(0, Json.parse("[140,64,-230,152,65,-230]")),
            h -> fill(h).getAsJsonArray("edges").set(0, Json.parse("[152,64,-230,140,64,-230]")),
            h -> fill(h).getAsJsonArray("edges").set(0, Json.parse("[140,64,-230,152,64]")),
            h -> fill(h).remove("edges"),
        };
        for (Edit e : bad) assertThrows(ProtocolException.class, () -> UiMessages.UiState.decode(edit("ui-state-fill", e)));
        assertThrows(ProtocolException.class, () -> UiMessages.UiState.decode(edit("ui-state-full-fill", h -> h.add("fillsRemoved", Json.parse("[\"candidate\"]")))));
    }

    private static JsonObject fill(JsonObject h) {
        return h.getAsJsonArray("fills").get(0).getAsJsonObject();
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
