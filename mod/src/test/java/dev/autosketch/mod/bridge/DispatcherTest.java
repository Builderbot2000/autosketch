package dev.autosketch.mod.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.api.Exchange;
import dev.autosketch.mod.protocol.ErrorMessage;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.ProtocolException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;

/** Ordering and completion rules of the message dispatch (13, *Framing*, "Ordering"). */
class DispatcherTest {
    static final class FakeConnection implements Dispatcher.Connection {
        final List<Frame> sent = new ArrayList<>();
        boolean live = true, closed;

        @Override
        public BridgeSession session() {
            return new BridgeSession(1, "autosketch", "1.0.0", new JsonObject());
        }

        @Override
        public boolean live() {
            return live;
        }

        @Override
        public void send(Frame frame) {
            sent.add(frame);
        }

        @Override
        public void close() {
            closed = true;
            live = false;
        }
    }

    static Frame req(String type, long id) {
        JsonObject h = Json.header(type);
        h.addProperty("id", id);
        return new Frame(h);
    }

    @Test
    void deferredRequestHoldsBackLaterOnes() {
        Dispatcher d = new Dispatcher(Runnable::run);
        List<String> log = new ArrayList<>();
        AtomicReference<Exchange> held = new AtomicReference<>();
        d.register("patch", (m, ex) -> {
            log.add("patch " + m.id());
            ex.defer();
            held.set(ex);
        });
        d.register("snapshot", (m, ex) -> {
            log.add("snapshot " + m.id());
            ex.reply(req("snapshot.result", m.id()));
        });
        d.freeze();
        FakeConnection c = new FakeConnection();
        d.submit(c, req("patch", 1));
        d.submit(c, req("snapshot", 2));
        assertEquals(List.of("patch 1"), log);
        assertTrue(d.busy());
        held.get().reply(req("patch.ack", 1));
        assertEquals(List.of("patch 1", "snapshot 2"), log);
        assertEquals(List.of("patch.ack", "snapshot.result"), c.sent.stream().map(Frame::type).toList());
        assertFalse(d.busy());
    }

    @Test
    void handlerReturningWithoutReplyCompletes() {
        Dispatcher d = new Dispatcher(Runnable::run);
        List<String> log = new ArrayList<>();
        d.register("notice", (m, ex) -> log.add("notice"));
        d.freeze();
        FakeConnection c = new FakeConnection();
        d.submit(c, new Frame(Json.header("notice")));
        d.submit(c, new Frame(Json.header("notice")));
        assertEquals(2, log.size());
        assertTrue(c.sent.isEmpty());
    }

    @Test
    void unknownTypeAnsweredOnlyWithAnId() throws Exception {
        Dispatcher d = new Dispatcher(Runnable::run);
        d.freeze();
        FakeConnection c = new FakeConnection();
        d.submit(c, new Frame(Json.header("future.thing")));
        d.submit(c, req("future.request", 9));
        assertEquals(1, c.sent.size());
        ErrorMessage e = ErrorMessage.decode(c.sent.get(0));
        assertEquals("unknown_type", e.code());
        assertEquals(9L, e.id());
    }

    @Test
    void protocolExceptionBecomesErrorById() throws Exception {
        Dispatcher d = new Dispatcher(Runnable::run);
        d.register("hashes", (m, ex) -> {
            throw ProtocolException.refuse("no_volumes", null, "no work volume");
        });
        d.freeze();
        FakeConnection c = new FakeConnection();
        d.submit(c, req("hashes", 4));
        ErrorMessage e = ErrorMessage.decode(c.sent.get(0));
        assertEquals("no_volumes", e.code());
        assertEquals(4L, e.id());
        assertFalse(c.closed);
    }

    @Test
    void discardDropsQueuedButFinishesTheOneInProgress() {
        Dispatcher d = new Dispatcher(Runnable::run);
        List<Long> ran = new ArrayList<>();
        AtomicReference<Exchange> held = new AtomicReference<>();
        d.register("patch", (m, ex) -> {
            ran.add(m.id());
            ex.defer();
            held.set(ex);
        });
        d.freeze();
        FakeConnection old = new FakeConnection();
        d.submit(old, req("patch", 1));
        d.submit(old, req("patch", 2));
        old.live = false;
        d.discard(old);
        FakeConnection fresh = new FakeConnection();
        d.submit(fresh, req("patch", 1));
        assertEquals(List.of(1L), ran); // the fresh request waits for the patch in progress
        held.get().reply(req("patch.ack", 1));
        assertTrue(old.sent.isEmpty(), "the ack on a dead connection is dropped");
        assertEquals(List.of(1L, 1L), ran);
    }

    @Test
    void idLessMessagesBypassADeferredRequest() {
        Dispatcher d = new Dispatcher(Runnable::run);
        List<String> log = new ArrayList<>();
        d.register("patch", (m, ex) -> {
            log.add("patch");
            ex.defer();
        });
        d.register("notice", (m, ex) -> log.add("notice"));
        d.register("hashes", (m, ex) -> log.add("hashes"));
        d.freeze();
        FakeConnection c = new FakeConnection();
        d.submit(c, req("patch", 1));
        d.submit(c, req("hashes", 2));
        d.submit(c, new Frame(Json.header("notice")));
        assertEquals(List.of("patch", "notice"), log, "the notice runs while the patch applies; the request waits");
    }

    @Test
    void handlerCrashIsInternalAndStaysOpen() throws Exception {
        Dispatcher d = new Dispatcher(Runnable::run);
        d.register("snapshot", (m, ex) -> {
            throw new IllegalStateException("boom");
        });
        d.register("notice", (m, ex) -> Json.reqString(m.header(), "text", null));
        d.freeze();
        FakeConnection c = new FakeConnection();
        d.submit(c, req("snapshot", 5));
        ErrorMessage e = ErrorMessage.decode(c.sent.get(0));
        assertEquals("internal", e.code());
        assertEquals(5L, e.id());
        d.submit(c, new Frame(Json.header("notice")));
        ErrorMessage e2 = ErrorMessage.decode(c.sent.get(1));
        assertEquals("bad_request", e2.code());
        assertEquals(null, e2.id());
        assertFalse(c.closed, "an invalid message without an id stays open");
    }

    @Test
    void registrationRules() {
        Dispatcher d = new Dispatcher(Runnable::run);
        d.register("patch", (m, ex) -> {});
        assertThrows(IllegalArgumentException.class, () -> d.register("patch", (m, ex) -> {}));
        assertThrows(IllegalArgumentException.class, () -> d.register("hello", (m, ex) -> {}));
        d.freeze();
        assertThrows(IllegalStateException.class, () -> d.register("chat", (m, ex) -> {}));
    }
}
