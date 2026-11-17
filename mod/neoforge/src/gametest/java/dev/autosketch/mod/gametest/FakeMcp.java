package dev.autosketch.mod.gametest;

import com.google.gson.JsonObject;
import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.bridge.BridgeServer;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.Messages;
import java.io.DataInputStream;
import java.io.IOException;
import java.net.Socket;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.gametest.framework.GameTestSequence;

/**
 * An in-process stand-in for the MCP in GameTests (briefs/ui/L, deliverable 1; 16, *Mod side*:
 * the whole mod is locked while the MCP is offline). It pairs with the running server's real bridge
 * over a socket, from the bridge's own port and token, says hello with the chosen MCP features, and
 * records every frame the mod sends. Tests that mark volumes or use the wand connect one first, so
 * they run with the link {@code connected} (or, with features lacking {@code ui}, {@code too_old}).
 *
 * <p>Use {@link #run} for a test body that runs within one tick, or {@link #start} and
 * {@link #finish} around a longer sequence. {@code finish} closes the connection and waits for the
 * mod to see it go, so the next batch starts with no MCP connected.
 */
public final class FakeMcp {
    /** Every MCP feature this build's fake lists by default: today's {@code prompt.close} and {@code 16}'s {@code ui}. */
    public static final List<String> ALL_FEATURES = List.of(Messages.MCP_FEATURE_PROMPT_CLOSE, "ui");

    private static final AtomicInteger SERIAL = new AtomicInteger();

    public final String name;
    public final List<String> features;
    public final ConcurrentLinkedQueue<Frame> frames = new ConcurrentLinkedQueue<>();
    private final Socket socket;
    private volatile boolean closed;

    private FakeMcp(List<String> features) throws IOException {
        this.name = "fake-mcp-" + SERIAL.incrementAndGet();
        this.features = List.copyOf(features);
        BridgeServer bridge = AutosketchMod.internals().bridge();
        socket = new Socket("127.0.0.1", bridge.port());
        Messages.McpHello hello = new Messages.McpHello(Messages.PROTOCOL_VERSION, bridge.token(), name, "1.0.0", new JsonObject(),
                List.of("ask", "scan", "plan", "build"), this.features);
        socket.getOutputStream().write(FrameCodec.encode(hello.encode()));
        Thread t = new Thread(() -> {
            try (DataInputStream in = new DataInputStream(socket.getInputStream())) {
                Frame f;
                while ((f = FrameCodec.read(in)) != null) frames.add(f);
            } catch (Exception ignored) {
            }
            closed = true;
        }, name);
        t.setDaemon(true);
        t.start();
    }

    /** Connects a fake MCP listing {@link #ALL_FEATURES}. */
    public static FakeMcp open() {
        return open(ALL_FEATURES);
    }

    /** Connects a fake MCP whose hello lists these features. */
    public static FakeMcp open(List<String> features) {
        try {
            return new FakeMcp(features);
        } catch (IOException e) {
            throw new GameTestAssertException("fake MCP couldn't connect to the bridge: " + e);
        }
    }

    /** Whether the mod has paired this connection (it is the bridge's current session). */
    public boolean paired() {
        BridgeSession s = Autosketch.bridge().session();
        return !closed && s != null && s.clientName().equals(name);
    }

    public boolean closed() {
        return closed;
    }

    /** Sends one frame to the mod, as the MCP would (silo C: the relay's GameTests send {@code ui} messages). */
    public void send(Frame frame) {
        try {
            synchronized (socket) {
                socket.getOutputStream().write(FrameCodec.encode(frame));
            }
        } catch (IOException e) {
            throw new GameTestAssertException("fake MCP couldn't send " + frame.type() + ": " + e);
        }
    }

    /** The frames of one type received so far. */
    public List<Frame> received(String type) {
        return frames.stream().filter(f -> f.type().equals(type)).toList();
    }

    public void close() {
        try {
            socket.close();
        } catch (IOException ignored) {
        }
    }

    /** A sequence that first waits until this MCP is paired. */
    public GameTestSequence start(GameTestHelper h) {
        return h.startSequence().thenWaitUntil(() -> {
            if (!paired()) throw new GameTestAssertException("waiting for the fake MCP to pair");
        });
    }

    /** Ends {@code seq}: closes the connection, waits until the mod sees no MCP, and succeeds. */
    public void finish(GameTestSequence seq) {
        seq.thenExecute(this::close)
                .thenWaitUntil(() -> {
                    if (Autosketch.bridge().connected()) throw new GameTestAssertException("waiting for the fake MCP to disconnect");
                })
                .thenSucceed();
    }

    /** Runs {@code body} once a fake MCP listing {@link #ALL_FEATURES} is paired, then disconnects and succeeds. */
    public static void run(GameTestHelper h, Runnable body) {
        FakeMcp mcp = open();
        mcp.finish(mcp.start(h).thenExecute(body));
    }
}
