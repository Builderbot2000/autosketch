package dev.autosketch.mod.client.ui.replay.mixin;

import dev.autosketch.mod.client.ui.replay.ReplayClient;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.multiplayer.ClientPacketListener;
import net.minecraft.network.protocol.game.ClientboundBlockUpdatePacket;
import net.minecraft.network.protocol.game.ClientboundSectionBlocksUpdatePacket;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Replay ignores live updates (16, *Replay in the world*): while a replay is open, the server's
 * block and section updates inside the replayed volume are dropped, so they don't mix into the
 * frame; the chunk resend on close catches the client up. One box check per update
 * ({@link ReplayClient#dropsServerUpdate}); everything outside the volume goes through unchanged.
 *
 * <p>1.21.x: both handlers start with {@code PacketUtils.ensureRunningOnSameThread}; the injections
 * sit right after it, so they run on the client thread.
 */
@Mixin(ClientPacketListener.class)
abstract class ClientPacketListenerMixin {
    @Shadow
    private ClientLevel level;

    private static final String ON_THREAD = "Lnet/minecraft/network/protocol/PacketUtils;ensureRunningOnSameThread(Lnet/minecraft/network/protocol/Packet;Lnet/minecraft/network/PacketListener;Lnet/minecraft/util/thread/BlockableEventLoop;)V";

    @Inject(method = "handleBlockUpdate", at = @At(value = "INVOKE", target = ON_THREAD, shift = At.Shift.AFTER), cancellable = true)
    private void autosketch$replayBlock(ClientboundBlockUpdatePacket packet, CallbackInfo ci) {
        if (ReplayClient.dropsServerUpdate(packet.getPos())) ci.cancel();
    }

    @Inject(method = "handleChunkBlocksUpdate", at = @At(value = "INVOKE", target = ON_THREAD, shift = At.Shift.AFTER), cancellable = true)
    private void autosketch$replaySection(ClientboundSectionBlocksUpdatePacket packet, CallbackInfo ci) {
        if (!ReplayClient.isOpen()) return;
        ci.cancel();
        ClientLevel l = level;
        packet.runUpdates((pos, state) -> {
            if (!ReplayClient.dropsServerUpdate(pos)) l.setServerVerifiedBlockState(pos, state, 19);
        });
    }
}
