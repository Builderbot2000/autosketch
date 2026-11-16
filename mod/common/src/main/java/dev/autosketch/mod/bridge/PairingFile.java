package dev.autosketch.mod.bridge;

import dev.autosketch.mod.protocol.Messages;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;

/**
 * {@code <instance>/config/autosketch-bridge.toml} (13, *Wire format*, *Pairing file*): written
 * atomically (temporary file, then rename) when the server starts, deleted when it stops. A strict
 * TOML subset: integers and double-quoted strings without escapes.
 */
public final class PairingFile {
    private PairingFile() {}

    public static final String NAME = "autosketch-bridge.toml";
    public static final String HOST = "127.0.0.1";

    /** 32 bytes from {@link SecureRandom} as 64 lowercase hex digits. */
    public static String newToken() {
        byte[] b = new byte[32];
        new SecureRandom().nextBytes(b);
        return HexFormat.of().formatHex(b);
    }

    public static String render(int port, String token, long pid, Instant started) {
        return "# Autosketch bridge pairing file. Written by the mod when the server starts, deleted when it stops.\n"
                + "# Do not edit. The token lets a local Autosketch MCP server connect to this game.\n"
                + "protocol = " + Messages.PROTOCOL_VERSION + "\n"
                + "host = \"" + HOST + "\"\n"
                + "port = " + port + "\n"
                + "token = \"" + token + "\"\n"
                + "pid = " + pid + "\n"
                + "started = \"" + started.truncatedTo(ChronoUnit.SECONDS) + "\"\n";
    }

    /** Writes the file into {@code configDir} atomically and returns its path. */
    public static Path write(Path configDir, int port, String token) throws IOException {
        Files.createDirectories(configDir);
        Path target = configDir.resolve(NAME);
        Path tmp = configDir.resolve(NAME + ".tmp");
        Files.writeString(tmp, render(port, token, ProcessHandle.current().pid(), Instant.now()), StandardCharsets.UTF_8);
        try {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
        }
        return target;
    }

    public static void delete(Path file) {
        try {
            Files.deleteIfExists(file);
        } catch (IOException ignored) {
            // Best effort: a stale file names a closed port, which the MCP reports as unreachable.
        }
    }
}
