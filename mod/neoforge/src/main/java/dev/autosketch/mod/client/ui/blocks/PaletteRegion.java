package dev.autosketch.mod.client.ui.blocks;

import dev.autosketch.mod.world.States;
import java.util.ArrayList;
import java.util.List;
import org.jetbrains.annotations.Nullable;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

/**
 * A {@link BlockRegion} given as a palette of canonical state strings plus one palette index per
 * position, in the wire's order ({@code index = x + sx · (z + sz · y)}, 13, *Binary bodies*): the
 * layout of a {@code library.preview} body and of each {@code ui.ghost} section. Palette entries the
 * game doesn't know (a block from a mod that isn't installed, a non-canonical string) draw as
 * nothing and are listed in {@link #unknown()}; {@code minecraft:air} is no block.
 */
public final class PaletteRegion implements BlockRegion {
    private static final BlockState AIR = Blocks.AIR.defaultBlockState();

    private final int sx, sy, sz;
    private final BlockState[] palette;
    private final int[] indices;
    private final List<String> unknown;

    private PaletteRegion(int sx, int sy, int sz, BlockState[] palette, int[] indices, List<String> unknown) {
        this.sx = sx;
        this.sy = sy;
        this.sz = sz;
        this.palette = palette;
        this.indices = indices;
        this.unknown = unknown;
    }

    /**
     * A region of size {@code [sx,sy,sz]}: {@code indices} holds {@code sx·sy·sz} indices into
     * {@code palette}, in the wire's order. Not copied: don't change it while the region is in use.
     */
    public static PaletteRegion of(List<String> palette, int sx, int sy, int sz, int[] indices) {
        if (sx < 0 || sy < 0 || sz < 0 || (long) sx * sy * sz != indices.length)
            throw new IllegalArgumentException("size " + sx + "x" + sy + "x" + sz + " doesn't match " + indices.length + " indices");
        List<String> unknown = new ArrayList<>();
        BlockState[] states = resolve(palette, unknown);
        return new PaletteRegion(sx, sy, sz, states, indices, List.copyOf(unknown));
    }

    /**
     * Resolves canonical state strings to states (cached by {@link States#parse}); an unknown one
     * becomes air and is added to {@code unknown} when that is given.
     */
    public static BlockState[] resolve(List<String> palette, @Nullable List<String> unknown) {
        BlockState[] out = new BlockState[palette.size()];
        for (int i = 0; i < out.length; i++) {
            BlockState s = States.parse(palette.get(i));
            if (s == null) {
                if (unknown != null) unknown.add(palette.get(i));
                s = AIR;
            }
            out[i] = s;
        }
        return out;
    }

    /** Palette entries that draw as nothing because the game doesn't know them. */
    public List<String> unknown() {
        return unknown;
    }

    @Override
    public int sizeX() {
        return sx;
    }

    @Override
    public int sizeY() {
        return sy;
    }

    @Override
    public int sizeZ() {
        return sz;
    }

    @Override
    public BlockState get(int x, int y, int z) {
        if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return AIR;
        int i = indices[x + sx * (z + sz * y)];
        return i >= 0 && i < palette.length ? palette[i] : AIR;
    }
}
