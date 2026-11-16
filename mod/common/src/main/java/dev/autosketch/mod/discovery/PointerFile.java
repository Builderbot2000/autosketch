package dev.autosketch.mod.discovery;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.bridge.PairingFile;
import dev.autosketch.mod.config.ConfigToml;
import dev.autosketch.mod.platform.Platform;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import net.minecraft.SharedConstants;
import net.minecraft.server.MinecraftServer;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * The pointer file (14, *Instance discovery*, *Pointer file format*): on server start the mod writes
 * {@code <user.home>/.autosketch/games/<hash of the game folder>.toml} naming the game folder, the
 * Minecraft version, the loader and the pairing file, so a local Autosketch MCP finds this game
 * without searching the user's files. Stale pointers (their game folder is gone) are deleted at the
 * same time. Config {@code discovery.pointer} (default on) turns it off, which also removes this
 * game's old file. The MCP side and reference is {@code src/assets/discover/pointer.ts}.
 *
 * <p>{@code AUTOSKETCH_HOME} (environment) or {@code -Dautosketch.home} replaces
 * {@code <user.home>/.autosketch}, as on the MCP side; GameTests use it so they never write into the
 * real home folder. Failures are logged and never stop the server.
 */
public final class PointerFile {
    private PointerFile() {}

    private static final Logger LOG = LogUtils.getLogger();

    /** The pointer format this build writes. */
    public static final int FORMAT = 1;

    /** {@code ~/.autosketch}, or its override. */
    public static Path autosketchHome() {
        String p = System.getProperty("autosketch.home");
        if (p == null || p.isBlank()) p = System.getenv("AUTOSKETCH_HOME");
        if (p != null && !p.isBlank()) return Path.of(p);
        return Path.of(System.getProperty("user.home"), ".autosketch");
    }

    /** The folder pointer files live in. */
    public static Path gamesDir() {
        return autosketchHome().resolve("games");
    }

    /** A path as the pointer writes it: absolute, normalized, {@code /} separators. */
    public static String gameDirText(Path dir) {
        return dir.toAbsolutePath().normalize().toString().replace('\\', '/');
    }

    /**
     * The file name stem for a game folder (14, *The game-folder hash*): {@code \} to {@code /}, a
     * trailing {@code /} dropped unless the path is a drive root, the whole path lower-cased if it
     * starts with a drive letter, then the first 16 hex digits of the SHA-256 of its UTF-8 bytes.
     */
    public static String hash(String gameDir) {
        String p = gameDir.replace('\\', '/');
        if (p.length() > 1 && !p.matches("[a-zA-Z]:/")) p = p.replaceAll("/+$", "");
        if (p.matches("[a-zA-Z]:/.*")) p = p.toLowerCase(Locale.ROOT);
        try {
            byte[] d = MessageDigest.getInstance("SHA-256").digest(p.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(d).substring(0, 16);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e); // every JVM has SHA-256
        }
    }

    /** What a pointer names. {@code loader}, {@code pairing} and the rest may be null. */
    public record Pointer(String gameDir, String minecraft, @Nullable String loader, @Nullable String loaderVersion,
                          @Nullable String pairing, @Nullable String modVersion, @Nullable Instant updated) {}

    /** The file's text, in the layout of 14's example. */
    public static String format(Pointer p) {
        StringBuilder sb = new StringBuilder("# Autosketch pointer file: written by the companion mod when the game starts (docs/design/14, Instance discovery).\n");
        sb.append("format = ").append(FORMAT).append('\n');
        line(sb, "gameDir", p.gameDir());
        line(sb, "minecraft", p.minecraft());
        line(sb, "loader", p.loader());
        line(sb, "loaderVersion", p.loaderVersion());
        line(sb, "pairing", p.pairing());
        line(sb, "modVersion", p.modVersion());
        line(sb, "updated", p.updated() == null ? null : p.updated().truncatedTo(ChronoUnit.SECONDS).toString());
        return sb.toString();
    }

    private static void line(StringBuilder sb, String key, @Nullable String value) {
        if (value != null && !value.isBlank()) sb.append(key).append(" = ").append(ConfigToml.quote(value)).append('\n');
    }

    /** Writes the pointer for {@code p} into {@code games} (temporary file, then rename); returns the file. */
    public static Path write(Path games, Pointer p) throws IOException {
        Files.createDirectories(games);
        Path file = games.resolve(hash(p.gameDir()) + ".toml");
        Path tmp = games.resolve(file.getFileName() + ".tmp");
        Files.writeString(tmp, format(p), StandardCharsets.UTF_8);
        try {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException e) {
            Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
        }
        return file;
    }

    /** The registry report beside a pointer file ({@code <stem>.registry.json.gz}; 14, *Version-specific data lives in the mod*). */
    public static Path reportBeside(Path pointer) {
        String name = pointer.getFileName().toString();
        return pointer.resolveSibling(name.substring(0, name.length() - ".toml".length()) + REPORT_SUFFIX);
    }

    /** The suffix of a registry report beside its pointer. */
    public static final String REPORT_SUFFIX = ".registry.json.gz";

    /**
     * Deletes the pointers in {@code games} whose game folder no longer exists, except {@code keep},
     * with the registry report beside each, and reports whose pointer is gone. Files it can't read,
     * of another format, or naming a path this OS can't check (a drive-letter path seen from Linux)
     * are left alone. Returns how many pointers were deleted.
     */
    public static int removeStale(Path games, @Nullable Path keep) {
        if (!Files.isDirectory(games)) return 0;
        int removed = 0;
        try (DirectoryStream<Path> files = Files.newDirectoryStream(games, "*" + REPORT_SUFFIX)) {
            for (Path f : files) {
                String name = f.getFileName().toString();
                Path pointer = f.resolveSibling(name.substring(0, name.length() - REPORT_SUFFIX.length()) + ".toml");
                if (pointer.equals(keep) || Files.exists(pointer)) continue;
                try {
                    Files.deleteIfExists(f);
                } catch (IOException e) {
                    LOG.debug("Autosketch: registry report {} left alone ({})", f, e.toString());
                }
            }
        } catch (IOException e) {
            LOG.warn("Autosketch: couldn't list registry reports in {}: {}", games, e.toString());
        }
        try (DirectoryStream<Path> files = Files.newDirectoryStream(games, "*.toml")) {
            for (Path f : files) {
                if (f.equals(keep)) continue;
                try {
                    Map<String, Object> v = ConfigToml.parse(Files.readString(f, StandardCharsets.UTF_8));
                    if (!Long.valueOf(FORMAT).equals(v.get("format")) || !(v.get("gameDir") instanceof String dir) || dir.isBlank()) continue;
                    boolean driveLetter = dir.matches("[a-zA-Z]:[/\\\\].*");
                    if (driveLetter && File.separatorChar == '/') continue;
                    if (!Files.isDirectory(Path.of(dir))) {
                        Files.deleteIfExists(f);
                        Files.deleteIfExists(reportBeside(f));
                        removed++;
                    }
                } catch (IOException | RuntimeException e) {
                    LOG.debug("Autosketch: pointer file {} left alone ({})", f, e.toString());
                }
            }
        } catch (IOException e) {
            LOG.warn("Autosketch: couldn't list pointer files in {}: {}", games, e.toString());
        }
        return removed;
    }

    /** On server start: writes this game's pointer and removes stale ones, or removes this game's pointer when turned off. */
    public static void serverStarted(MinecraftServer server, String modVersion) {
        try {
            Path games = gamesDir();
            String gameDir = gameDirText(server.getServerDirectory());
            if (!AutosketchConfig.get().discovery.pointer) {
                Files.deleteIfExists(games.resolve(hash(gameDir) + ".toml"));
                Files.deleteIfExists(games.resolve(hash(gameDir) + REPORT_SUFFIX));
                return;
            }
            Platform platform = Platform.get();
            Path file = write(games, new Pointer(gameDir, SharedConstants.getCurrentVersion().getName(), platform.loader(), platform.loaderVersion(),
                    gameDirText(platform.configDir().resolve(PairingFile.NAME)), modVersion, Instant.now()));
            int removed = removeStale(games, file);
            LOG.info("Autosketch: pointer file {}{}", file, removed > 0 ? " (" + removed + " stale removed)" : "");
        } catch (IOException | RuntimeException e) {
            LOG.warn("Autosketch: couldn't write the pointer file: {}", e.toString());
        }
    }
}
