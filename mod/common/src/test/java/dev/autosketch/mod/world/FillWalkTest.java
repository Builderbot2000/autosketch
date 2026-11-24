package dev.autosketch.mod.world;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages.ChunkXZ;
import dev.autosketch.mod.protocol.SelectMessages.ExpandBy;
import dev.autosketch.mod.protocol.SelectMessages.FillResult;
import dev.autosketch.mod.protocol.SelectMessages.FrontierSection;
import dev.autosketch.mod.protocol.SelectMessages.MaskSection;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.ChunkPos;
import org.junit.jupiter.api.Test;

/**
 * The fill and expand, mod side (18, pieces 3 and 4, *Testing*): parity with the fake host's answers
 * recorded in {@code test/data/select/fill-parity.json} (whose complete fills the TypeScript side checks
 * against {@code {connected}} at 6, 18 and 26), the same answers when every chunk read waits a tick and
 * the run is cut into one-neighbour slices, frontier detection, and the mask encoding.
 */
class FillWalkTest {
    static JsonObject fixture() throws IOException {
        String golden = System.getProperty("autosketch.goldenDir");
        if (golden == null) throw new IllegalStateException("autosketch.goldenDir is not set (run the tests through Gradle)");
        return JsonParser.parseString(Files.readString(Path.of(golden).resolveSibling("select").resolve("fill-parity.json"))).getAsJsonObject();
    }

    /** The fixture's world: its cells at its origin, air elsewhere; {@code missing} chunks never generated. */
    static final class World implements FillWalk.Blocks {
        final int ox, oy, oz, sx, sy, sz;
        final String cells;
        final Set<Long> missing = new HashSet<>();
        final Set<String> ids = new HashSet<>();
        boolean solid;
        /** Chunks read so far; with {@code slow}, the first ask of each chunk waits. */
        final Set<Long> read = new HashSet<>();
        boolean slow;
        int waits;

        World(JsonObject f) {
            JsonArray o = f.getAsJsonArray("origin"), s = f.getAsJsonArray("size");
            ox = o.get(0).getAsInt();
            oy = o.get(1).getAsInt();
            oz = o.get(2).getAsInt();
            sx = s.get(0).getAsInt();
            sy = s.get(1).getAsInt();
            sz = s.get(2).getAsInt();
            cells = f.get("cells").getAsString();
        }

        String at(int x, int y, int z) {
            int lx = x - ox, ly = y - oy, lz = z - oz;
            if (lx < 0 || ly < 0 || lz < 0 || lx >= sx || ly >= sy || lz >= sz) return "minecraft:air";
            return switch (cells.charAt(lx + sx * (lz + sz * ly))) {
                case 'b' -> "minecraft:stone_bricks";
                case 'm' -> "minecraft:mossy_stone_bricks";
                default -> "minecraft:air";
            };
        }

        @Override
        public int column(int cx, int cz) {
            long k = ChunkPos.asLong(cx, cz);
            if (slow && read.add(k)) {
                waits++;
                return FillWalk.WAIT;
            }
            return missing.contains(k) ? FillWalk.MISSING : FillWalk.READY;
        }

        @Override
        public int matches(int x, int y, int z) {
            String s = at(x, y, z);
            return (solid && !s.equals("minecraft:air")) || ids.contains(s) ? 1 : 0;
        }
    }

    static ExpandBy expandBy(JsonElement e) {
        if (e.isJsonPrimitive()) return ExpandBy.FRONTIER;
        JsonObject o = e.getAsJsonObject();
        if (o.has("box")) {
            JsonObject b = o.getAsJsonObject("box");
            JsonArray mn = b.getAsJsonArray("min"), mx = b.getAsJsonArray("max");
            return new ExpandBy(null, 0, new Box(mn.get(0).getAsInt(), mn.get(1).getAsInt(), mn.get(2).getAsInt(), mx.get(0).getAsInt(), mx.get(1).getAsInt(), mx.get(2).getAsInt()));
        }
        return new ExpandBy(o.get("direction").getAsString(), o.get("chunks").getAsInt(), null);
    }

    /** An answer in the fixture's canonical form. */
    static JsonObject canonical(FillResult r) {
        JsonObject o = new JsonObject();
        o.addProperty("count", r.count());
        if (r.box() == null) o.add("box", JsonNull.INSTANCE);
        else {
            JsonObject b = new JsonObject();
            b.add("min", ints(r.box().minX(), r.box().minY(), r.box().minZ()));
            b.add("max", ints(r.box().maxX(), r.box().maxY(), r.box().maxZ()));
            o.add("box", b);
        }
        o.addProperty("stopped", r.stopped());
        o.addProperty("delta", r.delta());
        JsonArray miss = new JsonArray();
        for (ChunkXZ c : r.missing()) miss.add(ints(c.cx(), c.cz()));
        o.add("missing", miss);
        JsonArray secs = new JsonArray();
        for (MaskSection s : r.sections()) {
            JsonArray a = ints(s.sx(), s.sy(), s.sz());
            a.add(s.full() ? "full" : Base64.getEncoder().encodeToString(s.mask()));
            secs.add(a);
        }
        o.add("sections", secs);
        JsonArray fr = new JsonArray();
        for (FrontierSection s : r.frontier()) {
            JsonArray a = ints(s.sx(), s.sy(), s.sz());
            a.add(ints(s.index()));
            a.add(ints(s.faces()));
            fr.add(a);
        }
        o.add("frontier", fr);
        return o;
    }

    static JsonArray ints(int... v) {
        JsonArray a = new JsonArray();
        for (int i : v) a.add(i);
        return a;
    }

    /** Runs a scenario's steps, each to its end, slicing with {@code timeUp}; the answers in canonical form. */
    static List<JsonObject> run(JsonObject sc, World w, java.util.function.BooleanSupplier timeUp, int[] slices) {
        w.ids.clear();
        w.solid = false;
        for (JsonElement m : sc.getAsJsonArray("match")) {
            if (m.getAsString().equals("solid")) w.solid = true;
            else w.ids.add(m.getAsString());
        }
        w.missing.clear();
        for (JsonElement c : sc.getAsJsonArray("missing")) w.missing.add(ChunkPos.asLong(c.getAsJsonArray().get(0).getAsInt(), c.getAsJsonArray().get(1).getAsInt()));
        JsonObject g = sc.getAsJsonObject("grant");
        int gx = g.getAsJsonArray("centre").get(0).getAsInt(), gz = g.getAsJsonArray("centre").get(1).getAsInt(), gr = g.get("radius").getAsInt();
        JsonArray seed = sc.getAsJsonArray("seed");
        FillWalk f = new FillWalk(new BlockPos(seed.get(0).getAsInt(), seed.get(1).getAsInt(), seed.get(2).getAsInt()), sc.get("connectivity").getAsInt(), sc.get("area").getAsInt(),
                k -> Math.max(Math.abs(ChunkPos.getX(k) - gx), Math.abs(ChunkPos.getZ(k) - gz)) <= gr, -64, 319);
        List<JsonObject> out = new ArrayList<>();
        JsonArray steps = sc.getAsJsonArray("steps");
        for (int i = 0; i < steps.size(); i++) {
            JsonObject s = steps.get(i).getAsJsonObject();
            if (i > 0) f.expand(expandBy(s.get("expand")));
            f.begin(s.has("budget") ? s.get("budget").getAsLong() : 4_194_304L);
            while (!f.step(w, timeUp)) slices[0]++;
            FillResult r = f.result(i + 1, "minecraft:overworld", i > 0, w.missing::contains);
            out.add(canonical(r));
        }
        return out;
    }

    @Test
    void matchesTheFakeHostOnEveryScenario() throws IOException {
        JsonObject fx = fixture();
        World w = new World(fx);
        for (JsonElement e : fx.getAsJsonArray("scenarios")) {
            JsonObject sc = e.getAsJsonObject();
            List<JsonObject> got = run(sc, w, () -> false, new int[1]);
            JsonArray want = sc.getAsJsonArray("answers");
            assertEquals(want.size(), got.size(), sc.get("name").getAsString());
            for (int i = 0; i < got.size(); i++) assertEquals(want.get(i), got.get(i), sc.get("name").getAsString() + " step " + i);
        }
    }

    @Test
    void slicedRunsAndWaitingChunksGiveTheSameAnswers() throws IOException {
        JsonObject fx = fixture();
        World w = new World(fx);
        w.slow = true;
        for (JsonElement e : fx.getAsJsonArray("scenarios")) {
            JsonObject sc = e.getAsJsonObject();
            w.read.clear();
            int[] slices = {0};
            AtomicInteger n = new AtomicInteger();
            // Time is up at every other check: a run is cut into slices of a few hundred neighbours.
            List<JsonObject> got = run(sc, w, () -> n.incrementAndGet() % 2 == 0, slices);
            JsonArray want = sc.getAsJsonArray("answers");
            for (int i = 0; i < got.size(); i++) assertEquals(want.get(i), got.get(i), sc.get("name").getAsString() + " sliced, step " + i);
            if (sc.getAsJsonArray("answers").get(0).getAsJsonObject().get("count").getAsLong() > 1000) assertTrue(slices[0] > 2, sc.get("name") + " was sliced: " + slices[0]);
        }
        assertTrue(w.waits > 0);
    }

    /** A wall from chunk 0 into chunk 2, as the TypeScript protocol test: edge, frontier faces, expand by frontier and east. */
    @Test
    void frontierAtTheAreaEdgeAndTheBudget() {
        World w = new World(wall());
        w.ids.add("minecraft:stone_bricks");
        FillWalk f = new FillWalk(new BlockPos(3, 64, 5), 6, 0, k -> true, -64, 319);
        f.begin(1_000_000);
        assertTrue(f.step(w, () -> false));
        FillResult r = f.result(1, "minecraft:overworld", false, k -> false);
        assertEquals(16, r.count());
        assertEquals("edge", r.stopped());
        assertEquals(new Box(0, 64, 5, 15, 64, 5), r.box());
        assertEquals(1, r.frontier().size());
        FrontierSection fs = r.frontier().get(0);
        assertEquals(List.of(0, 4, 0), List.of(fs.sx(), fs.sy(), fs.sz()));
        assertEquals("[80, 95] [16, 32]", java.util.Arrays.toString(fs.index()) + " " + java.util.Arrays.toString(fs.faces()));
        f.expand(ExpandBy.FRONTIER);
        f.begin(1_000_000);
        assertTrue(f.step(w, () -> false));
        r = f.result(2, "minecraft:overworld", true, k -> false);
        assertEquals(32, r.count());
        assertEquals(1, r.sections().size());
        assertEquals(1, r.sections().get(0).sx());
        assertEquals("[95] [32]", java.util.Arrays.toString(r.frontier().get(0).index()) + " " + java.util.Arrays.toString(r.frontier().get(0).faces()));
        f.expand(new ExpandBy("east", 1, null));
        f.begin(1_000_000);
        assertTrue(f.step(w, () -> false));
        r = f.result(3, "minecraft:overworld", true, k -> false);
        assertEquals(40, r.count());
        assertEquals("complete", r.stopped());
        assertTrue(r.frontier().isEmpty());

        // The budget counts the seed; the frontier is the position it stopped at, every unexplored side.
        FillWalk b = new FillWalk(new BlockPos(0, 64, 5), 6, 1, k -> true, -64, 319);
        b.begin(3);
        assertTrue(b.step(w, () -> false));
        r = b.result(1, "minecraft:overworld", false, k -> false);
        assertEquals(3, r.count());
        assertEquals("budget", r.stopped());
        assertEquals("[82] [47]", java.util.Arrays.toString(r.frontier().get(0).index()) + " " + java.util.Arrays.toString(r.frontier().get(0).faces()));
    }

    /** A 40-block wall at y 64, z 5, x 0 to 39. */
    static JsonObject wall() {
        JsonObject o = new JsonObject();
        o.add("origin", ints(0, 64, 5));
        o.add("size", ints(40, 1, 1));
        o.addProperty("cells", "b".repeat(40));
        return o;
    }

    /** Masks: bit x + 16·(z + 16·y), least significant first; a whole section is sent as "full" and encodes as kind 0. */
    @Test
    void maskEncoding() throws Exception {
        World w = new World(cube());
        w.ids.add("minecraft:stone_bricks");
        FillWalk f = new FillWalk(new BlockPos(0, 0, 0), 6, 0, k -> true, -64, 319);
        f.begin(1_000_000);
        assertTrue(f.step(w, () -> false));
        FillResult r = f.result(7, "minecraft:overworld", false, k -> false);
        assertEquals(4096 + 1, r.count());
        assertEquals(2, r.sections().size());
        assertTrue(r.sections().get(0).full(), "the full section first (sy 0)");
        byte[] m = r.sections().get(1).mask();
        // The one block above: (0, 16, 0) → local index 0 of section (0, 1, 0).
        assertEquals(1, m[0]);
        for (int i = 1; i < 512; i++) assertEquals(0, m[i]);
        Frame frame = r.encode();
        FillResult back = FillResult.decode(frame);
        assertEquals(canonical(r), canonical(back));
    }

    /** A whole section (0..15 cubed) of bricks and one block on top. */
    static JsonObject cube() {
        JsonObject o = new JsonObject();
        o.add("origin", ints(0, 0, 0));
        o.add("size", ints(16, 17, 16));
        o.addProperty("cells", "b".repeat(4096) + "b" + ".".repeat(255));
        return o;
    }
}
