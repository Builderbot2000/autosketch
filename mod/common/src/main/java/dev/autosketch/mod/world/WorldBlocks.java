package dev.autosketch.mod.world;

import java.util.Map;
import java.util.Optional;
import net.minecraft.core.BlockPos;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.resources.ResourceLocation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BlockEntityType;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import net.minecraft.world.level.chunk.LevelChunkSection;
import net.minecraft.world.level.levelgen.Heightmap;
import net.minecraft.world.level.lighting.LightEngine;
import org.jetbrains.annotations.Nullable;

/**
 * Reading and writing single blocks the way the bridge needs (13, *Agent → world*; M5, M6, M12).
 * Server thread only.
 *
 * <p><b>Side-effect-free writes.</b> {@link #write} puts the state straight into the chunk section,
 * as Axiom and WorldEdit paste, instead of going through {@code Level.setBlock} /
 * {@code LevelChunk.setBlockState}, which run the old block's {@code onRemove} (a chest drops its
 * items) and the new block's {@code onPlace} (sand schedules its fall, water its flow, redstone
 * updates). It then does only the bookkeeping that keeps the world consistent: heightmaps, the
 * section's empty status and the light engine (sky-light sources and a queued light check, as
 * vanilla does), the old block entity removed without drops, the new one loaded, points of interest,
 * the chunk marked unsaved, and the change sent to clients (with mob path invalidation). No
 * neighbour or shape updates, no scheduled ticks, no entities touched. Because it bypasses
 * {@code LevelChunk.setBlockState}, the change tracker's hook never sees these writes; the
 * fallback tracker is told about them through {@link #listener}.
 */
public final class WorldBlocks {
    private WorldBlocks() {}

    /** Told about every write this class makes (the fallback tracker updates its baseline). */
    public interface WriteListener {
        void written(ServerLevel level, BlockPos pos, BlockState state);
    }

    static volatile @Nullable WriteListener listener;

    /** Whether {@code y} lies inside the level's build height. */
    public static boolean inHeight(ServerLevel level, int y) {
        return y >= level.getMinBuildHeight() && y < level.getMaxBuildHeight();
    }

    /** The state at {@code pos}; outside the build height it reads as air (13, *Wire format*). */
    public static BlockState state(ServerLevel level, BlockPos pos) {
        if (!inHeight(level, pos.getY())) return Blocks.AIR.defaultBlockState();
        return level.getChunkAt(pos).getBlockState(pos);
    }

    /** The block entity at {@code pos}, or null (always null outside the build height). */
    public static @Nullable BlockEntity blockEntity(ServerLevel level, BlockPos pos) {
        if (!inHeight(level, pos.getY())) return null;
        return level.getChunkAt(pos).getBlockEntity(pos, LevelChunk.EntityCreationType.CHECK);
    }

    /**
     * A block entity's NBT as the wire carries it: {@code saveWithId} without the top-level
     * {@code x}, {@code y}, {@code z} (13, *Wire format*, *NBT*).
     */
    public static CompoundTag nbt(BlockEntity be, HolderLookup.Provider registries) {
        CompoundTag tag = be.saveWithId(registries);
        tag.remove("x");
        tag.remove("y");
        tag.remove("z");
        return tag;
    }

    /** The NBT of the block entity at {@code pos}, or null when there is none. */
    public static @Nullable CompoundTag nbtAt(ServerLevel level, BlockPos pos) {
        BlockEntity be = blockEntity(level, pos);
        return be == null ? null : nbt(be, level.registryAccess());
    }

    /** Outcome of {@link #prepare}: the block entity to place (may be null), or a failure. */
    public record Prepared(boolean ok, @Nullable BlockEntity blockEntity) {
        static final Prepared NONE = new Prepared(true, null);
        static final Prepared BAD = new Prepared(false, null);
    }

    /**
     * Builds the block entity a patch's NBT describes for {@code state} at {@code pos}, before
     * anything is written, so an unusable compound is rejected {@code bad_nbt} without touching the
     * world: NBT given for a block without a block entity, an {@code id} missing, unknown or naming
     * a type the block doesn't take, or data the game fails to load. With no NBT, nothing is prepared
     * (the write then creates the block's default block entity, as the game would).
     */
    public static Prepared prepare(BlockPos pos, BlockState state, @Nullable CompoundTag nbt, HolderLookup.Provider registries) {
        if (nbt == null) return Prepared.NONE;
        if (!state.hasBlockEntity()) return Prepared.BAD;
        String id = Hashing.typeOf(nbt);
        ResourceLocation rl = id == null ? null : ResourceLocation.tryParse(id);
        if (rl == null) return Prepared.BAD;
        Optional<BlockEntityType<?>> type = BuiltInRegistries.BLOCK_ENTITY_TYPE.getOptional(rl);
        if (type.isEmpty() || !type.get().isValid(state)) return Prepared.BAD;
        try {
            BlockEntity be = type.get().create(pos.immutable(), state);
            if (be == null) return Prepared.BAD;
            be.loadWithComponents(nbt, registries);
            return new Prepared(true, be);
        } catch (Throwable t) {
            return Prepared.BAD;
        }
    }

    /**
     * Writes {@code state} at {@code pos} without side effects (see the class comment), replacing
     * any block entity there: the old one is removed without dropping anything, and {@code prepared}
     * (from {@link #prepare}) or else the block's default block entity is placed. The position must
     * lie inside the build height and its chunk must be loaded.
     */
    public static void write(ServerLevel level, BlockPos pos, BlockState state, @Nullable BlockEntity prepared) {
        LevelChunk chunk = level.getChunkAt(pos);
        int x = pos.getX() & 15, y = pos.getY(), z = pos.getZ() & 15;
        LevelChunkSection section = chunk.getSection(chunk.getSectionIndex(y));
        BlockState old = section.getBlockState(x, y & 15, z);

        // The old block entity goes in every case: a patch replaces block entities, even when the
        // state stays the same. removeBlockEntity marks it removed; nothing is dropped.
        if (old.hasBlockEntity() || chunk.getBlockEntities().containsKey(pos)) chunk.removeBlockEntity(pos);

        if (old != state) {
            boolean wasEmpty = section.hasOnlyAir();
            section.setBlockState(x, y & 15, z, state);
            for (Map.Entry<Heightmap.Types, Heightmap> h : chunk.getHeightmaps()) h.getValue().update(x, y, z, state);
            boolean isEmpty = section.hasOnlyAir();
            if (wasEmpty != isEmpty) level.getChunkSource().getLightEngine().updateSectionStatus(pos, isEmpty);
            if (LightEngine.hasDifferentLightProperties(chunk, pos, old, state)) {
                chunk.getSkyLightSources().update(chunk, x, y, z);
                level.getChunkSource().getLightEngine().checkBlock(pos);
            }
        }

        if (state.hasBlockEntity()) {
            BlockEntity be = prepared;
            Block block = state.getBlock();
            if (be == null && block instanceof EntityBlock eb) be = eb.newBlockEntity(pos.immutable(), state);
            if (be != null) chunk.addAndRegisterBlockEntity(be);
        }

        chunk.setUnsaved(true);
        if (old != state) level.onBlockStateChange(pos, old, state);
        // Sends the block (and, through the chunk holder, its block entity) to clients and updates
        // mob navigation. Not a neighbour update.
        level.sendBlockUpdated(pos, old, state, Block.UPDATE_CLIENTS);
        WriteListener l = listener;
        if (l != null) l.written(level, pos, state);
    }
}
