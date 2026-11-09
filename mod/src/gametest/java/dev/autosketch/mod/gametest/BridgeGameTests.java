package dev.autosketch.mod.gametest;

import com.google.gson.JsonObject;
import dev.autosketch.mod.AutosketchMod;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.bridge.BridgeServer;
import dev.autosketch.mod.bridge.PairingFile;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.Messages;
import java.io.DataInputStream;
import java.net.Socket;
import java.nio.file.Files;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.ChunkPos;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * The bridge inside a running server, driven by a socket client playing the MCP (13, *Connection and
 * handshake*; M4, M10): pairing from the pairing file, hello and volumes, {@code volumes} on every
 * work and context change, chunk tickets while linked and released on disconnect.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class BridgeGameTests {
    private BridgeGameTests() {}

    /** A socket client reading frames on its own thread. */
    static final class Mcp {
        final Socket socket;
        final ConcurrentLinkedQueue<Frame> frames = new ConcurrentLinkedQueue<>();
        volatile boolean closed;

        Mcp(int port, String token) throws Exception {
            socket = new Socket("127.0.0.1", port);
            socket.getOutputStream().write(FrameCodec.encode(new Messages.McpHello(1, token, "gametest", "1.0.0", new JsonObject()).encode()));
            Thread t = new Thread(() -> {
                try (DataInputStream in = new DataInputStream(socket.getInputStream())) {
                    Frame f;
                    while ((f = FrameCodec.read(in)) != null) frames.add(f);
                } catch (Exception ignored) {
                }
                closed = true;
            }, "gametest MCP");
            t.setDaemon(true);
            t.start();
        }

        List<Messages.Volumes> volumes() {
            return frames.stream().filter(f -> f.type().equals("volumes")).map(f -> {
                try {
                    return Messages.Volumes.decode(f);
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                }
            }).toList();
        }

        Messages.Volumes lastVolumes() {
            List<Messages.Volumes> v = volumes();
            if (v.isEmpty()) throw new GameTestAssertException("no volumes yet");
            return v.get(v.size() - 1);
        }

        void close() {
            try {
                socket.close();
            } catch (Exception ignored) {
            }
        }
    }

    static void check(boolean condition, String message) {
        if (!condition) throw new GameTestAssertException(message);
    }

    @GameTest(template = "empty", batch = "autosketch_bridge", timeoutTicks = 400)
    public static void pairsAndSendsVolumesOnEveryChange(GameTestHelper h) throws Exception {
        BridgeServer bridge = AutosketchMod.internals().bridge();
        String file = Files.readString(FMLPaths.CONFIGDIR.get().resolve(PairingFile.NAME));
        check(file.contains("port = " + bridge.port() + "\n") && file.contains("token = \"" + bridge.token() + "\""), "pairing file names the port and token");

        Mcp bad = new Mcp(bridge.port(), "f".repeat(64));
        Mcp mcp = new Mcp(bridge.port(), bridge.token());
        ServerPlayer p = VolumeGameTests.op(h);
        BlockPos a = h.absolutePos(new BlockPos(0, 1, 0)), b = h.absolutePos(new BlockPos(2, 2, 2));
        Box work = Box.of(a, b);
        int[] seen = new int[1];
        h.startSequence()
                .thenWaitUntil(() -> {
                    check(bad.closed, "a bad token is refused");
                    check(bad.frames.stream().anyMatch(f -> f.type().equals("error") && "bad_token".equals(f.header().get("code").getAsString())), "with error bad_token");
                    check(Autosketch.bridge().connected(), "the good client pairs");
                    check(mcp.frames.size() >= 2, "hello and volumes arrive");
                })
                .thenExecute(() -> {
                    List<Frame> fs = List.copyOf(mcp.frames);
                    check(fs.get(0).type().equals("hello") && fs.get(1).type().equals("volumes"), "hello, then volumes: " + fs);
                    check(mcp.lastVolumes().work() == null, "no work volume yet");
                    seen[0] = mcp.volumes().size();
                    VolumeGameTests.run(p, "autosketch mode work");
                    VolumeGameTests.run(p, "autosketch pos1 " + VolumeGameTests.xyz(a));
                    VolumeGameTests.run(p, "autosketch pos2 " + VolumeGameTests.xyz(b));
                })
                .thenWaitUntil(() -> check(mcp.volumes().size() == seen[0] + 1 && work.equals(mcp.lastVolumes().work()), "volumes after the work volume"))
                .thenExecute(() -> {
                    check(mcp.lastVolumes().context().equals(List.of(work.grow(3))), "default context");
                    check(AutosketchMod.internals().tickets().held().contains(new ChunkPos(a).toLong()), "a chunk ticket over the volumes while linked");
                    VolumeGameTests.run(p, "autosketch context grow 4");
                })
                .thenWaitUntil(() -> check(mcp.volumes().size() == seen[0] + 2 && mcp.lastVolumes().context().equals(List.of(work.grow(4))), "volumes after context grow"))
                .thenExecute(() -> {
                    VolumeGameTests.run(p, "autosketch mode context");
                    VolumeGameTests.run(p, "autosketch pos1 " + VolumeGameTests.xyz(a.offset(30, 0, 0)));
                    VolumeGameTests.run(p, "autosketch pos2 " + VolumeGameTests.xyz(a.offset(32, 2, 2)));
                    VolumeGameTests.run(p, "autosketch context add");
                })
                .thenWaitUntil(() -> check(mcp.volumes().size() == seen[0] + 3 && mcp.lastVolumes().context().size() == 2, "volumes after context add"))
                .thenExecute(() -> VolumeGameTests.run(p, "autosketch context clear"))
                .thenWaitUntil(() -> check(mcp.volumes().size() == seen[0] + 4 && mcp.lastVolumes().context().equals(List.of(work.grow(3))), "volumes after context clear"))
                .thenExecute(() -> {
                    check(mcp.volumes().stream().skip(seen[0] + 1).allMatch(v -> v.link() == mcp.volumes().get(seen[0]).link()), "context changes keep the link");
                    VolumeGameTests.run(p, "autosketch clear");
                })
                .thenWaitUntil(() -> check(mcp.volumes().size() == seen[0] + 5 && mcp.lastVolumes().work() == null, "volumes after clear"))
                .thenExecute(() -> {
                    check(AutosketchMod.internals().tickets().held().isEmpty(), "tickets released on unlink");
                    VolumeGameTests.run(p, "autosketch pos2 " + VolumeGameTests.xyz(b));
                    VolumeGameTests.run(p, "autosketch mode work");
                    VolumeGameTests.run(p, "autosketch pos1 " + VolumeGameTests.xyz(a));
                    VolumeGameTests.run(p, "autosketch pos2 " + VolumeGameTests.xyz(b));
                    check(!AutosketchMod.internals().tickets().held().isEmpty(), "relinked: tickets held again");
                    mcp.close();
                })
                .thenWaitUntil(() -> check(!Autosketch.bridge().connected(), "the MCP disconnected"))
                .thenExecute(() -> {
                    check(AutosketchMod.internals().tickets().held().isEmpty(), "tickets released on disconnect");
                    check(Autosketch.link().current() != null, "the volumes stay for a reconnecting MCP");
                    AutosketchMod.internals().volumes().clear();
                    h.getLevel().getServer().getPlayerList().remove(p);
                    bad.close();
                })
                .thenSucceed();
    }
}
