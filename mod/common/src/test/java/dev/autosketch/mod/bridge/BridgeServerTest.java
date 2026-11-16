package dev.autosketch.mod.bridge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.protocol.ErrorMessage;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.Messages;
import java.io.DataInputStream;
import java.io.IOException;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The localhost bridge (13, *Connection and handshake*, *Pairing file*; M10), over real sockets. */
class BridgeServerTest {
    @TempDir
    Path config;

    ExecutorService serverThread;
    BridgeServer bridge;
    final List<String> events = new CopyOnWriteArrayList<>();

    @BeforeEach
    void start() throws IOException {
        serverThread = Executors.newSingleThreadExecutor();
        Dispatcher d = new Dispatcher(serverThread);
        d.register("notice", (m, ex) -> events.add("notice " + m.header().get("text").getAsString()));
        d.register("hashes", (m, ex) -> ex.reply(new Messages.HashesResult(m.id(), List.of()).encode()));
        d.freeze();
        bridge = new BridgeServer(d, serverThread);
        bridge.addListener(new Bridge.Listener() {
            @Override
            public void connected(BridgeSession s) {
                events.add("connected " + s.serial());
            }

            @Override
            public void disconnected(BridgeSession s) {
                events.add("disconnected " + s.serial());
            }
        });
        bridge.start(config, 0, new BridgeServer.Host() {
            @Override
            public Messages.ModHello hello() {
                return new Messages.ModHello("0.1.0", "1.21.1", 3955, "neoforge", "21.1.249", false, null);
            }

            @Override
            public Frame volumes() {
                return Messages.Volumes.none(7).encode();
            }
        });
    }

    @AfterEach
    void stop() throws Exception {
        serverThread.submit(bridge::stop).get();
        serverThread.shutdownNow();
    }

    /** The MCP's side: a socket and a frame reader. */
    final class Client implements AutoCloseable {
        final Socket s = new Socket("127.0.0.1", bridge.port());
        final DataInputStream in = new DataInputStream(s.getInputStream());

        Client() throws IOException {
            s.setSoTimeout(5000);
        }

        void send(Frame f) throws IOException {
            s.getOutputStream().write(FrameCodec.encode(f));
        }

        Frame read() throws Exception {
            return FrameCodec.read(in);
        }

        Client hello(String token, int protocol) throws IOException {
            send(new Messages.McpHello(protocol, token, "autosketch", "1.0.0", new JsonObject()).encode());
            return this;
        }

        Client paired() throws Exception {
            hello(bridge.token(), 1);
            assertEquals("hello", read().type());
            assertEquals("volumes", read().type());
            return this;
        }

        /** True when the mod closed the connection. */
        boolean closedByPeer() throws Exception {
            return in.read() < 0;
        }

        @Override
        public void close() throws IOException {
            s.close();
        }
    }

    private void await(String event) throws InterruptedException {
        for (int i = 0; i < 200 && !events.contains(event); i++) Thread.sleep(10);
        assertTrue(events.contains(event), "expected " + event + " in " + events);
    }

    @Test
    void pairingFileNamesPortAndToken() throws IOException {
        String text = Files.readString(config.resolve("autosketch-bridge.toml"), StandardCharsets.UTF_8);
        assertTrue(text.contains("protocol = 1\n"));
        assertTrue(text.contains("host = \"127.0.0.1\"\n"));
        assertTrue(text.contains("port = " + bridge.port() + "\n"));
        assertTrue(text.contains("token = \"" + bridge.token() + "\"\n"));
        assertTrue(bridge.token().matches("[0-9a-f]{64}"));
        assertFalse(Files.exists(config.resolve("autosketch-bridge.toml.tmp")));
    }

    @Test
    void pairsThenSendsHelloAndVolumes() throws Exception {
        try (Client c = new Client()) {
            c.hello(bridge.token(), 1);
            Messages.ModHello h = Messages.ModHello.decode(c.read());
            assertEquals("21.1.249", h.loaderVersion());
            Messages.Volumes v = Messages.Volumes.decode(c.read());
            assertEquals(7, v.link());
            assertNull(v.work());
            await("connected 1");
            assertTrue(bridge.connected());
            c.send(noticeFrame("hi"));
            await("notice hi");
        }
        await("disconnected 1");
        assertFalse(bridge.connected());
    }

    private static Frame noticeFrame(String text) {
        return new Messages.Notice(text, null).encode();
    }

    @Test
    void refusesABadToken() throws Exception {
        try (Client c = new Client()) {
            c.hello("0".repeat(64), 1);
            ErrorMessage e = ErrorMessage.decode(c.read());
            assertEquals("bad_token", e.code());
            assertTrue(c.closedByPeer());
        }
        assertFalse(bridge.connected());
    }

    @Test
    void reportsAProtocolMismatchWithItsVersion() throws Exception {
        try (Client c = new Client()) {
            c.hello(bridge.token(), 2);
            ErrorMessage e = ErrorMessage.decode(c.read());
            assertEquals("protocol_mismatch", e.code());
            assertEquals(1, e.protocol());
            assertTrue(c.closedByPeer());
        }
    }

    @Test
    void notReadyWhenTheFirstFrameIsNotHello() throws Exception {
        try (Client c = new Client()) {
            c.send(noticeFrame("too early"));
            assertEquals("not_ready", ErrorMessage.decode(c.read()).code());
            assertTrue(c.closedByPeer());
        }
    }

    @Test
    void malformedFrameIsBadRequestAndCloses() throws Exception {
        try (Client c = new Client()) {
            c.paired();
            c.s.getOutputStream().write(new byte[] {0, 0, 0, 2, 0, 0});
            ErrorMessage e = ErrorMessage.decode(c.read());
            assertEquals("bad_request", e.code());
            assertNull(e.id());
            assertTrue(c.closedByPeer());
        }
    }

    @Test
    void closesWithoutHelloAfterTheDeadline() throws Exception {
        bridge.setHandshakeMillis(200);
        try (Client c = new Client()) {
            assertTrue(c.closedByPeer());
        }
    }

    @Test
    void aNewConnectionReplacesTheOld() throws Exception {
        try (Client a = new Client().paired()) {
            await("connected 1");
            try (Client b = new Client().paired()) {
                ErrorMessage e = ErrorMessage.decode(a.read());
                assertEquals("replaced", e.code());
                assertTrue(a.closedByPeer());
                await("disconnected 1");
                await("connected 2");
                // the new connection serves requests
                JsonObject h = Json.header("hashes");
                h.addProperty("id", 1);
                h.addProperty("dimension", "minecraft:overworld");
                h.add("boxes", Json.parse("[{\"min\":[0,0,0],\"max\":[1,1,1]}]"));
                b.send(new Frame(h));
                assertEquals("hashes.result", b.read().type());
            }
        }
    }

    @Test
    void survivesTheMcpReconnecting() throws Exception {
        try (Client a = new Client().paired()) {
            await("connected 1");
        }
        await("disconnected 1");
        try (Client b = new Client().paired()) {
            await("connected 2");
            assertTrue(bridge.connected());
            assertTrue(bridge.send(noticeFrame("unsolicited")));
            assertEquals("notice", b.read().type());
        }
    }

    @Test
    void stopDeletesThePairingFile() throws Exception {
        serverThread.submit(bridge::stop).get(5, TimeUnit.SECONDS);
        assertFalse(Files.exists(config.resolve("autosketch-bridge.toml")));
    }
}
