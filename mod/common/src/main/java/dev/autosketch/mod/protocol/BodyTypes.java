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

    /** An encoded body and the grid its positions are relative to. */
    public record Encoded(Grid grid, byte[] body) {}
}
