package dev.autosketch.mod.gametest.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.protocol.Json;
import dev.autosketch.mod.protocol.Messages;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The MCP end of a client test suite (16, *Testing*: "the MCP end"). Started once per suite, after
 * the integrated server has written its pairing file, with the suite's script
 * ({@code clienttest/<suite>.json}), and stopped when the suite ends.
 *
 * <p>Two implementations behind one face. When {@code test/support/fake-mcp.ts} exists (silo C's fake
 * MCP), it runs as a child process: {@code tsx test/support/fake-mcp.ts --pairing <file> --script
 * <file> --record <file>}, logging to {@code logs/fake-mcp-<suite>.log} in the game directory, and
 * {@link #received()} reads its record file. Until then an in-process placeholder does the minimum: reads
 * the pairing file, sends {@code hello} with the script's features and modes, sends the script's
 * header-only {@code send} messages, answers frames by type from {@code replies}, and records every
 * frame it receives in the same shape. The script format is C's (a superset of what the placeholder
 * reads): {@code {"hello":{"features":[…],"modes":[…]},"send":[…],"replies":[{"on":"<type>","send":…}]}}.
 * Whether the MCP is connected is read from the mod's own bridge, not from this class.
 */
public final class FakeMcp implements AutoCloseable {
    private static final Pattern PORT = Pattern.compile("(?m)^port = (\\d+)$");
    private static final Pattern TOKEN = Pattern.compile("(?m)^token = \"([0-9a-f]+)\"$");

    private final Process process;
    private final Path record;
    private final Socket socket;
    private final List<JsonObject> frames = new CopyOnWriteArrayList<>();

    private FakeMcp(Process process, Path record, Socket socket) {
        this.process = process;
        this.record = record;
        this.socket = socket;
    }

    /** True when silo C's TypeScript fake MCP is running, false for the in-process placeholder. */
    public boolean usingCli() {
        return process != null;
    }

    /**
     * Starts the fake MCP for a suite. {@code script} is the suite's JSON; {@code workDir} receives the
     * script file, the record file and the log.
     */
    public static FakeMcp start(String suite, String script, Path pairing, Path workDir, Path repo) throws IOException {
        Files.createDirectories(workDir);
        Path cli = repo.resolve("test/support/fake-mcp.ts");
        if (Files.isRegularFile(cli)) {
            Path tsx = repo.resolve("node_modules/.bin/tsx");
            if (!Files.isExecutable(tsx)) throw new IOException("the fake MCP needs tsx: run npm install in " + repo);
            Path scriptFile = workDir.resolve("fake-mcp-" + suite + ".script.json");
            Path record = workDir.resolve("fake-mcp-" + suite + ".record.jsonl");
            Path log = workDir.resolve("fake-mcp-" + suite + ".log");
            Files.writeString(scriptFile, script);
            Files.deleteIfExists(record);
            Process p = new ProcessBuilder(tsx.toString(), cli.toString(), "--pairing", pairing.toString(), "--script", scriptFile.toString(), "--record", record.toString())
                    .directory(repo.toFile())
                    .redirectErrorStream(true)
                    .redirectOutput(log.toFile())
                    .start();
            return new FakeMcp(p, record, null);
        }
        return placeholder(JsonParser.parseString(script).getAsJsonObject(), pairing);
    }

    /** The in-process placeholder: pairing file, hello, scripted header-only sends and replies, a record. */
    private static FakeMcp placeholder(JsonObject script, Path pairing) throws IOException {
        String text = Files.readString(pairing);
        Matcher port = PORT.matcher(text), token = TOKEN.matcher(text);
        if (!port.find() || !token.find()) throw new IOException("pairing file without port and token: " + pairing);
        JsonObject helloSpec = script.has("hello") ? script.getAsJsonObject("hello") : new JsonObject();
        JsonObject hello = Json.header("hello");
        hello.addProperty("protocol", Messages.PROTOCOL_VERSION);
        hello.addProperty("token", token.group(1));
        JsonObject client = new JsonObject();
        client.addProperty("name", "autosketch-clienttest");
        client.addProperty("version", "0.0.0");
        hello.add("client", client);
        hello.add("volatile", new JsonObject());
        hello.add("modes", helloSpec.has("modes") ? helloSpec.get("modes") : strings("build", "ask", "plan", "scan"));
        hello.add("features", helloSpec.has("features") ? helloSpec.get("features") : strings("prompt.close", "ui"));

        Socket socket = new Socket("127.0.0.1", Integer.parseInt(port.group(1)));
        FakeMcp mcp = new FakeMcp(null, null, socket);
        OutputStream out = socket.getOutputStream();
        Object lock = new Object();
        Thread reader = new Thread(() -> {
            try (DataInputStream in = new DataInputStream(socket.getInputStream())) {
                Frame f;
                boolean handshaken = false;
                while ((f = FrameCodec.read(in)) != null) {
                    mcp.frames.add(f.header());
                    synchronized (lock) {
                        if (!handshaken && f.type().equals("hello")) {
                            handshaken = true;
                            for (JsonObject m : messages(script.get("send"))) FrameCodec.write(out, new Frame(m));
                        }
                        if (script.has("replies")) {
                            for (JsonElement r : script.getAsJsonArray("replies")) {
                                JsonObject reply = r.getAsJsonObject();
                                if (!reply.get("on").getAsString().equals(f.type())) continue;
                                for (JsonObject m : messages(reply.get("send"))) FrameCodec.write(out, new Frame(m));
                            }
                        }
                    }
                }
            } catch (Exception ignored) {
                // Closed by close(), or by the mod.
            }
        }, "client test fake MCP");
        reader.setDaemon(true);
        synchronized (lock) {
            FrameCodec.write(out, new Frame(hello));
        }
        reader.start();
        return mcp;
    }

    private static JsonArray strings(String... values) {
        JsonArray a = new JsonArray();
        for (String v : values) a.add(v);
        return a;
    }

    private static List<JsonObject> messages(JsonElement e) {
        List<JsonObject> out = new ArrayList<>();
        if (e == null || e.isJsonNull()) return out;
        if (e.isJsonArray()) e.getAsJsonArray().forEach(m -> out.add(m.getAsJsonObject().deepCopy()));
        else out.add(e.getAsJsonObject().deepCopy());
        return out;
    }

    /**
     * Every message the fake MCP received from the mod so far, oldest first (the decoded message as JSON;
     * for the placeholder, the frame's header).
     */
    public List<JsonObject> received() {
        if (process == null) return List.copyOf(frames);
        List<JsonObject> out = new ArrayList<>();
        try {
            if (!Files.isRegularFile(record)) return out;
            for (String line : Files.readAllLines(record, StandardCharsets.UTF_8)) {
                if (line.isBlank()) continue;
                try {
                    JsonObject o = JsonParser.parseString(line).getAsJsonObject();
                    out.add(o.has("message") ? o.getAsJsonObject("message") : o);
                } catch (RuntimeException partial) {
                    // The last line may be half written.
                }
            }
        } catch (IOException ignored) {
        }
        return out;
    }

    /** The messages received of one type. */
    public List<JsonObject> received(String type) {
        return received().stream().filter(m -> m.has("type") && m.get("type").getAsString().equals(type)).toList();
    }

    /** False once the child process exited on its own (it should run until {@link #close()}). */
    public boolean alive() {
        return process == null ? !socket.isClosed() : process.isAlive();
    }

    @Override
    public void close() {
        if (process != null) {
            process.destroy();
            try {
                if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly();
            } catch (InterruptedException e) {
                process.destroyForcibly();
                Thread.currentThread().interrupt();
            }
        } else {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
        }
    }
}
