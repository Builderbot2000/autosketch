package dev.autosketch.mod;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The Cloth Config file and the one-time migration from the ModConfigSpec file (14, *Config across loaders*). */
class ConfigMigrationTest {
    /** A file in exactly the layout NeoForge's ModConfigSpec wrote for the previous build, every value changed. */
    static final String LEGACY = """
            [bridge]
            \t#TCP port for the MCP connection on 127.0.0.1. 0 picks a free port on every start (written to config/autosketch-bridge.toml).
            \t# Default: 0
            \t# Range: 0 ~ 65535
            \tport = 25601

            [patches]
            \t#Most blocks a patch writes per server tick; larger patches continue on the next ticks (M7).
            \t# Default: 20000
            \t# Range: 1 ~ 10000000
            \ttickBudget = 5000

            [tracking]
            \t# Default: 4096
            \t# Range: 1 ~ 4096
            \tdirtyCap = 128
            \t#How block changes are detected: "hook" (a mixin on chunk block writes, immediate), "scan" (periodic comparison ...
            \ttracker = "scan"
            \t# Default: 20
            \t# Range: 1 ~ 1200
            \tscanPeriod = 40

            [volumes]
            \t# Default: 4194304
            \t# Range: 1 ~ 1099511627776
            \tcontextCap = 8388608

            [feedback]
            \t#Whether action-bar notices are on for a player who hasn't set /autosketch notices.
            \tnoticesDefault = false

            [prompts]
            \t#A short top-level alias for /autosketch ask (e.g. "as"), or empty for none.
            \taskAlias = "as"
            \t# Default: 64.0
            \t# Range: 1.0 ~ 512.0
            \ttargetReach = 96.5
            """;

    private static void assertMigrated(AutosketchConfig c) {
        assertEquals(25601, c.bridge.port);
        assertEquals(5000, c.patches.tickBudget);
        assertEquals(128, c.tracking.dirtyCap);
        assertEquals("scan", c.tracking.tracker);
        assertEquals(40, c.tracking.scanPeriod);
        assertEquals(8_388_608L, c.volumes.contextCap);
        assertFalse(c.feedback.noticesDefault);
        assertEquals("as", c.prompts.askAlias);
        assertEquals(96.5, c.prompts.targetReach);
    }

    @Test
    void migratesEveryKeyOnceAndKeepsTheOldFile(@TempDir Path dir) throws Exception {
        Files.writeString(dir.resolve("autosketch-common.toml"), LEGACY, StandardCharsets.UTF_8);
        AutosketchConfig.Serializer s = new AutosketchConfig.Serializer(dir);

        AutosketchConfig c = s.deserialize();
        assertMigrated(c);
        assertFalse(Files.exists(dir.resolve("autosketch-common.toml")), "the old file is no longer read");
        assertEquals(LEGACY, Files.readString(dir.resolve("autosketch-common.toml.bak")), "kept unchanged as a backup");

        s.serialize(c);
        assertMigrated(s.deserialize());
        // The mixin plugin reads the tracker mode from the new file as text.
        assertTrue(Files.readString(dir.resolve("autosketch.toml")).contains("\ttracker = \"scan\"\n"));

        // A later start reads the new file; a stray old file is not migrated again.
        Files.writeString(dir.resolve("autosketch-common.toml"), "[bridge]\nport = 1\n");
        assertMigrated(s.deserialize());
        assertTrue(Files.exists(dir.resolve("autosketch-common.toml")));
    }

    @Test
    void defaultsWithoutAnyFile(@TempDir Path dir) throws Exception {
        AutosketchConfig c = new AutosketchConfig.Serializer(dir).deserialize();
        assertEquals(0, c.bridge.port);
        assertEquals(20_000, c.patches.tickBudget);
        assertEquals(4096, c.tracking.dirtyCap);
        assertEquals("both", c.tracking.tracker);
        assertEquals(20, c.tracking.scanPeriod);
        assertEquals(4_194_304L, c.volumes.contextCap);
        assertTrue(c.feedback.noticesDefault);
        assertEquals("", c.prompts.askAlias);
        assertEquals(64.0, c.prompts.targetReach);
    }

    @Test
    void clampsRangesAndResetsInvalidValuesLikeModConfigSpec() {
        AutosketchConfig c = AutosketchConfig.read("""
                [bridge]
                port = 70000
                [patches]
                tickBudget = 0
                [tracking]
                tracker = "sometimes"
                dirtyCap = "lots"
                scanPeriod = 20_0
                [prompts]
                targetReach = 1000
                askAlias = 'lit\\eral'  # a comment
                """);
        assertEquals(65535, c.bridge.port);
        assertEquals(1, c.patches.tickBudget);
        assertEquals("both", c.tracking.tracker);
        assertEquals(4096, c.tracking.dirtyCap);
        assertEquals(200, c.tracking.scanPeriod);
        assertEquals(512.0, c.prompts.targetReach);
        assertEquals("lit\\eral", c.prompts.askAlias);
    }

    /** A file from before select (18) gains the [select] section with its defaults; values clamp to their ranges. */
    @Test
    void selectKeysJoinAnOlderFile(@TempDir Path dir) throws Exception {
        AutosketchConfig.Serializer s = new AutosketchConfig.Serializer(dir);
        Files.writeString(dir.resolve("autosketch.toml"), "[volumes]\n\tcontextCap = 1000\n", StandardCharsets.UTF_8);
        AutosketchConfig c = s.deserialize();
        assertEquals(1000L, c.volumes.contextCap);
        assertEquals(256, c.select.selectChunks);
        assertEquals(2, c.select.searchGap);
        assertEquals(1, c.select.searchStop);
        s.serialize(c);
        String text = Files.readString(dir.resolve("autosketch.toml"));
        assertTrue(text.contains("[select]\n") && text.contains("\tselectChunks = 256\n") && text.contains("\tsearchGap = 2\n") && text.contains("\tsearchStop = 1\n"), text);

        AutosketchConfig d = AutosketchConfig.read("[select]\nselectChunks = 1000\nsearchGap = 0\nsearchStop = 3\n");
        assertEquals(256, d.select.selectChunks, "256 is the cap");
        assertEquals(1, d.select.searchGap);
        assertEquals(3, d.select.searchStop);
    }

    @Test
    void writtenFileRoundTripsStrings() {
        AutosketchConfig c = new AutosketchConfig();
        c.prompts.askAlias = "a\"b\\c";
        assertEquals("a\"b\\c", AutosketchConfig.read(AutosketchConfig.write(c)).prompts.askAlias);
    }
}
