package dev.autosketch.mod.bridge;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.api.Exchange;
import dev.autosketch.mod.api.Inbound;
import dev.autosketch.mod.api.MessageHandler;
import dev.autosketch.mod.api.MessageRegistry;
import dev.autosketch.mod.protocol.ErrorCodes;
import dev.autosketch.mod.protocol.ErrorMessage;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.ProtocolException;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.Executor;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * Hands inbound MCP messages to the registered {@link MessageHandler}s on the server thread, one at
 * a time in arrival order, each finishing before the next starts (13, *Wire format*, *Framing*,
 * "Ordering"), with id-less messages allowed to bypass the request queue. The socket thread {@link #submit}s frames; completion of an {@link Exchange} from any
 * thread lets the next one run. When a connection closes, its queued messages are dropped
 * ({@link #discard}) while the one in progress runs to completion with its replies dropped.
 */
public final class Dispatcher implements MessageRegistry {
    private static final Logger LOG = LogUtils.getLogger();

    /** Message types the bridge handles itself, never through a handler. */
    private static final Set<String> RESERVED = Set.of("hello", "error");

    /** One paired connection, as the dispatcher sees it. */
    public interface Connection {
        BridgeSession session();

        /** Whether this is still the live connection. Sends on a dead one are dropped. */
        boolean live();

        void send(Frame frame);

        /** Closes the connection after flushing what was sent. */
        void close();
    }

    private record Pending(Connection connection, Frame frame) {}

    private final Executor serverThread;
    private final Map<String, MessageHandler> handlers = new HashMap<>();
    private volatile boolean frozen;

    private final Object lock = new Object();
    private final Deque<Pending> queue = new ArrayDeque<>();
    private @Nullable ExchangeImpl open;
    private boolean draining;

    /** {@code serverThread} runs tasks on the server thread ({@code MinecraftServer} is one). */
    public Dispatcher(Executor serverThread) {
        this.serverThread = serverThread;
    }

    @Override
    public void register(String type, MessageHandler handler) {
        if (frozen) throw new IllegalStateException("message handlers are registered during AutosketchSetupEvent only");
        if (RESERVED.contains(type)) throw new IllegalArgumentException("\"" + type + "\" is handled by the bridge");
        if (handlers.putIfAbsent(type, handler) != null) throw new IllegalArgumentException("a handler for \"" + type + "\" is already registered");
    }

    /** Ends registration. */
    public void freeze() {
        frozen = true;
    }

    public boolean handles(String type) {
        return handlers.containsKey(type);
    }

    /**
     * Queues a frame from a paired connection. Any thread. Requests (frames with an id) run strictly
     * in arrival order, each after the previous one completes; messages without an id
     * ({@code notice}, {@code chat}, {@code prompt.result}) bypass that queue and run on the server
     * thread as soon as it gets to them, in their own arrival order.
     */
    public void submit(Connection connection, Frame frame) {
        if (frame.id() == null) {
            serverThread.execute(() -> {
                if (connection.live()) run(new Pending(connection, frame), new ExchangeImpl(connection, null, false));
            });
            return;
        }
        synchronized (lock) {
            queue.addLast(new Pending(connection, frame));
        }
        serverThread.execute(this::drain);
    }

    /** Drops the queued messages of a closed connection. The one in progress, if any, still completes. */
    public void discard(Connection connection) {
        synchronized (lock) {
            queue.removeIf(p -> p.connection == connection);
        }
    }

    /** Messages queued and not yet started. */
    public int queued() {
        synchronized (lock) {
            return queue.size();
        }
    }

    /** Whether a handler's exchange is open (deferred). */
    public boolean busy() {
        synchronized (lock) {
            return open != null;
        }
    }

    /** Runs queued messages until one defers or the queue is empty. Server thread. */
    public void drain() {
        synchronized (lock) {
            if (draining) return;
            draining = true;
        }
        try {
            while (true) {
                Pending next;
                ExchangeImpl ex;
                synchronized (lock) {
                    if (open != null || queue.isEmpty()) return;
                    next = queue.pollFirst();
                    ex = new ExchangeImpl(next.connection, next.frame.id(), true);
                    open = ex;
                }
                run(next, ex);
            }
        } finally {
            synchronized (lock) {
                draining = false;
            }
        }
    }

    private void run(Pending p, ExchangeImpl ex) {
        String type = p.frame.type();
        MessageHandler h = handlers.get(type);
        if (h == null) {
            if (ex.id != null) ex.error(ErrorCodes.UNKNOWN_TYPE, "the mod doesn't handle \"" + type + "\" messages");
            else {
                LOG.debug("Ignoring unknown {} message without an id", type);
                ex.complete();
            }
            return;
        }
        try {
            h.handle(new Inbound(p.frame, p.connection.session()), ex);
            if (!ex.deferred) ex.complete();
        } catch (ProtocolException e) {
            // A well-framed message with invalid fields or body is answered and the connection
            // stays open, with or without an id (13, *Framing*); only undecodable framing closes.
            ex.send(e.withId(ex.id).toFrame());
            ex.complete();
        } catch (RuntimeException e) {
            LOG.error("Autosketch handler for {} failed", type, e);
            ex.error(ErrorCodes.INTERNAL, "the mod failed handling " + type + ": " + e);
        }
    }

    private void finished(ExchangeImpl ex) {
        if (!ex.queued) return;
        synchronized (lock) {
            if (open != ex) return;
            open = null;
        }
        serverThread.execute(this::drain);
    }

    private final class ExchangeImpl implements Exchange {
        private final Connection connection;
        private final @Nullable Long id;
        private final boolean queued;
        private volatile boolean deferred;
        private volatile boolean done;

        ExchangeImpl(Connection connection, @Nullable Long id, boolean queued) {
            this.connection = connection;
            this.id = id;
            this.queued = queued;
        }

        @Override
        public @Nullable Long id() {
            return id;
        }

        void send(Frame f) {
            if (!done && connection.live()) connection.send(f);
        }

        @Override
        public void reply(Frame response) {
            send(response);
            complete();
        }

        @Override
        public void error(String code, String message) {
            send(new ErrorMessage(id, code, message, null).encode());
            complete();
        }

        @Override
        public synchronized void complete() {
            if (done) return;
            done = true;
            finished(this);
        }

        @Override
        public void defer() {
            deferred = true;
        }

        @Override
        public boolean live() {
            return connection.live();
        }
    }
}
