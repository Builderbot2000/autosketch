package dev.autosketch.mod.gametest.client;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * The MCP end of a client test suite (16, *Testing*: "the MCP end"): silo C's fake MCP CLI as a
 * child process, {@code tsx test/support/fake-mcp.ts --pairing <file> --script <file> --record <file>},
 * logging to {@code logs/fake-mcp-<suite>.log} in the game directory. Started once per suite after the
 * integrated server has written its pairing file, with the suite's script
 * ({@code clienttest/<suite>.json}: {@code hello}, {@code send}, {@code replies}, {@code results}, as
 * documented in {@code fake-mcp.ts}), and stopped when the suite ends. Whether the MCP is connected is
 * read from the mod's own bridge and the client's link state, not from here. Without
 * {@code --exit-on-close} the CLI reconnects after the mod drops it, so stopping means destroying it.
 */
public final class FakeMcp implements AutoCloseable {
    private final Process process;
    private final Path record;

    private FakeMcp(Process process, Path record) {
        this.process = process;
        this.record = record;
    }

    /** Starts the CLI with {@code script} (JSON); {@code workDir} receives the script, record and log files. */
    public static FakeMcp start(String suite, String script, Path pairing, Path workDir, Path repo) throws IOException {
        Files.createDirectories(workDir);
        Path cli = repo.resolve("test/support/fake-mcp.ts");
        Path tsx = repo.resolve("node_modules/.bin/tsx");
        if (!Files.isRegularFile(cli)) throw new IOException("no fake MCP at " + cli);
        if (!Files.isExecutable(tsx)) throw new IOException("the fake MCP needs tsx: run npm install in " + repo);
        Path scriptFile = workDir.resolve("fake-mcp-" + suite + ".script.json");
        Path record = workDir.resolve("fake-mcp-" + suite + ".record.jsonl");
        Path log = workDir.resolve("fake-mcp-" + suite + ".log");
        Files.writeString(scriptFile, script);
        Files.deleteIfExists(record);
        Process p = new ProcessBuilder(tsx.toString(), cli.toString(), "--pairing", pairing.toString(), "--script", scriptFile.toString(), "--record", record.toString())
                .directory(repo.toFile())
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(log.toFile()))
                .start();
        return new FakeMcp(p, record);
    }

    /** Every message the fake MCP received from the mod since it started, oldest first (decoded, as JSON). */
    public List<JsonObject> received() {
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

    /** False once the process exited (it should run until {@link #close()}). */
    public boolean alive() {
        return process.isAlive();
    }

    @Override
    public void close() {
        process.destroy();
        try {
            if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly();
        } catch (InterruptedException e) {
            process.destroyForcibly();
            Thread.currentThread().interrupt();
        }
    }
}
