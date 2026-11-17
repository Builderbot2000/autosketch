package dev.autosketch.mod.client.ui.ghost;

import dev.autosketch.mod.client.ui.blocks.BlockMesh;
import dev.autosketch.mod.client.ui.blocks.BlockRegion;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.SectionPos;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/**
 * One ghost the MCP sent (13, {@code ui.ghost}): its blocks as whole 16³ sections of its local grid,
 * where its local {@code [0,0,0]} lands in the world ({@code origin}), its dimension and tint, and
 * one mesh per section that draws something. Sections are keyed by {@link SectionPos#asLong}.
 * As a {@link BlockRegion} it answers for its whole local grid, so meshing a section culls faces
 * against its neighbours. Client thread.
 */
final class Ghost implements BlockRegion {
    private static final BlockState AIR = Blocks.AIR.defaultBlockState();

    /** One section's states: the palette of the message it came in, and a palette index per position. */
    record Section(BlockState[] palette, byte[] small, short[] large) {
        static Section of(BlockState[] palette, int[] states) {
            if (palette.length <= 256) {
                byte[] b = new byte[4096];
                for (int i = 0; i < 4096; i++) b[i] = (byte) states[i];
                return new Section(palette, b, null);
            }
            short[] s = new short[4096];
            for (int i = 0; i < 4096; i++) s[i] = (short) states[i];
            return new Section(palette, null, s);
        }

        BlockState get(int i) {
            return palette[small != null ? small[i] & 0xff : large[i] & 0xffff];
        }

        long bytes() {
            return small != null ? 4096 : 8192;
        }
    }

    final String id;
    String dimension;
    int ox, oy, oz;
    int tint;
    final Map<Long, Section> sections = new HashMap<>();
    final Map<Long, BlockMesh> meshes = new HashMap<>();
    /** Sections to (re-)mesh, in arrival order. */
    final Set<Long> dirty = new LinkedHashSet<>();
    /** How many times each section was meshed (tests: an update re-meshes only what it touched). */
    final Map<Long, Integer> meshCounts = new HashMap<>();

    Ghost(String id) {
        this.id = id;
    }

    void put(long key, Section s) {
        sections.put(key, s);
        dirty.add(key);
    }

    void remove(long key) {
        sections.remove(key);
        dirty.remove(key);
        BlockMesh m = meshes.remove(key);
        if (m != null) m.close();
    }

    /** Frees every mesh and marks every section to mesh again (left the dimension, toggled off). */
    void freeMeshes() {
        for (BlockMesh m : meshes.values()) m.close();
        meshes.clear();
        dirty.addAll(sections.keySet());
    }

    /** Frees everything (cleared, disconnected). */
    void free() {
        for (BlockMesh m : meshes.values()) m.close();
        meshes.clear();
        sections.clear();
        dirty.clear();
    }

    @Override
    public BlockState get(int x, int y, int z) {
        Section s = sections.get(SectionPos.asLong(x >> 4, y >> 4, z >> 4));
        return s == null ? AIR : s.get((x & 15) + 16 * ((z & 15) + 16 * (y & 15)));
    }

    // The local grid's extent; sections, not this box, decide what is meshed.
    @Override
    public int sizeX() {
        return extent(0);
    }

    @Override
    public int sizeY() {
        return extent(1);
    }

    @Override
    public int sizeZ() {
        return extent(2);
    }

    private int extent(int axis) {
        int max = 0;
        for (long k : sections.keySet()) {
            int c = axis == 0 ? SectionPos.x(k) : axis == 1 ? SectionPos.y(k) : SectionPos.z(k);
            max = Math.max(max, (c + 1) * 16);
        }
        return max;
    }
}
