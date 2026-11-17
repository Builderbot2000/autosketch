package dev.autosketch.mod.gametest.client.ghost;

import static dev.autosketch.mod.gametest.client.ClientTestSuite.check;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.client.ui.LinkState;
import dev.autosketch.mod.client.ui.blocks.BlockMesher;
import dev.autosketch.mod.client.ui.ghost.Ghosts;
import dev.autosketch.mod.gametest.client.ClientTest;
import dev.autosketch.mod.gametest.client.ClientTestSuite;
import dev.autosketch.mod.protocol.UiMessages.GhostSection;
import dev.autosketch.mod.protocol.UiMessages.UiGhost;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;
import net.minecraft.core.BlockPos;
import org.slf4j.Logger;

/**
 * Measurements for 16 (brief G, *Notes*): mesh time per 16³ section and memory for a 256³ ghost,
 * on whatever renderer the run uses. Two ghosts: a solid 256³ one (inner faces culled, so the cost
 * is the shell) and a scattered 64³ one (30% stone, 10% glass, the rest air: most faces exposed, near
 * the worst case; per-section figures scale to 256³ by 64, and a 256³ run took four minutes on
 * llvmpipe, too long for every run). Results go to the report as {@code WARN MEASURE} lines and to the game log. The ghosts are
 * applied in-process (thousands of sections are too large for a fake MCP script); everything after decoding
 * is the real path.
 */
public final class GhostMeasureClientTests {
    private GhostMeasureClientTests() {}

    private static final Logger LOG = LogUtils.getLogger();

    @ClientTest("ghost-measure")
    public static void ghost256(ClientTestSuite s) {
        measure(s, "solid", 16, 0f, 1f);
        measure(s, "scattered", 4, 0.3f, 0.1f);
    }

    private static void measure(ClientTestSuite s, String name, int n, float stone, float glass) {
        long[] before = new long[3];
        s.waitUntil("connected", () -> LinkState.connected(), 400);
        s.step(name + ": apply a " + (16 * n) + "³ ghost (" + (n * n * n) + " sections)", () -> {
            Ghosts.meshBudgetNanos = 200_000_000L;
            before[0] = BlockMesher.sectionsMeshed();
            before[1] = BlockMesher.nanosMeshing();
            before[2] = System.nanoTime();
            BlockPos o = s.player().blockPosition().offset(-128, -1, 24);
            String dim = s.player().level().dimension().location().toString();
            List<String> palette = List.of("minecraft:air", "minecraft:stone", "minecraft:glass");
            Random rnd = new Random(1);
            for (int sy = 0; sy < n; sy++) {
                List<GhostSection> secs = new ArrayList<>(n * n);
                for (int sz = 0; sz < n; sz++)
                    for (int sx = 0; sx < n; sx++) {
                        int[] st = new int[4096];
                        for (int i = 0; i < 4096; i++) {
                            if (stone == 0f) st[i] = 1;
                            else {
                                float r = rnd.nextFloat();
                                st[i] = r < stone ? 1 : r < stone + glass ? 2 : 0;
                            }
                        }
                        secs.add(new GhostSection(sx, sy, sz, st));
                    }
                Ghosts.applyForTest(new UiGhost(List.of(s.player().getUUID()), name, dim, o.getX(), o.getY(), o.getZ(), 0x80c0ff, sy == 0, palette, secs));
            }
        });
        s.waitUntil(name + ": every section meshed", () -> Ghosts.pending() == 0, 20 * 600);
        s.step(name + ": record", () -> {
            long sections = BlockMesher.sectionsMeshed() - before[0];
            long nanos = BlockMesher.nanosMeshing() - before[1];
            long wall = System.nanoTime() - before[2];
            check(sections == (long) n * n * n, "meshed " + sections + " sections");
            String line = String.format("MEASURE ghost %d³ %s on %s: %d sections meshed, %.2f ms per section (%.1f s in all, %.1f s wall), %d meshes, mesh %.1f MiB (GPU), blocks %.1f MiB (heap)",
                    16 * n, name, ClientTestSuite.renderer(), sections, nanos / 1e6 / sections, nanos / 1e9, wall / 1e9, Ghosts.meshed(name).size(),
                    Ghosts.meshBytes() / 1048576.0, Ghosts.blockBytes() / 1048576.0);
            LOG.info(line);
            s.warn(line);
        });
        s.cleanup(name + ": free it", () -> {
            Ghosts.meshBudgetNanos = 4_000_000L;
            Ghosts.clearForTest(name);
        });
    }
}
