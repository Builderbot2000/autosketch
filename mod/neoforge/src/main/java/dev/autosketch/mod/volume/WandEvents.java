package dev.autosketch.mod.volume;

import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.neoforged.neoforge.event.entity.living.LivingSwapItemsEvent;
import net.neoforged.neoforge.event.entity.player.PlayerInteractEvent;

/**
 * NeoForge's events for the wand's clicks, passed to {@link WandControl} (common), which decides
 * and says whether to cancel.
 */
public final class WandEvents {
    private final WandControl wand;

    private final AirMode air;

    public WandEvents(WandControl wand, AirMode air) {
        this.wand = wand;
        this.air = air;
    }

    /** A use of the item without a block (B2's server-only air path: right click into the air). */
    public void rightClickItem(PlayerInteractEvent.RightClickItem e) {
        if (e.getLevel().isClientSide() || !(e.getEntity() instanceof ServerPlayer p)) return;
        if (air.rightClickAir(p, e.getHand() == InteractionHand.MAIN_HAND)) e.setCanceled(true);
    }

    public void leftClick(PlayerInteractEvent.LeftClickBlock e) {
        if (e.getLevel().isClientSide() || !(e.getEntity() instanceof ServerPlayer p)) return;
        if (wand.leftClick(p, e.getPos(), e.getAction() == PlayerInteractEvent.LeftClickBlock.Action.START)) e.setCanceled(true);
    }

    public void rightClick(PlayerInteractEvent.RightClickBlock e) {
        if (e.getLevel().isClientSide() || !(e.getEntity() instanceof ServerPlayer p)) return;
        if (wand.rightClick(p, e.getPos(), e.getHand() == InteractionHand.MAIN_HAND)) e.setCanceled(true);
    }

    public void swapHands(LivingSwapItemsEvent.Hands e) {
        if (!(e.getEntity() instanceof ServerPlayer p)) return;
        if (wand.swapHands(p)) e.setCanceled(true);
    }
}
