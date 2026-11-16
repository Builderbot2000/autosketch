package dev.autosketch.mod.protocol;

import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.nbt.CompoundTag;
import org.jetbrains.annotations.Nullable;

/** The entries binary bodies carry (13, *Wire format*, *Binary bodies*), in world coordinates. */
public final class BodyTypes {
    private BodyTypes() {}

    /**
     * One patch position: the expected (before) state, the new state, the expected NBT hash when the
     * cache's before-block has a hashed block entity, and the new NBT when the new block has a block
     * entity. States are canonical strings (*Block states*); NBT omits {@code x}, {@code y}, {@code z}.
     */
    public record PatchBlock(BlockPos pos, String expected, String state, @Nullable Long expectedNbtHash, @Nullable CompoundTag nbt) {
        public PatchBlock {
            pos = pos.immutable();
        }
    }

    /** A position with the state and NBT the world holds there ({@code dirty}, skipped positions of an ack). */
    public record WorldBlock(BlockPos pos, String state, @Nullable CompoundTag nbt) {
        public WorldBlock {
            pos = pos.immutable();
        }
    }

    /** A rejected patch position with its reason ({@link ErrorCodes#isRejectReason}). */
    public record Rejected(BlockPos pos, String reason) {
        public Rejected {
            pos = pos.immutable();
        }
    }

    /** An applied position whose world NBT differs from what the patch sent; null NBT means "no block entity". */
    public record Normalized(BlockPos pos, @Nullable CompoundTag nbt) {
        public Normalized {
            pos = pos.immutable();
        }
    }

    /** A block entity's NBT at a position. */
    public record BlockEntityNbt(BlockPos pos, CompoundTag nbt) {
        public BlockEntityNbt {
            pos = pos.immutable();
        }
    }

    /**
     * One snapshot region: its box, a palette index per position in the box's index order (x fastest,
     * then z, then y), and the block entities inside it. Indices refer to the enclosing message's
     * palette.
     */
    public record SnapshotRegion(Box box, int[] states, List<BlockEntityNbt> blockEntities) {}

    /** The skipped, rejected and normalized lists of a {@code patch.ack}. */
    public record AckLists(List<WorldBlock> skipped, List<Rejected> rejected, List<Normalized> normalized) {}

    /**
     * One layer of a surface snapshot (protocol 2, B4): per column in index order ({@code dx + sizeX · dz}),
     * a height code (0 = none, else {@code y − minY + 1}) and, where the code isn't 0, an index into the
     * enclosing message's palette (ignored where the code is 0).
     */
    public record SurfaceLayer(int[] heights, int[] states) {
        public SurfaceLayer {
            if (heights.length != states.length) throw new IllegalArgumentException("surface layer: " + heights.length + " heights, " + states.length + " states");
        }

        public static SurfaceLayer of(int columns) {
            return new SurfaceLayer(new int[columns], new int[columns]);
        }
    }

    /**
     * What an {@code upgrade} carries (protocol 3; 14, *Schematics from other versions*): a schematic's
     * elements (block states as the file names them, block-entity compounds without {@code x}/{@code y}/{@code z},
     * entity compounds without {@code Pos}), or one whole structure file ({@code structure} non-null,
     * the lists empty).
     */
    public record UpgradeData(List<String> states, List<CompoundTag> blockEntities, List<CompoundTag> entities, @Nullable CompoundTag structure) {
        public static UpgradeData elements(List<String> states, List<CompoundTag> blockEntities, List<CompoundTag> entities) {
            return new UpgradeData(List.copyOf(states), List.copyOf(blockEntities), List.copyOf(entities), null);
        }

        public static UpgradeData structure(CompoundTag structure) {
            return new UpgradeData(List.of(), List.of(), List.of(), structure);
        }

        public String kind() {
            return structure == null ? "elements" : "structure";
        }
    }

    /** An encoded body and the grid its positions are relative to. */
    public record Encoded(Grid grid, byte[] body) {}
}
