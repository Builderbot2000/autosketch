package dev.autosketch.mod.client.ui.blocks;

import net.minecraft.world.level.block.state.BlockState;

/**
 * A box of blocks to draw (16, *Ghost blocks*, and the *Library screen*'s 3D preview): local
 * positions {@code [0, size)} on each axis. Positions outside the box, and air, are "no block". A
 * region is read on the render thread while it is meshed, so it must not change during a
 * {@link BlockMesher} call; {@link PaletteRegion} is the usual one (a palette plus an index per
 * position, as the wire's region bodies carry them).
 */
public interface BlockRegion {
    int sizeX();

    int sizeY();

    int sizeZ();

    /** The state at a local position; air for none and for positions outside the box. */
    BlockState get(int x, int y, int z);
}
