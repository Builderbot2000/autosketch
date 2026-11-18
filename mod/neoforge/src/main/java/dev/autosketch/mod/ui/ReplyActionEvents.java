package dev.autosketch.mod.ui;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import dev.autosketch.mod.prompt.InGamePrompts;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

/**
 * NeoForge's hooks for clickable reply lines (17, piece 3): a reply's action is clickable for players
 * whose client registered {@code autosketch:ui}, and {@code /autosketch action <n>} hands it to that
 * client through C's relay. Never references client classes.
 */
@EventBusSubscriber(modid = Autosketch.MOD_ID)
public final class ReplyActionEvents {
    private ReplyActionEvents() {}

    @SubscribeEvent
    static void setup(AutosketchSetupEvent e) {
        InGamePrompts.setClickable(UiNetwork.TRANSPORT::hasChannel);
        e.commands(new ReplyActionCommand((p, action) -> UiNetwork.relay().sendAction(p, action)));
    }
}
