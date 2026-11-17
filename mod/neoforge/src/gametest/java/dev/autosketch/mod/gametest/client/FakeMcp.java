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

    /** {@code setsid} where the system has it (Linux, where the harness runs); null elsewhere. */
    private static final Path SETSID = java.util.stream.Stream.of("/usr/bin/setsid", "/bin/setsid").map(Path::of).filter(Files::isExecutable).findFirst().orElse(null);

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
        List<String> command = new ArrayList<>();
        // Its own process group (setsid execs in place: the group id is the pid), so close() can
        // stop every process tsx started, even one already orphaned.
        if (SETSID != null) command.add(SETSID.toString());
        command.addAll(List.of(tsx.toString(), cli.toString(), "--pairing", pairing.toString(), "--script", scriptFile.toString(), "--record", record.toString()));
        Process p = new ProcessBuilder(command)
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
        // tsx runs the script in a child node process that can outlive tsx itself; an orphan keeps
        // reconnecting (the CLI reconnects by design) and fights the next test's fake MCP, each
        // replacing the other every half second (seen in CI: a fake MCP closed right after it
        // started, while tsx was spawning its child). So stop the whole process group when the CLI
        // runs in its own (setsid), and in any case keep collecting tsx's children until it has
        // exited, then force whatever is left.
        java.util.Set<ProcessHandle> seen = new java.util.HashSet<>(process.descendants().toList());
        signalGroup("-TERM");
        seen.forEach(ProcessHandle::destroy);
        process.destroy();
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        try {
            while (process.isAlive() && System.nanoTime() < end) {
                process.descendants().forEach(h -> {
                    if (seen.add(h)) h.destroy();
                });
                process.waitFor(10, TimeUnit.MILLISECONDS);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        if (process.isAlive()) {
            process.descendants().forEach(seen::add);
            process.destroyForcibly();
        }
        seen.forEach(ProcessHandle::destroyForcibly);
        signalGroup("-KILL");
    }

    /** Sends a signal to the CLI's process group (only when it was started with setsid). */
    private void signalGroup(String signal) {
        if (SETSID == null) return;
        try {
            new ProcessBuilder("kill", signal, "--", "-" + process.pid()).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start().waitFor(2, TimeUnit.SECONDS);
        } catch (IOException e) {
            // no kill(1): the descendant handling above still runs
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
