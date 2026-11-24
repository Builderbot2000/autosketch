package dev.autosketch.mod.gametest.world;

import static dev.autosketch.mod.gametest.world.WorldTestKit.dim;
import static dev.autosketch.mod.gametest.world.WorldTestKit.nextId;
import static dev.autosketch.mod.gametest.world.WorldTestKit.put;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.gametest.world.WorldTestKit.TestExchange;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Messages.ChunkXZ;
import dev.autosketch.mod.protocol.ProtocolException;
import dev.autosketch.mod.protocol.SelectMessages;
import dev.autosketch.mod.protocol.SelectMessages.ExpandBy;
import dev.autosketch.mod.protocol.SelectMessages.FillResult;
import dev.autosketch.mod.protocol.SelectMessages.FrontierSection;
import dev.autosketch.mod.protocol.SelectMessages.MaskSection;
import dev.autosketch.mod.world.ScanGrants;
import dev.autosketch.mod.world.SelectGrants;
import dev.autosketch.mod.world.WorldFill;
import dev.autosketch.mod.world.WorldModule;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Supplier;
import net.minecraft.core.BlockPos;
import net.minecraft.gametest.framework.GameTest;
import net.minecraft.gametest.framework.GameTestAssertException;
import net.minecraft.gametest.framework.GameTestHelper;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.neoforged.neoforge.gametest.GameTestHolder;
import net.neoforged.neoforge.gametest.PrefixGameTestTemplate;
import org.slf4j.Logger;

/**
 * Fill and expand, mod side (18, pieces 3 and 4, *Testing*): the fake host's recorded answers
 * ({@code test/data/select/fill-parity.json}) replayed on the same blocks in the world, across chunk
 * edges and sliced over ticks; a fill growing through chunks read from disk and stopping at an
 * ungenerated one; and the refusals. Each test works in a far, random area. Handlers are called
 * directly: the mod lists the feature {@code select} only from M3.
 */
@GameTestHolder(Autosketch.MOD_ID)
@PrefixGameTestTemplate(false)
public final class FillGameTests {
    private FillGameTests() {}

    private static final Logger LOG = LogUtils.getLogger();
    static final String BRICK = "minecraft:stone_bricks";

    static TestExchange fill(SelectMessages.FillRequest req) {
        TestExchange ex = new TestExchange(req.id());
        try {
            WorldModule.fills().fill(SelectMessages.FillRequest.decode(req.encode()), ex);
        } catch (ProtocolException e) {
            ex.error(e.code(), e.getMessage());
        }
        return ex;
    }

    static TestExchange expand(SelectMessages.ExpandRequest req) {
        TestExchange ex = new TestExchange(req.id());
        try {
            WorldModule.fills().expand(SelectMessages.ExpandRequest.decode(req.encode()), ex);
        } catch (ProtocolException e) {
            ex.error(e.code(), e.getMessage());
        }
        return ex;
    }

    static FillResult result(TestExchange ex) {
        if (ex.errorCode != null) throw new GameTestAssertException("refused: " + ex.errorCode);
        try {
            return FillResult.decode(ex.reply);
        } catch (ProtocolException e) {
            throw new GameTestAssertException("undecodable fill result: " + e.getMessage());
        }
    }

    static void logFill(String what) {
        LOG.info("Autosketch fill timing ({}): {}", what, WorldFill.lastFill);
    }

    /**
     * Requests one after another, one per finished reply, polled each tick: each step sends its
     * request and the next checks the reply. A failed check fails the test at once.
     */
    static final class Steps {
        final List<Supplier<TestExchange>> sends = new ArrayList<>();
        final List<Consumer<TestExchange>> checks = new ArrayList<>();

        Steps then(Supplier<TestExchange> send, Consumer<TestExchange> check) {
            sends.add(send);
            checks.add(check);
            return this;
        }

        void run(GameTestHelper h, Runnable cleanup) {
            int[] at = {-1};
            TestExchange[] cur = {null};
            String[] failed = {null};
            h.onEachTick(() -> {
                if (failed[0] != null) return;
                try {
                    if (cur[0] != null && !cur[0].done) return;
                    if (cur[0] != null) checks.get(at[0]).accept(cur[0]);
                    if (++at[0] == sends.size()) {
                        cleanup.run();
                        h.succeed();
                        failed[0] = "";
                        return;
                    }
                    cur[0] = sends.get(at[0]).get();
                } catch (RuntimeException e) {
                    failed[0] = String.valueOf(e.getMessage());
                    cleanup.run();
                    h.fail("step " + at[0] + ": " + e.getMessage());
                }
            });
        }
    }

    // ── parity with the fake host ─────────────────────────────────────────────────────────────

    static JsonObject fixture() {
        String p = System.getProperty("autosketch.fillParity");
        if (p == null) throw new GameTestAssertException("autosketch.fillParity is not set (run through runGameTestServer)");
        try {
            return JsonParser.parseString(Files.readString(Path.of(p))).getAsJsonObject();
        } catch (IOException e) {
            throw new GameTestAssertException("can't read the fill parity fixture: " + e);
        }
    }

    static JsonArray ints(int... v) {
        JsonArray a = new JsonArray();
        for (int i : v) a.add(i);
        return a;
    }

    /** An answer in the fixture's canonical form, moved back by {@code cx}, {@code cz} chunks. */
    static JsonObject canonical(FillResult r, int cx, int cz) {
        int bx = cx << 4, bz = cz << 4;
        JsonObject o = new JsonObject();
        o.addProperty("count", r.count());
        if (r.box() == null) o.add("box", JsonNull.INSTANCE);
        else {
            JsonObject b = new JsonObject();
            b.add("min", ints(r.box().minX() - bx, r.box().minY(), r.box().minZ() - bz));
            b.add("max", ints(r.box().maxX() - bx, r.box().maxY(), r.box().maxZ() - bz));
            o.add("box", b);
        }
        o.addProperty("stopped", r.stopped());
        o.addProperty("delta", r.delta());
        JsonArray miss = new JsonArray();
        for (ChunkXZ c : r.missing()) miss.add(ints(c.cx() - cx, c.cz() - cz));
        o.add("missing", miss);
        JsonArray secs = new JsonArray();
        for (MaskSection s : r.sections()) {
            JsonArray a = ints(s.sx() - cx, s.sy(), s.sz() - cz);
            a.add(s.full() ? "full" : Base64.getEncoder().encodeToString(s.mask()));
            secs.add(a);
        }
        o.add("sections", secs);
        JsonArray fr = new JsonArray();
        for (FrontierSection s : r.frontier()) {
            JsonArray a = ints(s.sx() - cx, s.sy(), s.sz() - cz);
            a.add(ints(s.index()));
            a.add(ints(s.faces()));
            fr.add(a);
        }
        o.add("frontier", fr);
        return o;
    }

    static ExpandBy expandBy(JsonElement e, int cx, int cz) {
        if (e.isJsonPrimitive()) return ExpandBy.FRONTIER;
        JsonObject o = e.getAsJsonObject();
        if (o.has("box")) {
            JsonObject b = o.getAsJsonObject("box");
            JsonArray mn = b.getAsJsonArray("min"), mx = b.getAsJsonArray("max");
            return new ExpandBy(null, 0, new Box(mn.get(0).getAsInt() + (cx << 4), mn.get(1).getAsInt(), mn.get(2).getAsInt() + (cz << 4), mx.get(0).getAsInt() + (cx << 4),
                    mx.get(1).getAsInt(), mx.get(2).getAsInt() + (cz << 4)));
        }
        return new ExpandBy(o.get("direction").getAsString(), o.get("chunks").getAsInt(), null);
    }

    /**
     * The fixture's blob (about 3,800 bricks and mossy bricks over four chunks) built in a far area
     * of generated chunks, moved by whole chunks so its chunk edges stay where the fake host had them,
     * and every scenario without ungenerated chunks replayed: each answer, moved back, must equal the
     * fake host's, with the walk cut into slices of a few hundred neighbours per tick.
     */
    @GameTest(template = "empty", batch = "y_select_fill_parity", timeoutTicks = 6000)
    public static void fillMatchesTheFakeHost(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        JsonObject fx = fixture();
        int[] f = SelectGameTests.farChunk();
        int cx = f[0], cz = f[1];
        JsonArray o = fx.getAsJsonArray("origin"), sz = fx.getAsJsonArray("size");
        int ox = o.get(0).getAsInt() + (cx << 4), oy = o.get(1).getAsInt(), oz = o.get(2).getAsInt() + (cz << 4);
        int nx = sz.get(0).getAsInt(), ny = sz.get(1).getAsInt(), nz = sz.get(2).getAsInt();
        String cells = fx.get("cells").getAsString();
        // Every chunk the scenarios' areas reach is generated (the fixture lists none missing there) and
        // kept loaded, so none is caught between unloading and being saved (reading from disk is
        // fillReadsSavedChunksAndStopsAtUngenerated's).
        for (int dz = -4; dz <= 4; dz++)
            for (int dx = -5; dx <= 5; dx++) {
                level.getChunk(cx + dx, cz + dz);
                level.setChunkForced(cx + dx, cz + dz, true);
            }
        BlockState air = Blocks.AIR.defaultBlockState(), brick = Blocks.STONE_BRICKS.defaultBlockState(), mossy = Blocks.MOSSY_STONE_BRICKS.defaultBlockState();
        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos();
        // The blob and an air shell around it, so nothing the world generated touches it.
        for (int y = -1; y <= ny; y++)
            for (int z = -1; z <= nz; z++)
                for (int x = -1; x <= nx; x++) {
                    boolean in = x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz;
                    char c = in ? cells.charAt(x + nx * (z + nz * y)) : '.';
                    level.setBlock(p.set(ox + x, oy + y, oz + z), c == 'b' ? brick : c == 'm' ? mossy : air, Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE);
                }
        long slice = WorldFill.sliceNanos;
        WorldFill.sliceNanos = 1;
        Steps steps = new Steps();
        int replayed = 0;
        for (JsonElement e : fx.getAsJsonArray("scenarios")) {
            JsonObject sc = e.getAsJsonObject();
            if (!sc.getAsJsonArray("missing").isEmpty()) continue; // the ungenerated case is fillStopsAtUngeneratedChunks
            replayed++;
            String name = sc.get("name").getAsString();
            JsonObject g = sc.getAsJsonObject("grant");
            BlockPos centre = new BlockPos((g.getAsJsonArray("centre").get(0).getAsInt() + cx) << 4, 64, (g.getAsJsonArray("centre").get(1).getAsInt() + cz) << 4);
            int radius = g.get("radius").getAsInt();
            JsonArray seed = sc.getAsJsonArray("seed");
            BlockPos s = new BlockPos(seed.get(0).getAsInt() + (cx << 4), seed.get(1).getAsInt(), seed.get(2).getAsInt() + (cz << 4));
            List<String> match = new ArrayList<>();
            for (JsonElement m : sc.getAsJsonArray("match")) match.add(m.getAsString());
            JsonArray st = sc.getAsJsonArray("steps"), answers = sc.getAsJsonArray("answers");
            for (int i = 0; i < st.size(); i++) {
                JsonObject step = st.get(i).getAsJsonObject();
                Long budget = step.has("budget") ? step.get("budget").getAsLong() : null;
                JsonObject want = answers.get(i).getAsJsonObject();
                int k = i;
                Supplier<TestExchange> send = i == 0
                        ? () -> {
                            SelectGrants.set(level.dimension(), centre, radius);
                            return fill(new SelectMessages.FillRequest(nextId(), dim(h), s, match, sc.get("connectivity").getAsInt(), budget, sc.get("area").getAsInt()));
                        }
                        : () -> expand(new SelectMessages.ExpandRequest(nextId(), dim(h), expandBy(step.get("expand"), cx, cz), budget));
                steps.then(send, ex -> {
                    logFill(name + " step " + k);
                    JsonObject got = canonical(result(ex), cx, cz);
                    if (!got.equals(want)) throw new GameTestAssertException(name + " step " + k + " differs from the fake host's:\n  got  " + got + "\n  want " + want);
                    WorldFill.Stats stats = WorldFill.lastFill;
                    if (stats != null && stats.added() > 2000 && stats.ticks() < 2) throw new GameTestAssertException(name + " step " + k + " wasn't sliced: " + stats);
                });
            }
        }
        if (replayed < 6) throw new GameTestAssertException("expected at least six scenarios, got " + replayed);
        steps.run(h, () -> {
            WorldFill.sliceNanos = slice;
            SelectGrants.clear();
            for (int dz = -4; dz <= 4; dz++) for (int dx = -5; dx <= 5; dx++) level.setChunkForced(cx + dx, cz + dz, false);
        });
    }

    // ── chunks from disk, ungenerated chunks, budgets ─────────────────────────────────────────

    /**
     * A wall at y 70 from chunk A into B and C, all three generated, saved and unloaded; D east of C
     * never generated. A fill in A alone stops at its edge; expanding east grows
     * the area to D and resumes through B and C read from disk (nothing loaded or generated), cut by a
     * budget of 20; expanding by the frontier finishes at D, which is listed and stops the fill like a
     * non-matching block.
     */
    @GameTest(template = "empty", batch = "y_select_fill_disk", timeoutTicks = 2400)
    public static void fillReadsSavedChunksAndStopsAtUngenerated(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        int[] f = SelectGameTests.farChunk();
        int cx = f[0], cz = f[1];
        for (int i = 0; i < 3; i++) level.getChunk(cx + i, cz);
        int x0 = (cx << 4) + 3, x1 = ((cx + 3) << 4) - 1, z = (cz << 4) + 5;
        for (int x = x0; x <= x1; x++) put(level, new BlockPos(x, 70, z), BRICK, null);
        level.getChunkSource().save(true);
        long slice = WorldFill.sliceNanos;
        Runnable cleanup = () -> {
            WorldFill.sliceNanos = slice;
            SelectGrants.clear();
        };
        ChunkXZ d = new ChunkXZ(cx + 3, cz);
        Steps steps = new Steps()
                .then(() -> {
                    SelectGrants.set(level.dimension(), new BlockPos(x0, 70, z), 8);
                    return fill(new SelectMessages.FillRequest(nextId(), dim(h), new BlockPos(x0, 70, z), List.of(BRICK), 6, null, 0));
                }, ex -> {
                    logFill("chunk A alone");
                    FillResult r = result(ex);
                    check(r.count() == 13 && r.stopped().equals("edge") && r.missing().isEmpty(), "A's 13 blocks, cut at its east edge: " + r.count() + " " + r.stopped() + " " + r.missing());
                    check(r.box().equals(new Box(x0, 70, z, (cx << 4) + 15, 70, z)), "box " + r.box());
                    check(r.frontier().size() == 1 && r.frontier().get(0).index().length == 1 && r.frontier().get(0).faces()[0] == 32, "one frontier block facing east");
                })
                .then(() -> {
                    WorldFill.sliceNanos = 1;
                    return expand(new SelectMessages.ExpandRequest(nextId(), dim(h), new ExpandBy("east", 3, null), 20L));
                }, ex -> {
                    logFill("east 3, budget 20, from disk");
                    FillResult r = result(ex);
                    check(r.delta() && r.count() == 33 && r.stopped().equals("budget"), "20 more, cut by the budget: " + r.count() + " " + r.stopped());
                    check(r.missing().equals(List.of(d)), "D is listed: " + r.missing());
                    check(r.sections().size() == 2 && r.sections().get(0).sx() == cx + 1 && r.sections().get(1).sx() == cx + 2, "B and C changed: " + r.sections().size());
                    WorldFill.Stats s = WorldFill.lastFill;
                    check(s != null && s.disk() >= 2 && s.fallback() == 0 && s.missing() >= 1, "B and C read from disk: " + s);
                })
                .then(() -> expand(new SelectMessages.ExpandRequest(nextId(), dim(h), ExpandBy.FRONTIER, null)), ex -> {
                    logFill("frontier, to the ungenerated chunk");
                    FillResult r = result(ex);
                    check(r.count() == x1 - x0 + 1 && r.stopped().equals("complete") && r.frontier().isEmpty(), "the whole wall, complete: " + r.count() + " " + r.stopped());
                    check(r.box().equals(new Box(x0, 70, z, x1, 70, z)), "box " + r.box());
                    check(r.missing().equals(List.of(d)), "D is listed: " + r.missing());
                    check(level.getChunkSource().getChunkNow(cx + 1, cz) == null && level.getChunkSource().getChunkNow(cx + 2, cz) == null, "B and C were read without loading them");
                    check(s(WorldFill.lastFill).loaded() == 0, "nothing loaded: " + WorldFill.lastFill);
                    check(level.getChunkSource().getChunkNow(cx + 3, cz) == null, "D wasn't generated");
                });
        h.startSequence()
                .thenWaitUntil(() -> {
                    for (int i = 0; i < 3; i++)
                        if (level.getChunkSource().getChunkNow(cx + i, cz) != null) throw new GameTestAssertException("waiting for chunk " + (cx + i) + "," + cz + " to unload");
                })
                .thenExecute(() -> steps.run(h, cleanup));
    }

    static WorldFill.Stats s(WorldFill.@org.jetbrains.annotations.Nullable Stats s) {
        if (s == null) throw new GameTestAssertException("no fill stats");
        return s;
    }

    static void check(boolean ok, String what) {
        if (!ok) throw new GameTestAssertException(what);
    }

    /** {@code no_grant}, {@code wrong_dimension}, {@code outside_volumes}, {@code bad_request}; a new grant drops the fill. */
    @GameTest(template = "empty", batch = "y_select_fill_refusals", timeoutTicks = 400)
    public static void fillRefusals(GameTestHelper h) {
        ServerLevel level = h.getLevel();
        int[] f = SelectGameTests.farChunk();
        BlockPos centre = new BlockPos(f[0] << 4, 70, f[1] << 4);
        level.getChunk(f[0], f[1]);
        put(level, centre, BRICK, null);
        try {
            SelectGrants.clear();
            ScanGrants.clear();
            SelectGameTests.refusedWith(h, fill(new SelectMessages.FillRequest(nextId(), dim(h), centre, List.of(BRICK), null, null, null)), "no_grant");
            SelectGameTests.refusedWith(h, expand(new SelectMessages.ExpandRequest(nextId(), dim(h), ExpandBy.FRONTIER, null)), "no_grant");
            SelectGrants.set(level.dimension(), centre, 2);
            SelectGameTests.refusedWith(h, fill(new SelectMessages.FillRequest(nextId(), "minecraft:the_nether", centre, List.of(BRICK), null, null, null)), "wrong_dimension");
            SelectGameTests.refusedWith(h, fill(new SelectMessages.FillRequest(nextId(), dim(h), centre.east(16 * 3), List.of(BRICK), null, null, null)), "outside_volumes");
            SelectGameTests.refusedWith(h, expand(new SelectMessages.ExpandRequest(nextId(), dim(h), ExpandBy.FRONTIER, null)), "bad_request");
        } finally {
            SelectGrants.clear();
        }
        TestExchange[] ex = new TestExchange[1];
        SelectGrants.set(level.dimension(), centre, 2);
        ex[0] = fill(new SelectMessages.FillRequest(nextId(), dim(h), centre, List.of("solid"), 26, null, 0));
        h.succeedWhen(() -> {
            if (!ex[0].done) throw new GameTestAssertException("waiting for the fill");
            try {
                FillResult r = result(ex[0]);
                h.assertTrue(r.count() >= 1, "a solid fill from a brick finds it: " + r.count());
                h.assertTrue(SelectGrants.current() != null && SelectGrants.current().fill() != null, "the grant holds the fill");
                SelectGrants.set(level.dimension(), centre, 2);
                SelectGameTests.refusedWith(h, expand(new SelectMessages.ExpandRequest(nextId(), dim(h), ExpandBy.FRONTIER, null)), "bad_request");
            } finally {
                SelectGrants.clear();
            }
        });
    }
}
