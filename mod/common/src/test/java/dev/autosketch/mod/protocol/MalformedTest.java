package dev.autosketch.mod.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayInputStream;
import java.util.Arrays;
import org.junit.jupiter.api.Test;

/** Decoder checks (13, *Framing*, *Primitives*, *Binary bodies*): every violation is bad_request. */
class MalformedTest {
    private static byte[] frame(String header, byte[] body) {
        byte[] h = header.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        ByteWriter w = new ByteWriter();
        w.u32(4 + h.length + body.length);
        w.u32(h.length);
        w.bytes(h);
        w.bytes(body);
        return w.toByteArray();
    }

    private static ProtocolException fails(byte[] bytes) {
        return assertThrows(ProtocolException.class, () -> FrameCodec.decode(bytes));
    }

    @Test
    void framing() {
        assertEquals("bad_request", fails(new byte[] {0, 0, 0, 3, 0, 0, 0, 0}).code());
        assertTrue(fails(new byte[] {0x10, 0, 0, 1, 0, 0, 0, 0}).closes()); // beyond 256 MiB
        fails(frame("[1,2]", new byte[0]));
        fails(frame("{\"type\":\"notice\"", new byte[0]));
        fails(frame("{\"type\":\"notice\",\"text\":\"x\",\"player\":null}", new byte[] {1}));
        fails(frame("{\"type\":\"dirty\",\"everything\":true}", new byte[] {0}));
    }

    @Test
    void cleanEndOfStreamBetweenFrames() throws Exception {
        assertEquals(null, FrameCodec.read(new ByteArrayInputStream(new byte[0])));
    }

    @Test
    void varints() throws Exception {
        assertThrows(ProtocolException.class, () -> new ByteReader(new byte[] {(byte) 0x80, 0x00}).varint());
        assertThrows(ProtocolException.class, () -> new ByteReader(new byte[] {(byte) 0x80}).varint());
        byte[] nine = new byte[9];
        Arrays.fill(nine, (byte) 0xff);
        assertThrows(ProtocolException.class, () -> new ByteReader(nine).varint());
        ByteWriter w = new ByteWriter();
        w.varint(ByteWriter.MAX_VARINT);
        assertEquals(8, w.length());
        assertEquals(ByteWriter.MAX_VARINT, new ByteReader(w.toByteArray()).varint());
        assertThrows(IllegalArgumentException.class, () -> new ByteWriter().varint(ByteWriter.MAX_VARINT + 1));
    }

    @Test
    void bodyChecks() throws Exception {
        Frame good = FrameCodec.decode(Golden.bin("patch-one"));
        byte[] extra = Arrays.copyOf(good.body(), good.body().length + 1);
        assertThrows(ProtocolException.class, () -> Messages.Patch.decode(new Frame(good.header(), extra)));
        byte[] badIndex = good.body().clone();
        badIndex[badIndex.length - 3] = 5; // new state = palette[5] of 2
        assertThrows(ProtocolException.class, () -> Messages.Patch.decode(new Frame(good.header(), badIndex)));
        com.google.gson.JsonObject h = good.header().deepCopy();
        h.addProperty("count", 2);
        assertThrows(ProtocolException.class, () -> Messages.Patch.decode(new Frame(h, good.body())));
    }

    @Test
    void unnormalisedBoxIsBadRequestById() {
        com.google.gson.JsonObject h = Json.header("hashes");
        h.addProperty("id", 3);
        h.addProperty("dimension", "minecraft:overworld");
        h.add("boxes", Json.parse("[{\"min\":[1,0,0],\"max\":[0,0,0]}]"));
        ProtocolException e = assertThrows(ProtocolException.class, () -> Messages.HashesRequest.decode(new Frame(h)));
        assertEquals(3L, e.id());
        assertEquals(false, e.closes());
    }
}
