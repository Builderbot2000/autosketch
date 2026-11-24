package dev.autosketch.mod.feedback;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.ui.relay.UiPayload;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The volume outlines the server half sends its client half (13, *Relay to the client*, op 4; 18, piece 8). */
class VolumeOutlinesTest {
    @Test
    void writesTheSpecifiedJsonAndReadsItBack() throws Exception {
        VolumeOutlines o = new VolumeOutlines("minecraft:overworld", List.of(
                new VolumeOutlines.Entry(0x33e05a, List.of(new Box(0, -60, 0, 15, -53, 15))),
                new VolumeOutlines.Entry(0x3a8dff, List.of(new Box(-4, -64, -4, 19, -49, 19), new Box(30, -60, 0, 31, -60, 1)))));
        String json = o.toJson();
        assertEquals("{\"dimension\":\"minecraft:overworld\",\"outlines\":["
                + "{\"colour\":\"#33e05a\",\"boxes\":[{\"min\":[0,-60,0],\"max\":[15,-53,15]}]},"
                + "{\"colour\":\"#3a8dff\",\"boxes\":[{\"min\":[-4,-64,-4],\"max\":[19,-49,19]},{\"min\":[30,-60,0],\"max\":[31,-60,1]}]}]}", json);
        assertEquals(o, VolumeOutlines.parse(json));
        assertFalse(o.isEmpty());
    }

    @Test
    void anEmptyListHidesThem() throws Exception {
        VolumeOutlines none = VolumeOutlines.none("minecraft:the_nether");
        assertEquals("{\"dimension\":\"minecraft:the_nether\",\"outlines\":[]}", none.toJson());
        assertTrue(VolumeOutlines.parse(none.toJson()).isEmpty());
        assertTrue(new VolumeOutlines("minecraft:overworld", List.of(new VolumeOutlines.Entry(0x33e05a, List.of()))).isEmpty());
    }

    @Test
    void malformedOutlinesAreRefused() {
        assertThrows(ProtocolException.class, () -> VolumeOutlines.parse("not json {"));
        assertThrows(ProtocolException.class, () -> VolumeOutlines.parse("[]"));
        assertThrows(ProtocolException.class, () -> VolumeOutlines.parse("{\"dimension\":\"d\"}"));
        assertThrows(ProtocolException.class, () -> VolumeOutlines.parse("{\"dimension\":\"d\",\"outlines\":[{\"colour\":\"red\",\"boxes\":[]}]}"));
        assertThrows(ProtocolException.class, () -> VolumeOutlines.parse("{\"dimension\":\"d\",\"outlines\":[{\"colour\":\"#ffffff\",\"boxes\":[{\"min\":[1,1,1],\"max\":[0,0,0]}]}]}"));
    }

    @Test
    void travelsAsRelayOpFour() {
        UiPayload p = UiPayload.outlines("{\"dimension\":\"d\",\"outlines\":[]}");
        assertEquals(4, p.op());
        assertEquals("{\"dimension\":\"d\",\"outlines\":[]}", p.text());
    }
}
