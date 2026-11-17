package dev.autosketch.mod.ui;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import dev.autosketch.mod.ui.ghost.GhostCommand;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

/**
 * NeoForge's hooks for anchored ghosts' server half (16, *Ghost blocks*): the {@code ghost}
 * subcommand and the wand's {@code ghost} mode, both handing the client an action through C's relay.
 * Never references client classes.
 */
@EventBusSubscriber(modid = Autosketch.MOD_ID)
public final class GhostEvents {
    private GhostEvents() {}

    @SubscribeEvent
    static void setup(AutosketchSetupEvent e) {
        GhostCommand ghost = new GhostCommand((p, action) -> UiNetwork.relay().sendAction(p, action));
        e.commands(ghost);
        e.wandModes(ghost.wandMode());
    }
}
