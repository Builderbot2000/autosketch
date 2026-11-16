package dev.autosketch.mod.discovery;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.autosketch.mod.config.ConfigToml;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The pointer file (14, *Pointer file format*), against the MCP side's reference vectors. */
class PointerFileTest {
    @Test
    void hashMatchesTheReferenceVectors() {
        // The same vectors as test/unit/discover/discover.test.ts and 14.
        assertEquals("b5a55e002a16ad14", PointerFile.hash("C:\\Users\\Me\\curseforge\\minecraft\\Instances\\Craftoria"));
        assertEquals("b5a55e002a16ad14", PointerFile.hash("c:/users/me/curseforge/minecraft/instances/craftoria/"));
        assertEquals("c3225877496e34ed", PointerFile.hash("/home/me/.local/share/PrismLauncher/instances/Pack/minecraft"));
        assertEquals(PointerFile.hash("/home/me/x"), PointerFile.hash("/home/me/x//"));
    }

    @Test
    void writesTheDocumentedKeys(@TempDir Path tmp) throws Exception {
        Path game = Files.createDirectories(tmp.resolve("Craftoria \"one\""));
        String dir = PointerFile.gameDirText(game);
        Path file = PointerFile.write(tmp.resolve("games"), new PointerFile.Pointer(dir, "1.21.1", "neoforge", "21.1.249",
                dir + "/config/autosketch-bridge.toml", "0.1.0", Instant.parse("2026-11-16T10:00:00.123Z")));
        assertEquals(PointerFile.hash(dir) + ".toml", file.getFileName().toString());
        String text = Files.readString(file);
        assertTrue(text.startsWith("# Autosketch pointer file"));
        Map<String, Object> v = ConfigToml.parse(text);
        assertEquals(1L, v.get("format"));
        assertEquals(dir, v.get("gameDir"));
        assertEquals("1.21.1", v.get("minecraft"));
        assertEquals("neoforge", v.get("loader"));
        assertEquals("21.1.249", v.get("loaderVersion"));
        assertEquals(dir + "/config/autosketch-bridge.toml", v.get("pairing"));
        assertEquals("0.1.0", v.get("modVersion"));
        assertEquals("2026-11-16T10:00:00Z", v.get("updated"));
        assertFalse(text.contains("name ="), "no name unless the mod can tell");
        assertFalse(Files.exists(file.resolveSibling(file.getFileName() + ".tmp")));
    }

    @Test
    void removesOnlyPointersWhoseGameFolderIsGone(@TempDir Path tmp) throws Exception {
        Path games = tmp.resolve("games");
        Path live = Files.createDirectories(tmp.resolve("live"));
        Path gone = Files.createDirectories(tmp.resolve("gone"));
        Path liveFile = PointerFile.write(games, new PointerFile.Pointer(PointerFile.gameDirText(live), "1.21.1", null, null, null, null, null));
        Path goneFile = PointerFile.write(games, new PointerFile.Pointer(PointerFile.gameDirText(gone), "1.21.1", null, null, null, null, null));
        Path keep = PointerFile.write(games, new PointerFile.Pointer(PointerFile.gameDirText(tmp.resolve("me")), "1.21.1", null, null, null, null, null));
        Files.writeString(games.resolve("other.toml"), "format = 2\ngameDir = \"/nowhere\"\nminecraft = \"1.21.1\"\n");
        Files.writeString(games.resolve("junk.toml"), "not toml at all [[[");
        Files.writeString(games.resolve("abc.registry.json.gz"), "x");
        Files.delete(gone);

        assertEquals(1, PointerFile.removeStale(games, keep));
        assertTrue(Files.exists(liveFile));
        assertFalse(Files.exists(goneFile));
        assertTrue(Files.exists(keep), "this game's own pointer is kept even before its folder check");
        assertTrue(Files.exists(games.resolve("other.toml")), "another format is left alone");
        assertTrue(Files.exists(games.resolve("junk.toml")));
        assertTrue(Files.exists(games.resolve("abc.registry.json.gz")));
    }
}
