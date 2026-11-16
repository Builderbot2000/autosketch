package dev.autosketch.mod.world.mixin;

import dev.autosketch.mod.world.ChangeTracker;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * The change tracker's hook (13, *World → agent*; M9): after a chunk block write that changed the
 * block (a non-null return), hand the position to {@link ChangeTracker#onSetBlock}, which costs one
 * null check when unlinked and a level check plus one box test outside the volumes.
 */
@Mixin(LevelChunk.class)
abstract class LevelChunkMixin {
    @Inject(method = "setBlockState", at = @At("RETURN"))
    private void autosketch$tracked(BlockPos pos, BlockState state, boolean isMoving, CallbackInfoReturnable<BlockState> cir) {
        if (cir.getReturnValue() != null) ChangeTracker.onSetBlock((LevelChunk) (Object) this, pos);
    }
}
