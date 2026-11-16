package dev.autosketch.mod.bridge;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.protocol.ErrorCodes;
import dev.autosketch.mod.protocol.ErrorMessage;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.Messages.McpHello;
import dev.autosketch.mod.protocol.ProtocolException;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.List;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executor;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.atomic.AtomicLong;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * The mod's end of the MCP connection (13, *Connection and handshake*; M10). Listens on
 * {@code 127.0.0.1} only, writes the pairing file, and pairs one MCP at a time: the first frame must
 * be a {@code hello} with this protocol version and the token, within 10 seconds. A newer paired
 * connection replaces the old one ({@code error replaced}). Socket I/O runs on its own threads; the
 * handshake's completion, every inbound message and every listener call are handed to the server
 * thread, so world access never happens off it.
 */
public final class BridgeServer implements Bridge {
    private static final Logger LOG = LogUtils.getLogger();
    private static final byte[] CLOSE = new byte[0];

    /** What the bridge needs from the game, called on the server thread. */
    public interface Host {
        /** The mod's {@code hello}. */
        Messages.ModHello hello();

        /** The current {@code volumes} message. */
        Frame volumes();
    }

    private final Dispatcher dispatcher;
    private final Executor serverThread;
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
    private final Set<Conn> open = ConcurrentHashMap.newKeySet();
    private final AtomicLong serials = new AtomicLong();
    private volatile @Nullable Conn current;
    private volatile long handshakeMillis = 10_000;

    private @Nullable ServerSocket socket;
    private @Nullable Thread acceptThread;
    private @Nullable Path pairingFile;
    private @Nullable Host host;
    private String token = "";

    public BridgeServer(Dispatcher dispatcher, Executor serverThread) {
        this.dispatcher = dispatcher;
        this.serverThread = serverThread;
    }

    public Dispatcher dispatcher() {
        return dispatcher;
    }

    /** For tests: the handshake deadline (13 says 10 seconds). */
    public void setHandshakeMillis(long millis) {
        handshakeMillis = millis;
    }

    // ── lifecycle ─────────────────────────────────────────────────────────────────────────────

    /**
     * Starts listening on {@code 127.0.0.1:port} (0 = any free port) with a fresh token and writes
     * the pairing file into {@code configDir} (null: no file, for tests).
     */
    public synchronized void start(@Nullable Path configDir, int port, Host host) throws IOException {
        if (socket != null) throw new IllegalStateException("bridge already started");
        this.host = host;
        token = PairingFile.newToken();
        ServerSocket ss = new ServerSocket();
        ss.setReuseAddress(true);
        ss.bind(new InetSocketAddress(InetAddress.getByName(PairingFile.HOST), port), 8);
        socket = ss;
        if (configDir != null) pairingFile = PairingFile.write(configDir, ss.getLocalPort(), token);
        Thread t = new Thread(() -> acceptLoop(ss), "Autosketch bridge accept");
        t.setDaemon(true);
        t.start();
        acceptThread = t;
        LOG.info("Autosketch bridge listening on {}:{}", PairingFile.HOST, ss.getLocalPort());
    }

    /** Stops listening, closes every connection and deletes the pairing file. Server thread. */
    public synchronized void stop() {
        ServerSocket ss = socket;
        socket = null;
        if (ss != null) {
            try {
                ss.close();
            } catch (IOException ignored) {
            }
        }
        if (pairingFile != null) PairingFile.delete(pairingFile);
        pairingFile = null;
        Conn c = current;
        current = null;
        for (Conn o : open) o.close();
        if (c != null && c.session != null) {
            dispatcher.discard(c);
            for (Listener l : listeners) l.disconnected(c.session);
        }
    }

    public synchronized int port() {
        return socket == null ? -1 : socket.getLocalPort();
    }

    public synchronized String token() {
        return token;
    }

    public synchronized @Nullable Path pairingFile() {
        return pairingFile;
    }

    // ── Bridge ────────────────────────────────────────────────────────────────────────────────

    @Override
    public boolean connected() {
        return current != null;
    }

    @Override
    public @Nullable BridgeSession session() {
        Conn c = current;
        return c == null ? null : c.session;
    }

    @Override
    public boolean send(Frame frame) {
        Conn c = current;
        if (c == null) return false;
        c.send(frame);
        return true;
    }

    @Override
    public void addListener(Listener listener) {
        listeners.add(listener);
    }

    // ── connections ───────────────────────────────────────────────────────────────────────────

    private void acceptLoop(ServerSocket ss) {
        while (!ss.isClosed()) {
            try {
                Socket s = ss.accept();
                if (!s.getInetAddress().isLoopbackAddress()) {
                    s.close();
                    continue;
                }
                s.setTcpNoDelay(true);
                Conn c = new Conn(s);
                open.add(c);
                c.start();
            } catch (IOException e) {
                if (!ss.isClosed()) LOG.warn("Autosketch bridge accept failed", e);
            }
        }
    }

    /** Server thread: the handshake succeeded; make {@code c} the live connection. */
    private void promote(Conn c) {
        if (c.closed || socket == null) return;
        Host h = host;
        Conn old = current;
        current = c;
        c.send(h.hello().encode());
        c.send(h.volumes());
        if (old != null) {
            old.sendRaw(new ErrorMessage(null, ErrorCodes.REPLACED, "a newer Autosketch connection took over", null).encode());
            old.close();
            dispatcher.discard(old);
            for (Listener l : listeners) l.disconnected(old.session);
        }
        LOG.info("Autosketch MCP paired ({} {})", c.session.clientName(), c.session.clientVersion());
        for (Listener l : listeners) l.connected(c.session);
    }

    /** Server thread: {@code c}'s socket closed. */
    private void closed(Conn c) {
        if (current != c) return;
        current = null;
        dispatcher.discard(c);
        LOG.info("Autosketch MCP disconnected");
        for (Listener l : listeners) l.disconnected(c.session);
    }

    private final class Conn implements Dispatcher.Connection {
        final Socket socket;
        final BlockingQueue<byte[]> out = new LinkedBlockingQueue<>();
        volatile boolean closed;
        volatile boolean paired;
        volatile @Nullable BridgeSession session;

        Conn(Socket socket) {
            this.socket = socket;
        }

        void start() {
            Thread r = new Thread(this::readLoop, "Autosketch bridge reader");
            Thread w = new Thread(this::writeLoop, "Autosketch bridge writer");
            r.setDaemon(true);
            w.setDaemon(true);
            w.start();
            r.start();
            Thread watchdog = new Thread(() -> {
                try {
                    Thread.sleep(handshakeMillis);
                } catch (InterruptedException ignored) {
                }
                if (!paired && !closed) {
                    LOG.info("Autosketch bridge: no hello within {} ms, closing", handshakeMillis);
                    hardClose();
                }
            }, "Autosketch bridge handshake");
            watchdog.setDaemon(true);
            watchdog.start();
        }

        @Override
        public BridgeSession session() {
            return session;
        }

        @Override
        public boolean live() {
            return !closed && current == this;
        }

        @Override
        public void send(Frame frame) {
            if (!closed) out.add(FrameCodec.encode(frame));
        }

        /** Sends even before pairing (handshake errors). */
        void sendRaw(Frame frame) {
            send(frame);
        }

        @Override
        public void close() {
            if (closed) return;
            closed = true;
            out.add(CLOSE);
        }

        void hardClose() {
            closed = true;
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }

        private void fail(ProtocolException e) {
            LOG.info("Autosketch bridge: {} ({})", e.code(), e.getMessage());
            sendRaw(e.toFrame());
            close();
        }

        private void writeLoop() {
            try (OutputStream os = new BufferedOutputStream(socket.getOutputStream(), 64 * 1024)) {
                while (true) {
                    byte[] b = out.take();
                    if (b == CLOSE) break;
                    os.write(b);
                    if (out.isEmpty()) os.flush();
                }
                os.flush();
            } catch (IOException | InterruptedException e) {
                // the reader notices the closed socket
            } finally {
                hardClose();
            }
        }

        private void readLoop() {
            // Not try-with-resources: closing the input stream closes the socket before the writer
            // has flushed a final error frame. The writer closes the socket.
            try {
                DataInputStream in = new DataInputStream(new BufferedInputStream(socket.getInputStream(), 64 * 1024));
                Frame first = FrameCodec.read(in);
                if (first == null) return;
                if (!handshake(first)) return;
                while (!closed) {
                    Frame f = FrameCodec.read(in);
                    if (f == null) break;
                    switch (f.type()) {
                        case "hello" -> LOG.warn("Autosketch bridge: ignoring a second hello");
                        case "error" -> LOG.warn("Autosketch MCP reported an error: {}", f.header());
                        default -> dispatcher.submit(this, f);
                    }
                }
            } catch (ProtocolException e) {
                fail(e);
            } catch (IOException e) {
                // disconnect
            } finally {
                open.remove(this);
                if (!closed) close();
                if (paired) serverThread.execute(() -> closed(this));
            }
        }

        /** Checks the first frame (13, *Connection and handshake*, step 3). True when paired. */
        private boolean handshake(Frame f) throws ProtocolException {
            if (!f.type().equals("hello")) {
                fail(new ProtocolException(ErrorCodes.NOT_READY, null, "the first message must be hello", true));
                return false;
            }
            int protocol = McpHello.readProtocol(f);
            if (protocol != Messages.PROTOCOL_VERSION) {
                LOG.info("Autosketch bridge: MCP speaks protocol {}, the mod {}", protocol, Messages.PROTOCOL_VERSION);
                sendRaw(new ErrorMessage(null, ErrorCodes.PROTOCOL_MISMATCH, "mod speaks protocol " + Messages.PROTOCOL_VERSION + ", MCP sent " + protocol, Messages.PROTOCOL_VERSION).encode());
                close();
                return false;
            }
            Object t = f.header().get("token");
            String given = t instanceof com.google.gson.JsonPrimitive p && p.isString() ? p.getAsString() : "";
            if (!MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), token().getBytes(StandardCharsets.UTF_8))) {
                fail(new ProtocolException(ErrorCodes.BAD_TOKEN, null, "wrong pairing token", true));
                return false;
            }
            McpHello hello = McpHello.decode(f);
            session = new BridgeSession(serials.incrementAndGet(), hello.clientName(), hello.clientVersion(), hello.volatileKeys());
            paired = true;
            serverThread.execute(() -> promote(this));
            return true;
        }
    }
}
