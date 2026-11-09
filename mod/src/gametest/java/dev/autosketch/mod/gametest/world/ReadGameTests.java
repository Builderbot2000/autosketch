package dev.autosketch.mod.gametest.world;

import static dev.autosketch.mod.gametest.world.WorldTestKit.box;
import static dev.autosketch.mod.gametest.world.WorldTestKit.dim;
import static dev.autosketch.mod.gametest.world.WorldTestKit.link;
import static dev.autosketch.mod.gametest.world.WorldTestKit.print;
import static dev.autosketch.mod.gametest.world.WorldTestKit.put;
import static dev.autosketch.mod.gametest.world.WorldTestKit.snbt;
import static dev.autosketch.mod.gametest.world.WorldTestKit.unlink;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.Inbound;
import dev.autosketch.mod.api.LinkVolumes;
import dev.autosketch.mod.gametest.world.WorldTestKit.TestExchange;
import dev.autosketch.mod.protocol.BodyTypes.BlockEntityNbt;
import dev.autosketch.mod.protocol.BodyTypes.PatchBlock;
import dev.autosketch.mod.protocol.BodyTypes.SnapshotRegion;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.world.Hashing;
import dev.autosketch.mod.world.States;
import dev.autosketch.mod.world.VolatileKeys;
import dev.autosketch.mod.world.WorldBlocks;
import dev.autosketch.mod.world.WorldModule;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.level.ServerLevel;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;
import org.slf4j.Logger;

/** Snapshots and section hashes in a running game (13, *World → agent*; M8), and the measurements. */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class ReadGameTests {
    private ReadGameTests() {}

    private static final Logger LOG = LogUtils.getLogger();

    static TestExchange snapshot(Messages.SnapshotRequest req) {
        TestExchange ex = new TestExchange(req.id());
        try {
            WorldModule.services().reads().snapshot(Messages.SnapshotRequest.decode(req.encode()), ex);
        } catch (ProtocolException e) {
            ex.error(e.code(), e.getMessage());
        }
        return ex;
    }

    static TestExchange hashes(Messages.HashesRequest req) {
        TestExchange ex = new TestExchange(req.id());
        try {
            WorldModule.services().reads().hashes(Messages.HashesRequest.decode(req.encode()), ex, WorldModule.keysOf(new Inbound(req.encode(), WorldTestKit.session())));
        } catch (ProtocolException e) {
            ex.error(e.code(), e.getMessage());
        }
        return ex;
    }

    static void await(GameTestHelper h, TestExchange ex, Runnable then) {
        h.succeedWhen(() -> {
            if (!ex.done) throw new GameTestAssertException("waiting for the reply");
            try {
                then.run();
            } finally {
                unlink();
            }
        });
    }

    @GameTest(template = "empty", batch = "o_snapshot", timeoutTicks = 100)
    public static void snapshotMatchesTheWorld(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        Box work = box(h, 0, 0, 0, 2, 2, 2);
        LinkVolumes v = link(h, work);
        put(level, h.absolutePos(new BlockPos(0, 0, 0)), "minecraft:oak_log[axis=z]", null);
        put(level, h.absolutePos(new BlockPos(2, 1, 0)), "minecraft:chest[facing=east,type=single,waterlogged=false]", snbt("{id:\"minecraft:chest\",Items:[{Slot:4b,count:1,id:\"minecraft:apple\"}]}"));
        WorldBlocks.write(level, h.absolutePos(new BlockPos(1, 2, 2)), net.minecraft.world.level.block.Blocks.CAVE_AIR.defaultBlockState(), null);
        // The work volume and an overlapping context box, as the MCP links.
        Box ctx = work.grow(1);
        Messages.SnapshotRequest req = new Messages.SnapshotRequest(WorldTestKit.nextId(), dim(h), List.of(work, ctx), null);
        TestExchange ex = snapshot(req);
        await(h, ex, () -> {
            Messages.SnapshotResult r;
            try {
                r = Messages.SnapshotResult.decode(ex.reply);
            } catch (ProtocolException e) {
                throw new GameTestAssertException("bad snapshot frame: " + e.getMessage() + " " + ex.errorCode);
            }
            if (r.regions().size() != 2) throw new GameTestAssertException("2 regions");
            for (SnapshotRegion reg : r.regions()) {
                int i = 0;
                Map<BlockPos, CompoundTag> bes = new HashMap<>();
                for (BlockEntityNbt be : reg.blockEntities()) bes.put(be.pos(), be.nbt());
                Box b = reg.box();
                for (int y = b.minY(); y <= b.maxY(); y++) for (int z = b.minZ(); z <= b.maxZ(); z++) for (int x = b.minX(); x <= b.maxX(); x++) {
                    BlockPos p = new BlockPos(x, y, z);
                    String got = r.palette().get(reg.states()[i++]);
                    if (!got.equals(print(level, p))) throw new GameTestAssertException("at " + p + ": " + got + " vs " + print(level, p));
                    CompoundTag want = WorldBlocks.nbtAt(level, p);
                    if (want == null ? bes.containsKey(p) : !want.equals(bes.get(p))) throw new GameTestAssertException("NBT at " + p);
                }
            }
            if (r.palette().contains("minecraft:cave_air")) throw new GameTestAssertException("cave air printed as air");
            if (v.link() < 0) throw new GameTestAssertException("unreachable");
        });
    }

    @GameTest(template = "empty", batch = "o_hashes", timeoutTicks = 100)
    public static void sectionHashesMatchAPerPositionReading(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        Box work = box(h, 0, 0, 0, 2, 2, 2);
        link(h, work);
        put(level, h.absolutePos(new BlockPos(1, 1, 1)), "minecraft:furnace[facing=north,lit=true]", snbt("{id:\"minecraft:furnace\",BurnTime:99s}"));
        put(level, h.absolutePos(new BlockPos(0, 1, 1)), "minecraft:stone", null);
        List<Box> boxes = List.of(work, work.grow(3));
        TestExchange ex = hashes(new Messages.HashesRequest(WorldTestKit.nextId(), dim(h), boxes));
        await(h, ex, () -> {
            Messages.HashesResult r;
            try {
                r = Messages.HashesResult.decode(ex.reply);
            } catch (ProtocolException e) {
                throw new GameTestAssertException("bad hashes frame: " + ex.errorCode);
            }
            VolatileKeys keys = PatchGameTests.defaults();
            List<Messages.SectionHash> want = new ArrayList<>();
            java.util.TreeSet<String> seen = new java.util.TreeSet<>();
            List<int[]> secs = new ArrayList<>();
            for (Box b : boxes) for (int sy = b.minY() >> 4; sy <= b.maxY() >> 4; sy++) for (int sz = b.minZ() >> 4; sz <= b.maxZ() >> 4; sz++) for (int sx = b.minX() >> 4; sx <= b.maxX() >> 4; sx++)
                if (seen.add(sx + "," + sy + "," + sz)) secs.add(new int[] {sx, sy, sz});
            secs.sort((a, c) -> a[1] != c[1] ? Integer.compare(a[1], c[1]) : a[2] != c[2] ? Integer.compare(a[2], c[2]) : Integer.compare(a[0], c[0]));
            for (int[] s : secs) {
                Hashing.SectionHasher hs = new Hashing.SectionHasher();
                for (int y = s[1] * 16; y < s[1] * 16 + 16; y++) for (int z = s[2] * 16; z < s[2] * 16 + 16; z++) for (int x = s[0] * 16; x < s[0] * 16 + 16; x++) {
                    boolean in = false;
                    for (Box b : boxes) in |= b.contains(x, y, z);
                    if (!in) continue;
                    BlockPos p = new BlockPos(x, y, z);
                    CompoundTag nbt = WorldBlocks.nbtAt(level, p);
                    hs.add(States.print(WorldBlocks.state(level, p)), nbt == null ? null : Hashing.nbtHash(nbt, keys));
                }
                want.add(new Messages.SectionHash(s[0], s[1], s[2], hs.finish()));
            }
            if (!want.equals(r.sections())) throw new GameTestAssertException("section hashes differ: " + r.sections() + " vs " + want);
        });
    }

    @GameTest(template = "empty", batch = "o_readerrors", timeoutTicks = 100)
    public static void readsOutsideTheVolumesAreRefused(GameTestHelper h) {
        Box work = box(h, 0, 0, 0, 2, 2, 2);
        unlink();
        TestExchange none = hashes(new Messages.HashesRequest(1, dim(h), List.of(work)));
        if (none.errorCode == null || !none.errorCode.startsWith("no_volumes")) throw new GameTestAssertException("no_volumes: " + none.errorCode);
        link(h, work);
        TestExchange dimEx = snapshot(new Messages.SnapshotRequest(2, "minecraft:the_nether", List.of(work), null));
        if (dimEx.errorCode == null || !dimEx.errorCode.startsWith("wrong_dimension")) throw new GameTestAssertException("wrong_dimension: " + dimEx.errorCode);
        Box far = new Box(work.minX() + 1000, work.minY(), work.minZ(), work.maxX() + 1000, work.maxY(), work.maxZ());
        TestExchange out = snapshot(new Messages.SnapshotRequest(3, dim(h), List.of(far), null));
        if (out.errorCode == null || !out.errorCode.startsWith("outside_volumes")) throw new GameTestAssertException("outside_volumes: " + out.errorCode);
        // A whole section reaching above the build height reads as air.
        int topSection = h.getLevel().getMaxSection();
        TestExchange high = snapshot(new Messages.SnapshotRequest(4, dim(h), null, List.of(new Messages.Section(work.minX() >> 4, topSection, work.minZ() >> 4))));
        await(h, high, () -> {
            try {
                Messages.SnapshotResult r = Messages.SnapshotResult.decode(high.reply);
                if (!r.palette().equals(List.of("minecraft:air"))) throw new GameTestAssertException("above build height reads as air: " + r.palette());
            } catch (ProtocolException e) {
                throw new GameTestAssertException(high.errorCode);
            }
        });
    }

    /**
     * Measurements for 13's open questions: write cost per block (and so how many blocks fit a
     * 50 ms tick) and snapshot time per million blocks, logged as "Autosketch measure".
     */
    @GameTest(template = "empty", batch = "o_measure", timeoutTicks = 200_000)
    public static void measureThroughputAndSnapshotCost(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        BlockPos base = h.absolutePos(new BlockPos(0, 10, 0));
        Box work = Box.of(base, base.offset(99, 99, 99)); // 1,000,000 blocks
        LinkVolumes v = link(h, work);
        WorldModule.budgetOverride = 2_000_000;
        long savedTickNanos = dev.autosketch.mod.world.PatchApplier.tickNanos;
        dev.autosketch.mod.world.PatchApplier.tickNanos = Long.MAX_VALUE; // measure raw write cost
        // Warm up chunks and caches.
        for (int x = 0; x < 100; x += 16) for (int z = 0; z < 100; z += 16) level.getChunkAt(base.offset(x, 0, z));
        List<PatchBlock> fill = new ArrayList<>(200_000);
        for (int y = 0; y < 20; y++) for (int z = 0; z < 100; z++) for (int x = 0; x < 100; x++) {
            BlockPos p = base.offset(x, y, z);
            fill.add(new PatchBlock(p, print(level, p), (x + z) % 7 == 0 ? "minecraft:glowstone" : "minecraft:stone", null, null));
        }
        long t0 = System.nanoTime();
        Messages.PatchAck ack = WorldTestKit.patch(v, fill).ack();
        long writeNs = System.nanoTime() - t0;
        List<PatchBlock> chests = new ArrayList<>(10_000);
        for (int z = 0; z < 100; z++) for (int x = 0; x < 100; x++) {
            BlockPos p = base.offset(x, 20, z);
            chests.add(new PatchBlock(p, print(level, p), "minecraft:chest[facing=north,type=single,waterlogged=false]", null, snbt("{id:\"minecraft:chest\",Items:[{Slot:0b,count:1,id:\"minecraft:apple\"}]}")));
        }
        long t1 = System.nanoTime();
        Messages.PatchAck ack2 = WorldTestKit.patch(v, chests).ack();
        long chestNs = System.nanoTime() - t1;
        double perBlock = writeNs / (double) fill.size(), perChest = chestNs / (double) chests.size();
        LOG.info("Autosketch measure: patch of {} blocks (stone/glowstone over air) applied {} in {} ms: {} us/block, about {} blocks per 50 ms tick",
                fill.size(), ack.applied(), writeNs / 1_000_000, String.format("%.2f", perBlock / 1000), (long) (50_000_000 / perBlock));
        LOG.info("Autosketch measure: {} chests with NBT applied {} in {} ms: {} us/block, about {} per 50 ms tick",
                chests.size(), ack2.applied(), chestNs / 1_000_000, String.format("%.2f", perChest / 1000), (long) (50_000_000 / perChest));

        dev.autosketch.mod.world.PatchApplier.tickNanos = savedTickNanos;
        long s0 = System.nanoTime();
        TestExchange snap = snapshot(new Messages.SnapshotRequest(WorldTestKit.nextId(), dim(h), List.of(work), null));
        long startTick = level.getServer().getTickCount();
        TestExchange[] hs = {null};
        long[] h0 = {0};
        h.succeedWhen(() -> {
            if (!snap.done) throw new GameTestAssertException("waiting for the snapshot");
            if (snap.errorCode != null) throw new GameTestAssertException(snap.errorCode);
            if (hs[0] == null) {
                dev.autosketch.mod.world.WorldReads.ReadStats st = dev.autosketch.mod.world.WorldReads.lastRead;
                LOG.info("Autosketch measure: snapshot of 1,000,000 blocks ({} bytes) in {} ms wall: {} sections copied over {} ticks, {} ms on the server thread, {} ms encoding off-thread",
                        snap.reply.body().length, (System.nanoTime() - s0) / 1_000_000, st.sections(), st.ticks(), st.serverNanos() / 1_000_000, st.offThreadNanos() / 1_000_000);
                h0[0] = System.nanoTime();
                hs[0] = hashes(new Messages.HashesRequest(WorldTestKit.nextId(), dim(h), List.of(work)));
                throw new GameTestAssertException("waiting for the hashes");
            }
            if (!hs[0].done) throw new GameTestAssertException("waiting for the hashes");
            dev.autosketch.mod.world.WorldReads.ReadStats st = dev.autosketch.mod.world.WorldReads.lastRead;
            LOG.info("Autosketch measure: section hashes of 1,000,000 blocks in {} ms wall: {} ms on the server thread over {} ticks, {} ms hashing off-thread",
                    (System.nanoTime() - h0[0]) / 1_000_000, st.serverNanos() / 1_000_000, st.ticks(), st.offThreadNanos() / 1_000_000);
            List<PatchBlock> clear = new ArrayList<>();
            for (PatchBlock b : fill) clear.add(new PatchBlock(b.pos(), b.state(), "minecraft:air", null, null));
            for (PatchBlock b : chests) clear.add(new PatchBlock(b.pos(), b.state(), "minecraft:air", Hashing.nbtHash(WorldBlocks.nbtAt(level, b.pos()), PatchGameTests.defaults()), null));
            WorldTestKit.patch(v, clear);
            unlink();
        });
    }
}
