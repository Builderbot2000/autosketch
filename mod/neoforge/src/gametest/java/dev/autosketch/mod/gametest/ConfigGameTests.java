package dev.autosketch.mod.gametest;

import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.platform.Platform;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestHelper;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;

/**
 * The Cloth Config file in a running game (14, *Config across loaders*): it exists after start, and
 * an edit made while the server runs is read again, as NeoForge's config watcher did. Uses
 * {@code askAlias}, which is only read when commands register, so other tests aren't affected.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class ConfigGameTests {
    private ConfigGameTests() {}

    private static void write(Path file, String text, long bumpMillis) throws Exception {
        Files.writeString(file, text, StandardCharsets.UTF_8);
        // Past the previous timestamp even on file systems with coarse modification times.
        Files.setLastModifiedTime(file, FileTime.fromMillis(System.currentTimeMillis() + bumpMillis));
    }

    @GameTest(template = "empty")
    public static void editedFileIsReadAgain(GameTestHelper helper) throws Exception {
        Path file = Platform.get().configDir().resolve(AutosketchConfig.FILE);
        helper.assertTrue(Files.isRegularFile(file), "config/autosketch.toml written at start");
        String original = Files.readString(file, StandardCharsets.UTF_8);
        helper.assertTrue(original.contains("\taskAlias = "), "the file has every key");
        String before = AutosketchConfig.get().prompts.askAlias;
        try {
            write(file, original.replaceFirst("\taskAlias = .*\n", "\taskAlias = \"zz\"\n"), 2_000);
            AutosketchConfig.reloadIfChanged();
            helper.assertTrue(AutosketchConfig.get().prompts.askAlias.equals("zz"), "the edit is read");
        } finally {
            write(file, original, 4_000);
            AutosketchConfig.reloadIfChanged();
        }
        helper.assertTrue(AutosketchConfig.get().prompts.askAlias.equals(before), "restored");
        helper.succeed();
    }
}
