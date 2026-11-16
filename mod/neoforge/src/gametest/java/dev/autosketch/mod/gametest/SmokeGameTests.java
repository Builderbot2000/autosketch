package dev.autosketch.mod.gametest;

import com.google.gson.JsonObject;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.bridge.PairingFile;
import dev.autosketch.mod.discovery.PointerFile;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.Messages;
import java.io.DataInputStream;
import java.net.Socket;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * The per-target smoke test (14, *Tests across versions*; 10, smoke tier): the server started with
 * the mod, the pointer file names this game, and a client playing the MCP pairs through the pairing
 * file. Its own namespace, so {@code runSmokeTestServer} runs it alone on every target while
 * {@code runGameTestServer} runs it with the full suite. Built from the pairing file and a raw
 * {@code hello} header only, so it keeps working across protocol additions. Template
 * {@code autosketch_smoke:empty} is the same synthetic 3×3×3 of air as {@code autosketch:empty}.
 */
@GameTestHolder("autosketch_smoke")
@PrefixGameTestTemplate(false)
public final class SmokeGameTests {
    private SmokeGameTests() {}

    private static final Pattern PORT = Pattern.compile("(?m)^port = (\\d+)$");
    private static final Pattern TOKEN = Pattern.compile("(?m)^token = \"([0-9a-f]+)\"$");

    private static void check(boolean condition, String message) {
        if (!condition) throw new GameTestAssertException(message);
    }

    @GameTest(template = "empty", batch = "autosketch_smoke", timeoutTicks = 200)
    public static void serverStartsAndBridgePairs(GameTestHelper h) throws Exception {
        Path pairing = Platform.get().configDir().resolve(PairingFile.NAME);
        check(Files.isRegularFile(pairing), "pairing file written at server start");
        String text = Files.readString(pairing);
        Matcher port = PORT.matcher(text), token = TOKEN.matcher(text);
        check(port.find() && token.find(), "pairing file has a port and a token");

        String gameDir = PointerFile.gameDirText(h.getLevel().getServer().getServerDirectory());
        Path pointer = PointerFile.gamesDir().resolve(PointerFile.hash(gameDir) + ".toml");
        check(Files.isRegularFile(pointer), "pointer file written at server start: " + pointer);
        check(Files.readString(pointer).contains("gameDir = \"" + gameDir + "\""), "pointer names this game folder");

        Socket socket = new Socket(PairingFile.HOST, Integer.parseInt(port.group(1)));
        ConcurrentLinkedQueue<Frame> frames = new ConcurrentLinkedQueue<>();
        JsonObject hello = Json.header("hello");
        hello.addProperty("protocol", Messages.PROTOCOL_VERSION);
        hello.addProperty("token", token.group(1));
        JsonObject client = new JsonObject();
        client.addProperty("name", "smoke");
        client.addProperty("version", "1.0.0");
        hello.add("client", client);
        hello.add("volatile", new JsonObject());
        socket.getOutputStream().write(FrameCodec.encode(new Frame(hello)));
        Thread reader = new Thread(() -> {
            try (DataInputStream in = new DataInputStream(socket.getInputStream())) {
                Frame f;
                while ((f = FrameCodec.read(in)) != null) frames.add(f);
            } catch (Exception ignored) {
            }
        }, "smoke MCP");
        reader.setDaemon(true);
        reader.start();

        h.startSequence()
                .thenWaitUntil(() -> {
                    check(frames.stream().anyMatch(f -> f.type().equals("hello")), "the mod answers hello: " + frames);
                    check(Autosketch.bridge().connected(), "the bridge reports the MCP connected");
                })
                .thenExecute(() -> {
                    try {
                        socket.close();
                    } catch (Exception ignored) {
                    }
                })
                .thenWaitUntil(() -> check(!Autosketch.bridge().connected(), "disconnect seen"))
                .thenSucceed();
    }
}
