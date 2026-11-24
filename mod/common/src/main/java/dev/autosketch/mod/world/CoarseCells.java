package dev.autosketch.mod.world;

import dev.autosketch.mod.protocol.Box;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * The coarse reduction (13, *Message schemas*, {@code snapshot} kind {@code coarse}; 18, piece 5): each
 * cell of an aligned region is read as one block, its most common non-air state, ties going to the
 * state met first in index order within the cell (x fastest, then z, then y), and air when the cell
 * is all air. The cell sizes (2 and 4) divide 16 and regions sit on the world's cell grid, so every
 * cell lies inside one chunk section, and a section's cells can be reduced alone, on whichever
 * thread holds that section. Generic over the state type so JUnit replays the fake host's answers
 * with strings.
 */
final class CoarseCells {
    private CoarseCells() {}

    /** A section's states by world position (only positions inside the section are asked). */
    interface At<T> {
        T at(int x, int y, int z);
    }

    /** The region's cell grid sizes {@code [nx, ny, nz]}. */
    static int[] grid(Box region, int cell) {
        return new int[] {region.sizeX() / cell, region.sizeY() / cell, region.sizeZ() / cell};
    }

    /**
     * Writes into {@code out} (the region's cells, x fastest, then z, then y) every cell of
     * {@code region} lying in section ({@code sx}, {@code sy}, {@code sz}), read from {@code at}.
     * {@code air} tests the game's air blocks, {@code airState} is what an all-air cell reads as.
     */
    static <T> void reduce(Box region, int cell, int sx, int sy, int sz, At<T> at, Predicate<T> air, T airState, Object[] out) {
        int x0 = Math.max(region.minX(), sx << 4), x1 = Math.min(region.maxX(), (sx << 4) + 15);
        int y0 = Math.max(region.minY(), sy << 4), y1 = Math.min(region.maxY(), (sy << 4) + 15);
        int z0 = Math.max(region.minZ(), sz << 4), z1 = Math.min(region.maxZ(), (sz << 4) + 15);
        if (x0 > x1 || y0 > y1 || z0 > z1) return;
        int nx = region.sizeX() / cell, nz = region.sizeZ() / cell;
        int n = cell * cell * cell;
        Object[] seen = new Object[n];
        int[] counts = new int[n];
        for (int y = y0; y <= y1; y += cell)
            for (int z = z0; z <= z1; z += cell)
                for (int x = x0; x <= x1; x += cell) {
                    int distinct = 0;
                    for (int dy = 0; dy < cell; dy++)
                        for (int dz = 0; dz < cell; dz++)
                            for (int dx = 0; dx < cell; dx++) {
                                T s = at.at(x + dx, y + dy, z + dz);
                                if (air.test(s)) continue;
                                int i = 0;
                                while (i < distinct && !seen[i].equals(s)) i++;
                                if (i == distinct) {
                                    seen[distinct] = s;
                                    counts[distinct++] = 0;
                                }
                                counts[i]++;
                            }
                    Object best = airState;
                    int most = 0;
                    for (int i = 0; i < distinct; i++)
                        if (counts[i] > most) {
                            best = seen[i];
                            most = counts[i];
                        }
                    int cx = (x - region.minX()) / cell, cy = (y - region.minY()) / cell, cz = (z - region.minZ()) / cell;
                    out[cx + nx * (cz + nz * cy)] = best;
                }
    }

    /** The regions' cells as palette indices: one palette over all regions, in region order, then cell order (as the fake host builds it). */
    record Indexed(List<String> palette, int[][] states) {}

    static Indexed index(Object[][] cells, Function<Object, String> print) {
        List<String> palette = new ArrayList<>();
        Map<String, Integer> byName = new HashMap<>();
        Map<Object, Integer> byState = new IdentityHashMap<>();
        int[][] out = new int[cells.length][];
        for (int r = 0; r < cells.length; r++) {
            Object[] o = cells[r];
            int[] states = new int[o.length];
            for (int c = 0; c < o.length; c++) {
                Integer p = byState.get(o[c]);
                if (p == null) {
                    String name = print.apply(o[c]);
                    p = byName.get(name);
                    if (p == null) {
                        p = palette.size();
                        palette.add(name);
                        byName.put(name, p);
                    }
                    byState.put(o[c], p);
                }
                states[c] = p;
            }
            out[r] = states;
        }
        return new Indexed(palette, out);
    }
}
