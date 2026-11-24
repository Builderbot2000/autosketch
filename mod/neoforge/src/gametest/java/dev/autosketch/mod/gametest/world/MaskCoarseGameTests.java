package dev.autosketch.mod.gametest.world;

import static dev.autosketch.mod.gametest.world.FillGameTests.check;
import static dev.autosketch.mod.gametest.world.SelectGameTests.refusedWith;
import static dev.autosketch.mod.gametest.world.WorldTestKit.dim;
import static dev.autosketch.mod.gametest.world.WorldTestKit.nextId;
import static dev.autosketch.mod.gametest.world.WorldTestKit.put;
import static dev.autosketch.mod.gametest.world.WorldTestKit.unlink;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.gametest.world.FillGameTests.Steps;
import dev.autosketch.mod.gametest.world.WorldTestKit.TestExchange;
import dev.autosketch.mod.protocol.BodyTypes.SnapshotRegion;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.Messages.ChunkXZ;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.Messages.Section;
import dev.autosketch.mod.protocol.SelectMessages;
import dev.autosketch.mod.protocol.SelectMessages.CoarseRegion;
import dev.autosketch.mod.protocol.SelectMessages.CoarseResult;
import dev.autosketch.mod.world.CoarseReads;
import dev.autosketch.mod.world.ScanGrants;
import dev.autosketch.mod.world.SelectGrants;
import dev.autosketch.mod.world.WorldModule;
import dev.autosketch.mod.world.WorldReads;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;
import org.slf4j.Logger;

/**
 * Select's snapshots, mod side (18, piece 5; 13, {@code snapshot} kinds {@code mask} and
 * {@code coarse}): a mask snapshot's sections plus margin as a blocks snapshot inside the select grant;
 * a coarse snapshot over a loaded chunk, a saved and unloaded one (read from disk, not loaded) and an
 * ungenerated one (air, listed), sliced over ticks, with the most common non-air block per cell (the
 * game's airs counting as air, ties to the first met), boxes grown to the cell grid; the refusals.
 * Each test works high above a far, random area, since the test world is kept between runs.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class MaskCoarseGameTests {
    private MaskCoarseGameTests() {}

    private static final Logger LOG = LogUtils.getLogger();
    static final String HONEY = SelectGameTests.HONEY, KELP = SelectGameTests.KELP, STONE = "minecraft:stone", DIRT = "minecraft:dirt", AIR = "minecraft:air";
    static final int Y = 200;

    static TestExchange mask(SelectMessages.MaskSnapshotRequest req) {
        TestExchange ex = new TestExchange(req.id());
        try {
            WorldModule.services().reads().mask(SelectMessages.MaskSnapshotRequest.decode(req.encode()), ex);
        } catch (ProtocolException e) {
            ex.error(e.code(), e.getMessage());
        }
        return ex;
    }

    static TestExchange coarse(SelectMessages.CoarseSnapshotRequest req) {
        TestExchange ex = new TestExchange(req.id());
        try {
            WorldModule.coarse().coarse(SelectMessages.CoarseSnapshotRequest.decode(req.encode()), ex);
        } catch (ProtocolException e) {
            ex.error(e.code(), e.getMessage());
        }
        return ex;
    }

    static CoarseResult coarseResult(TestExchange ex) {
        if (ex.errorCode != null) throw new GameTestAssertException("refused: " + ex.errorCode);
        try {
            return CoarseResult.decode(ex.reply);
        } catch (ProtocolException e) {
            throw new GameTestAssertException("undecodable coarse result: " + e.getMessage());
        }
    }

    /** The cells of a coarse region as state names, x fastest, then z, then y. */
    static List<String> names(CoarseResult r, int region) {
        List<String> out = new ArrayList<>();
        for (int s : r.regions().get(region).states()) out.add(r.palette().get(s));
        return out;
    }

    /** The state a blocks snapshot holds at a position (the first region containing it). */
    static String stateAt(Messages.SnapshotResult r, BlockPos p) {
        for (SnapshotRegion g : r.regions()) {
            Box b = g.box();
            if (!b.contains(p)) continue;
            int i = (p.getX() - b.minX()) + b.sizeX() * ((p.getZ() - b.minZ()) + b.sizeZ() * (p.getY() - b.minY()));
            return r.palette().get(g.states()[i]);
        }
        throw new GameTestAssertException("no region holds " + p.toShortString());
    }

    static void fillAir(ServerLevel level, int x0, int y0, int z0, int x1, int y1, int z1) {
        for (int y = y0; y <= y1; y++)
            for (int z = z0; z <= z1; z++)
                for (int x = x0; x <= x1; x++) put(level, new BlockPos(x, y, z), AIR, null);
    }

    /**
     * A mask snapshot of one section with margin 2: answered as a blocks snapshot whose regions are
     * {@code maskRegions}' layout, a block in the section and one in the margin read, the ungenerated
     * chunk east listed (and still not generated); over {@code contextCap} positions {@code too_large};
     * outside the grant without volumes {@code no_volumes}.
     */
    @GameTest(template = "empty", batch = "y_select_mask", timeoutTicks = 400)
    public static void maskSnapshotReadsSectionsPlusMargin(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        unlink();
        ScanGrants.clear();
        int[] f = SelectGameTests.farChunk();
        int fx = f[0], fz = f[1];
        level.getChunk(fx, fz);
        level.getChunk(fx - 1, fz);
        BlockPos honey = new BlockPos((fx << 4) + 15, Y, (fz << 4) + 3), kelp = new BlockPos((fx << 4) - 2, Y + 1, (fz << 4) + 3);
        put(level, honey, HONEY, null);
        put(level, kelp, KELP, null);
        SelectGrants.set(level.dimension(), honey, 3);
        Section s = new Section(fx, Y >> 4, fz);
        TestExchange in = mask(new SelectMessages.MaskSnapshotRequest(nextId(), dim(h), List.of(s), 2));
        List<Section> column = new ArrayList<>();
        // 1,100 sections of 4,096 positions: over the default contextCap of 4,194,304.
        for (int i = 0; i < 1100; i++) column.add(new Section(fx - 3 + i % 7, i / 49 - 4, fz - 3 + (i / 7) % 7));
        TestExchange tooLarge = mask(new SelectMessages.MaskSnapshotRequest(nextId(), dim(h), column, 0));
        TestExchange out = mask(new SelectMessages.MaskSnapshotRequest(nextId(), dim(h), List.of(new Section(fx + 4, Y >> 4, fz)), null));
        h.succeedWhen(() -> {
            if (!in.done || !tooLarge.done || !out.done) throw new GameTestAssertException("waiting for the replies");
            try {
                LOG.info("Autosketch mask snapshot timing: {}", WorldReads.lastRead);
                check(in.errorCode == null, "a mask snapshot inside the select grant is served: " + in.errorCode);
                Messages.SnapshotResult r = Messages.SnapshotResult.decode(in.reply);
                List<Box> regions = r.regions().stream().map(SnapshotRegion::box).toList();
                check(regions.equals(SelectMessages.maskRegions(List.of(s), 2)), "the regions follow maskRegions: " + regions);
                check(regions.size() == 27 && regions.get(0).equals(s.box()), "the section, then its 26 margin pieces");
                check(stateAt(r, honey).equals(HONEY), "the block in the section");
                check(stateAt(r, kelp).equals(KELP), "the block in the margin");
                check(stateAt(r, honey.east()).equals(AIR), "the ungenerated chunk east reads as air");
                check(r.missing() != null && r.missing().contains(new ChunkXZ(fx + 1, fz)) && !r.missing().contains(new ChunkXZ(fx, fz))
                        && !r.missing().contains(new ChunkXZ(fx - 1, fz)), "the ungenerated chunk east is listed, the generated ones aren't: " + r.missing());
                check(level.getChunkSource().getChunkNow(fx + 1, fz) == null, "and it is still not generated");
                refusedWith(h, tooLarge, "too_large");
                refusedWith(h, out, "no_volumes");
            } catch (ProtocolException e) {
                throw new GameTestAssertException("undecodable snapshot: " + e.getMessage());
            } finally {
                SelectGrants.clear();
            }
        });
    }

    /**
     * Chunk B saved and unloaded, C east of it never generated, A five chunks east loaded (forced).
     * In A, one 4³ cell at y 200: its first 2³ cell holds cave and void air (counted as air) with
     * stone and dirt tied at two each (stone met first), its second three honey blocks, the rest air;
     * in B, a 4³ cell of kelp. Cell 2 over A's and B's cells, then cell 4 over a strip across B and C
     * and an unaligned box inside A's cell, one chunk per tick: B is read from disk without loading
     * it, C is air and listed, A is read loaded.
     */
    @GameTest(template = "empty", batch = "y_select_coarse", timeoutTicks = 2400)
    public static void coarseReadsLoadedSavedAndUngeneratedChunks(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        unlink();
        ScanGrants.clear();
        int[] f = SelectGameTests.farChunk();
        int bx = f[0], cz = f[1], ax = bx + 5;
        level.getChunk(bx, cz);
        level.setChunkForced(ax, cz, true);
        int z0 = cz << 4, b0 = bx << 4, a0 = ax << 4;
        fillAir(level, b0, Y, z0, b0 + 15, Y + 3, z0 + 3);
        fillAir(level, a0, Y, z0, a0 + 15, Y + 3, z0 + 3);
        for (int y = 0; y < 4; y++)
            for (int z = 0; z < 4; z++)
                for (int x = 0; x < 4; x++) put(level, new BlockPos(b0 + x, Y + y, z0 + z), KELP, null);
        // A's first 2³ cell, by index x + 2·(z + 2·y): 1 and 6 stone, 2 and 5 dirt, 0, 3, 4 cave air, 7 void air.
        String[] first = {"minecraft:cave_air", STONE, DIRT, "minecraft:cave_air", "minecraft:cave_air", DIRT, STONE, "minecraft:void_air"};
        for (int i = 0; i < 8; i++) {
            BlockPos p = new BlockPos(a0 + (i & 1), Y + (i >> 2), z0 + ((i >> 1) & 1));
            // The wire never names cave or void air (they print as air), so they are set directly.
            if (first[i].endsWith("cave_air")) level.setBlock(p, Blocks.CAVE_AIR.defaultBlockState(), Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE);
            else if (first[i].endsWith("void_air")) level.setBlock(p, Blocks.VOID_AIR.defaultBlockState(), Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE);
            else put(level, p, first[i], null);
        }
        put(level, new BlockPos(a0 + 2, Y, z0), HONEY, null);
        put(level, new BlockPos(a0 + 3, Y, z0), HONEY, null);
        put(level, new BlockPos(a0 + 2, Y, z0 + 1), HONEY, null);
        level.getChunkSource().save(true);
        long slice = CoarseReads.sliceNanos;
        Runnable cleanup = () -> {
            CoarseReads.sliceNanos = slice;
            level.setChunkForced(ax, cz, false);
            SelectGrants.clear();
        };
        Box aCell = new Box(a0, Y, z0, a0 + 3, Y + 3, z0 + 3), bCell = new Box(b0, Y, z0, b0 + 3, Y + 3, z0 + 3);
        Steps steps = new Steps()
                .then(() -> {
                    SelectGrants.set(level.dimension(), new BlockPos(b0, Y, z0), 8);
                    return coarse(new SelectMessages.CoarseSnapshotRequest(nextId(), dim(h), 2, List.of(aCell, bCell)));
                }, ex -> {
                    LOG.info("Autosketch coarse timing (cell 2, a loaded and a saved chunk): {}", CoarseReads.lastCoarse);
                    CoarseResult r = coarseResult(ex);
                    check(r.cell() == 2 && r.missing() == null, "cell 2, nothing missing: " + r.missing());
                    check(r.regions().get(0).box().equals(aCell) && r.regions().get(1).box().equals(bCell), "aligned boxes kept");
                    check(names(r, 0).equals(List.of(STONE, HONEY, AIR, AIR, AIR, AIR, AIR, AIR)), "A: stone wins the tie over the airs and dirt, then honey, then air: " + names(r, 0));
                    check(names(r, 1).equals(List.of(KELP, KELP, KELP, KELP, KELP, KELP, KELP, KELP)), "B: kelp: " + names(r, 1));
                    CoarseReads.Stats st = CoarseReads.lastCoarse;
                    check(st != null && st.cells() == 16 && st.loaded() == 1 && st.disk() == 1 && st.fallback() == 0, "A loaded, B from disk: " + st);
                    check(level.getChunkSource().getChunkNow(bx, cz) == null, "B was read without loading it");
                })
                .then(() -> {
                    CoarseReads.sliceNanos = 1;
                    Box strip = new Box(b0, Y, z0, b0 + 31, Y + 3, z0 + 3);
                    Box inside = new Box(a0 + 1, Y + 1, z0 + 1, a0 + 2, Y + 2, z0 + 2);
                    return coarse(new SelectMessages.CoarseSnapshotRequest(nextId(), dim(h), 4, List.of(strip, inside)));
                }, ex -> {
                    LOG.info("Autosketch coarse timing (cell 4, sliced, a saved and an ungenerated chunk): {}", CoarseReads.lastCoarse);
                    CoarseResult r = coarseResult(ex);
                    List<CoarseRegion> rs = r.regions();
                    check(rs.get(1).box().equals(aCell), "the unaligned box grows to its 4³ cell: " + rs.get(1).box());
                    List<String> strip = names(r, 0);
                    check(strip.size() == 8 && strip.get(0).equals(KELP) && strip.subList(1, 8).stream().allMatch(AIR::equals), "B's kelp cell, then air (C ungenerated): " + strip);
                    check(names(r, 1).equals(List.of(HONEY)), "A's cell: honey, three against two stone and two dirt: " + names(r, 1));
                    check(List.of(new ChunkXZ(bx + 1, cz)).equals(r.missing()), "C is listed: " + r.missing());
                    CoarseReads.Stats st = CoarseReads.lastCoarse;
                    check(st != null && st.chunks() == 3 && st.ticks() >= 3 && st.missing() == 1 && st.blocks() == 9 * 64L, "one chunk per tick, C missing: " + st);
                    check(level.getChunkSource().getChunkNow(bx, cz) == null && level.getChunkSource().getChunkNow(bx + 1, cz) == null, "B not loaded, C not generated");
                });
        h.startSequence()
                .thenWaitUntil(() -> {
                    if (level.getChunkSource().getChunkNow(bx, cz) != null) throw new GameTestAssertException("waiting for chunk B to unload");
                })
                .thenExecute(() -> steps.run(h, cleanup));
    }

    /** Over {@code contextCap} cells inside the grant {@code too_large}; outside it without volumes {@code no_volumes}; a bad cell {@code bad_request}. */
    @GameTest(template = "empty", batch = "y_select_coarse_refusals", timeoutTicks = 400)
    public static void coarseRefusals(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        unlink();
        ScanGrants.clear();
        int[] f = SelectGameTests.farChunk();
        int fx = f[0], fz = f[1];
        SelectGrants.set(level.dimension(), new BlockPos(fx << 4, Y, fz << 4), 16);
        try {
            Box whole = new Box((fx - 16) << 4, level.getMinBuildHeight(), (fz - 16) << 4, ((fx + 16) << 4) + 15, level.getMaxBuildHeight() - 1, ((fz + 16) << 4) + 15);
            long cells = whole.volume() / 8;
            check(cells > AutosketchConfig.get().volumes.contextCap, "the test box is over the cap: " + cells);
            TestExchange tooLarge = coarse(new SelectMessages.CoarseSnapshotRequest(nextId(), dim(h), 2, List.of(whole)));
            refusedWith(h, tooLarge, "too_large");
            check(level.getChunkSource().getChunkNow(fx + 16, fz + 16) == null, "refused before reading anything");
            Box outside = new Box((fx + 17) << 4, Y, fz << 4, ((fx + 17) << 4) + 3, Y + 3, (fz << 4) + 3);
            refusedWith(h, coarse(new SelectMessages.CoarseSnapshotRequest(nextId(), dim(h), 4, List.of(outside))), "no_volumes");
            TestExchange bad = new TestExchange(nextId());
            try {
                var frame = new SelectMessages.CoarseSnapshotRequest(bad.id(), dim(h), 4, List.of(outside)).encode();
                frame.header().addProperty("cell", 3);
                SelectMessages.CoarseSnapshotRequest.decode(frame);
                bad.error("none", "decoded");
            } catch (ProtocolException e) {
                bad.error(e.code(), e.getMessage());
            }
            refusedWith(h, bad, "bad_request");
        } finally {
            SelectGrants.clear();
        }
        h.succeed();
    }
}
