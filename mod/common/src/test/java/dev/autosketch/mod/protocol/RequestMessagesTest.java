package dev.autosketch.mod.protocol;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/** Request control and the canvas on the wire (19; 13, *Request control and canvas*): routing, the decoders' checks and the canvas widening rule. */
class RequestMessagesTest {
    private static final String P = "\"player\":{\"name\":\"Kev\",\"uuid\":\"3f2504e0-4f89-41d3-9a0c-0305e82c3301\"}";
    private static final String STATUS = "{\"type\":\"chat\",\"request\":14,\"player\":\"3f2504e0-4f89-41d3-9a0c-0305e82c3301\",\"kind\":\"status\",\"lines\":[\"x\"],"
            + "\"text\":\"t\",\"calls\":1,\"elapsedMs\":5,";

    private static Frame header(String json) {
        return new Frame(Json.parse(json).getAsJsonObject());
    }

    private static void refused(String json) {
        ProtocolException e = assertThrows(ProtocolException.class, () -> RequestMessages.decode(header(json)), json);
        assertEquals("bad_request", e.code());
    }

    @Test
    void routesStatusLinesApartFromOtherChat() throws Exception {
        Frame status = FrameCodec.decode(Golden.bin("chat-status-working"));
        assertTrue(RequestMessages.isStatus(status));
        assertTrue(RequestMessages.handles(status));
        assertEquals("bad_request", assertThrows(ProtocolException.class, () -> Messages.Chat.decode(status)).code());
        Frame reply = FrameCodec.decode(Golden.bin("chat-reply"));
        assertFalse(RequestMessages.isStatus(reply));
        assertFalse(RequestMessages.handles(reply));
        RequestMessages.Status s = (RequestMessages.Status) RequestMessages.decode(status);
        assertEquals("working", s.state());
        assertEquals("request.stop", s.actions().get(0).kind());
        assertEquals(14, s.actions().get(0).args().get("request").getAsInt());
    }

    @Test
    void refusesMalformedStatusLines() {
        refused(STATUS.replace("[\"x\"]", "[\"x\",\"y\"]") + "\"state\":\"working\",\"actions\":[]}");
        refused(STATUS + "\"state\":\"running\",\"actions\":[]}");
        refused(STATUS + "\"state\":\"working\",\"queuePos\":1,\"actions\":[]}");
        refused(STATUS + "\"state\":\"queued\",\"actions\":[]}");
        refused(STATUS + "\"state\":\"working\",\"noTurnSignal\":true,\"actions\":[]}");
        refused(STATUS + "\"state\":\"working\",\"action\":{\"line\":0,\"kind\":\"request.stop\",\"args\":{}},\"actions\":[]}");
        refused(STATUS + "\"state\":\"working\",\"actions\":[{\"label\":\"\",\"kind\":\"request.stop\",\"args\":{}}]}");
        refused(STATUS + "\"state\":\"working\",\"actions\":[{\"label\":\"Stop\",\"kind\":\"request.stop\"}]}");
        refused(STATUS.replace("\"request\":14", "\"request\":null") + "\"state\":\"working\",\"actions\":[]}");
    }

    @Test
    void checksRequestControlPositions() throws Exception {
        refused("{\"type\":\"request.control\"," + P + ",\"action\":\"queue.cancel\"}");
        refused("{\"type\":\"request.control\"," + P + ",\"action\":\"stop\",\"position\":1}");
        refused("{\"type\":\"request.control\"," + P + ",\"action\":\"queue.cancel\",\"position\":0}");
        refused("{\"type\":\"request.control\"," + P + ",\"action\":\"pause\"}");
        var c = (RequestMessages.RequestControl) RequestMessages.decode(FrameCodec.decode(Golden.bin("request-control-queue-cancel")));
        assertEquals("queue.cancel", c.action());
        assertEquals(2, c.position());
    }

    @Test
    void checksCanvasMessages() throws Exception {
        refused("{\"type\":\"canvas\",\"id\":3,\"box\":null}");
        refused("{\"type\":\"canvas\",\"box\":{\"min\":[0,0,0],\"max\":[15,0,15]}}");
        refused("{\"type\":\"canvas\",\"dimension\":\"minecraft:overworld\",\"box\":{\"min\":[16,0,0],\"max\":[15,0,15]}}");
        refused("{\"type\":\"canvas.set\",\"dimension\":\"minecraft:overworld\",\"box\":{\"min\":[0,0,0],\"max\":[15,0,15]}}");
        var none = (RequestMessages.Canvas) RequestMessages.decode(FrameCodec.decode(Golden.bin("canvas-none")));
        assertNull(none.box());
        var confirm = (RequestMessages.Canvas) RequestMessages.decode(FrameCodec.decode(Golden.bin("canvas-confirm")));
        assertEquals(31L, confirm.id());
    }

    @Test
    void widensACanvasToWholeChunkColumnsOverTheBuildHeight() throws Exception {
        var set = (RequestMessages.CanvasSet) RequestMessages.decode(FrameCodec.decode(Golden.bin("canvas-set")));
        var confirm = (RequestMessages.Canvas) RequestMessages.decode(FrameCodec.decode(Golden.bin("canvas-confirm")));
        assertEquals(confirm.box(), RequestMessages.Canvas.widen(set.box(), -64, 319), "the vectors agree with the rule");
        assertEquals(new Box(-16, -64, -32, 15, 319, 47), RequestMessages.Canvas.widen(new Box(-1, 70, -17, 0, 80, 40), -64, 319));
        assertEquals(64, RequestMessages.Canvas.chunksAcross(confirm.box()));
        assertEquals(3, RequestMessages.Canvas.chunksAcross(new Box(-1, 0, 0, 16, 0, 0)));
    }

    @Test
    void readsAQueuedPromptResult() throws Exception {
        var q = Messages.PromptResult.decode(FrameCodec.decode(Golden.bin("prompt-result-queued")));
        assertTrue(q.queued());
        assertFalse(q.delivered());
        assertEquals(14L, q.queuedBehind());
        assertEquals(1, q.position());
        assertNull(q.reason());
        var busy = Messages.PromptResult.decode(FrameCodec.decode(Golden.bin("prompt-result-busy")));
        assertFalse(busy.queued());
        assertEquals("busy", busy.reason());
        assertThrows(ProtocolException.class, () -> Messages.PromptResult.decode(header("{\"type\":\"prompt.result\",\"id\":3,\"delivered\":false,\"queued\":true,\"request\":2,\"position\":0}")));
        assertThrows(ProtocolException.class, () -> Messages.PromptResult.decode(header("{\"type\":\"prompt.result\",\"id\":3,\"delivered\":false,\"queued\":true,\"reason\":\"busy\",\"request\":2,\"position\":1}")));
    }

    @Test
    void namesTheKindsAndErrorsTheFeatureAdds() {
        assertTrue(UiMessages.REQUEST_KINDS.containsAll(RequestMessages.UI_KINDS));
        assertTrue(UiMessages.ERRORS.contains("refused"));
    }
}
