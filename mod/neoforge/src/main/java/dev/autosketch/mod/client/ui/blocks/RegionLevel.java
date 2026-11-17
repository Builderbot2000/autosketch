package dev.autosketch.mod.client.ui.blocks;

import net.minecraft.client.renderer.BiomeColors;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.BlockAndTintGetter;
import net.minecraft.world.level.ColorResolver;
import net.minecraft.world.level.LightLayer;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.lighting.LevelLightEngine;
import net.minecraft.world.level.material.FluidState;
import org.jetbrains.annotations.Nullable;

/**
 * The game's view of a {@link BlockRegion} while the block renderer meshes it: block states for
 * face culling and connected models, full light (block and sky 15, so a ghost or preview is lit the
 * same day and night apart from the lightmap), the world's directional face shading, no block
 * entities (16, *Decisions*: block models only). Biome tints (grass, leaves, water) come from a
 * world when one is given, at the region position plus {@code offset} (a ghost takes the colours of
 * where it would land), otherwise plains-like defaults (a preview in a screen).
 *
 * <p>1.21.x: {@code BlockAndTintGetter}'s abstract methods ({@code getShade}, {@code getLightEngine},
 * {@code getBlockTint}) and the height accessor are what a port checks.
 */
final class RegionLevel implements BlockAndTintGetter {
    static final int GRASS = 0x91bd59;
    static final int FOLIAGE = 0x77ab2f;
    static final int WATER = 0x3f76e4;

    private final BlockRegion region;
    private final @Nullable BlockAndTintGetter tints;
    private final int ox, oy, oz;
    private final BlockPos.MutableBlockPos worldPos = new BlockPos.MutableBlockPos();

    RegionLevel(BlockRegion region, @Nullable BlockAndTintGetter tints, int ox, int oy, int oz) {
        this.region = region;
        this.tints = tints;
        this.ox = ox;
        this.oy = oy;
        this.oz = oz;
    }

    @Override
    public BlockState getBlockState(BlockPos pos) {
        return region.get(pos.getX(), pos.getY(), pos.getZ());
    }

    @Override
    public FluidState getFluidState(BlockPos pos) {
        return getBlockState(pos).getFluidState();
    }

    @Override
    public @Nullable BlockEntity getBlockEntity(BlockPos pos) {
        return null;
    }

    @Override
    public float getShade(Direction direction, boolean shade) {
        if (!shade) return 1.0f;
        return switch (direction) {
            case DOWN -> 0.5f;
            case UP -> 1.0f;
            case NORTH, SOUTH -> 0.8f;
            case WEST, EAST -> 0.6f;
        };
    }

    /** Never called: every method that would reach the light engine is overridden. */
    @Override
    public LevelLightEngine getLightEngine() {
        throw new UnsupportedOperationException("a drawn region has no light engine");
    }

    @Override
    public int getBrightness(LightLayer layer, BlockPos pos) {
        return 15;
    }

    @Override
    public int getRawBrightness(BlockPos pos, int amount) {
        return 15;
    }

    @Override
    public boolean canSeeSky(BlockPos pos) {
        return true;
    }

    @Override
    public int getBlockTint(BlockPos pos, ColorResolver resolver) {
        if (tints != null) return tints.getBlockTint(worldPos.set(pos.getX() + ox, pos.getY() + oy, pos.getZ() + oz), resolver);
        if (resolver == BiomeColors.FOLIAGE_COLOR_RESOLVER) return FOLIAGE;
        if (resolver == BiomeColors.WATER_COLOR_RESOLVER) return WATER;
        return GRASS;
    }

    // A region is small next to a level; its local positions run from 0, so a generous fixed height
    // range keeps every isOutsideBuildHeight check false inside it.
    @Override
    public int getHeight() {
        return 8192;
    }

    @Override
    public int getMinBuildHeight() {
        return -4096;
    }
}
