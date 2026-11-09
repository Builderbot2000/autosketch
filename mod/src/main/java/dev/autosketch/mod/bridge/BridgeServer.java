package dev.autosketch.mod.bridge;

import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.protocol.Frame;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.jetbrains.annotations.Nullable;

/**
 * The mod's end of the MCP connection (13, *Connection and handshake*; M10). Skeleton: holds the
 * dispatcher and the listeners, and reports no connection. The localhost socket, pairing file and
 * handshake land in the bridge milestone without changing the {@link Bridge} interface.
 */
public final class BridgeServer implements Bridge {
    private final Dispatcher dispatcher;
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();

    public BridgeServer(Dispatcher dispatcher) {
        this.dispatcher = dispatcher;
    }

    public Dispatcher dispatcher() {
        return dispatcher;
    }

    @Override
    public boolean connected() {
        return false;
    }

    @Override
    public @Nullable BridgeSession session() {
        return null;
    }

    @Override
    public boolean send(Frame frame) {
        return false;
    }

    @Override
    public void addListener(Listener listener) {
        listeners.add(listener);
    }
}
