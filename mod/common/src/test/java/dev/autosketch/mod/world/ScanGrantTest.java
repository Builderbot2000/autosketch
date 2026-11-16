package dev.autosketch.mod.world;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonParser;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Messages;
import java.nio.file.Files;
import java.nio.file.Path;
import org.junit.jupiter.api.Test;

/** Sizing the scan grant (13, {@code prompt} {@code scan}; B4) from the config defaults. */
class ScanGrantTest {
    static final long CAP = 4_194_304L;

    /** The golden vector's grant (/autosketch scan 20 at -40.5, 68, 23.5) is what the mod sizes. */
    @Test
    void reproducesTheGoldenScanPrompt() throws Exception {
        var side = JsonParser.parseString(Files.readString(Path.of(System.getProperty("autosketch.goldenDir"), "prompt-scan.json"))).getAsJsonObject();
        Messages.ScanGrant expected = Messages.ScanGrant.fromJson(side.getAsJsonObject("header").getAsJsonObject("scan"), null);
        Messages.ScanGrant g = ScanGrants.size(20, 4, 12, -41, 68, 23, -64, 319, 32, 64, CAP);
        assertEquals(expected, g);
    }

    @Test
    void defaultRadiusFitsWhole() {
        Messages.ScanGrant g = ScanGrants.size(-1, 4, 12, 5, 70, 5, -64, 319, 32, 64, CAP);
        assertEquals(4, g.radius());
        assertFalse(g.clipped());
        assertEquals(144, g.columns().sizeX());
        Box b = g.box();
        // 144 x 97 x 144 = 2.0 M blocks fits under the cap: the whole columns' width.
        assertEquals(new Box(-64, 38, -64, 79, 134, 79), b);
        assertTrue(b.volume() <= CAP);
    }

    @Test
    void clipsToTheBuildHeightAndStaysInsideColumns() {
        Messages.ScanGrant g = ScanGrants.size(1, 4, 12, 0, 300, 0, -64, 319, 32, 64, CAP);
        assertEquals(268, g.box().minY());
        assertEquals(319, g.box().maxY());
        assertEquals(g.columns().minX(), g.box().minX());
        assertEquals(g.columns().maxX(), g.box().maxX());
        Messages.ScanGrant tiny = ScanGrants.size(4, 4, 12, 15, 64, 15, -64, 319, 32, 64, 97 * 10 * 10);
        assertEquals(10, tiny.box().sizeX());
        assertEquals(new Box(10, 32, 10, 19, 128, 19), tiny.box());
    }
}
