package dev.autosketch.mod.world;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.autosketch.mod.protocol.Box;
import dev.autosketch.mod.protocol.SelectMessages;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * The coarse reduction, mod side (18, piece 5; 13, {@code snapshot} kind {@code coarse}): parity with
 * the fake host's answers recorded in {@code test/data/select/coarse-parity.json} (checked against the
 * fake host by the TypeScript test), reduced section by section in a scrambled order as the mod's
 * chunk reads finish, then the game's three air blocks counting as air.
 */
class CoarseCellsTest {
    static final String AIR = "minecraft:air";

    static JsonObject fixture() throws IOException {
        String golden = System.getProperty("autosketch.goldenDir");
        if (golden == null) throw new IllegalStateException("autosketch.goldenDir is not set (run the tests through Gradle)");
        return JsonParser.parseString(Files.readString(Path.of(golden).resolveSibling("select").resolve("coarse-parity.json"))).getAsJsonObject();
    }

    static int[] vec(JsonElement e) {
        JsonArray a = e.getAsJsonArray();
        int[] out = new int[a.size()];
        for (int i = 0; i < out.length; i++) out[i] = a.get(i).getAsInt();
        return out;
    }

    static Box box(JsonElement e) {
        int[] min = vec(e.getAsJsonObject().get("min")), max = vec(e.getAsJsonObject().get("max"));
        return new Box(min[0], min[1], min[2], max[0], max[1], max[2]);
    }

    /** Reduces every region over its sections (skipping ungenerated chunks), in reverse section order to show order doesn't matter. */
    static CoarseCells.Indexed reduce(List<Box> regions, int cell, CoarseCells.At<String> at, Set<Long> missing) {
        Object[][] out = new Object[regions.size()][];
        List<int[]> sections = new ArrayList<>();
        for (int i = 0; i < regions.size(); i++) {
            Box r = regions.get(i);
            int[] g = CoarseCells.grid(r, cell);
            out[i] = new Object[g[0] * g[1] * g[2]];
            Arrays.fill(out[i], AIR);
            for (int sy = r.minY() >> 4; sy <= r.maxY() >> 4; sy++)
                for (int sz = r.minZ() >> 4; sz <= r.maxZ() >> 4; sz++)
                    for (int sx = r.minX() >> 4; sx <= r.maxX() >> 4; sx++) sections.add(new int[] {i, sx, sy, sz});
        }
        for (int j = sections.size() - 1; j >= 0; j--) {
            int[] s = sections.get(j);
            if (missing.contains(key(s[1], s[3]))) continue;
            CoarseCells.reduce(regions.get(s[0]), cell, s[1], s[2], s[3], at, AIR::equals, AIR, out[s[0]]);
        }
        return CoarseCells.index(out, o -> (String) o);
    }

    static long key(int cx, int cz) {
        return ((long) cx << 32) ^ (cz & 0xffffffffL);
    }

    @Test
    void matchesTheFakeHost() throws IOException {
        JsonObject f = fixture();
        int[] origin = vec(f.get("origin")), size = vec(f.get("size"));
        String cells = f.get("cells").getAsString();
        JsonObject legend = f.getAsJsonObject("legend");
        CoarseCells.At<String> at = (x, y, z) -> {
            int lx = x - origin[0], ly = y - origin[1], lz = z - origin[2];
            if (lx < 0 || ly < 0 || lz < 0 || lx >= size[0] || ly >= size[1] || lz >= size[2]) return AIR;
            return legend.get(String.valueOf(cells.charAt(lx + size[0] * (lz + size[2] * ly)))).getAsString();
        };
        int n = 0;
        for (JsonElement ce : f.getAsJsonArray("cases")) {
            JsonObject c = ce.getAsJsonObject();
            String name = c.get("name").getAsString();
            int cell = c.get("cell").getAsInt();
            Set<Long> missing = new HashSet<>();
            for (JsonElement m : c.getAsJsonArray("missing")) missing.add(key(vec(m)[0], vec(m)[1]));
            List<Box> regions = new ArrayList<>();
            for (JsonElement b : c.getAsJsonArray("boxes")) regions.add(SelectMessages.align(box(b), cell));
            JsonObject answer = c.getAsJsonObject("answer");
            JsonArray want = answer.getAsJsonArray("regions");
            for (int i = 0; i < regions.size(); i++) assertEquals(box(want.get(i).getAsJsonObject().get("box")), regions.get(i), name + ": aligned box " + i);
            CoarseCells.Indexed got = reduce(regions, cell, at, missing);
            List<String> palette = new ArrayList<>();
            for (JsonElement p : answer.getAsJsonArray("palette")) palette.add(p.getAsString());
            assertEquals(palette, got.palette(), name + ": palette");
            for (int i = 0; i < regions.size(); i++) assertArrayEquals(vec(want.get(i).getAsJsonObject().get("states")), got.states()[i], name + ": cells of region " + i);
            n++;
        }
        assertEquals(4, n);
    }

    @Test
    void theGamesAirsCountAsAirAndTiesGoToTheFirstMet() {
        // One 2³ cell at the origin: cave and void air outnumber the rest but count as air; stone and
        // dirt tie at 2, and stone comes first in index order (x, then z, then y).
        String[] cell = {"minecraft:cave_air", "minecraft:stone", "minecraft:dirt", "minecraft:void_air", "minecraft:cave_air", "minecraft:dirt", "minecraft:stone",
                "minecraft:cave_air"};
        CoarseCells.At<String> at = (x, y, z) -> cell[x + 2 * (z + 2 * y)];
        Set<String> airs = Set.of(AIR, "minecraft:cave_air", "minecraft:void_air");
        Object[] out = {null};
        CoarseCells.reduce(new Box(0, 0, 0, 1, 1, 1), 2, 0, 0, 0, at, airs::contains, AIR, out);
        assertEquals("minecraft:stone", out[0]);
        String[] allAir = {"minecraft:cave_air", AIR, "minecraft:void_air", AIR, AIR, AIR, "minecraft:cave_air", AIR};
        CoarseCells.reduce(new Box(0, 0, 0, 1, 1, 1), 2, 0, 0, 0, (x, y, z) -> allAir[x + 2 * (z + 2 * y)], airs::contains, AIR, out);
        assertEquals(AIR, out[0], "an all-air cell reads as minecraft:air");
    }
}
