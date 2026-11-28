package dev.autosketch.mod.ui;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import dev.autosketch.mod.protocol.FrameCodec;
import dev.autosketch.mod.prompt.StatusLines;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

/**
 * NeoForge's hook for status lines (19, *Status line*; 13, *Relay to the client*): a status line goes
 * whole to a player whose client registered {@code autosketch:ui}, as a relay frame, so the client
 * half rewrites it in place; everyone else gets {@link StatusLines}' plain lines. Never references
 * client classes.
 */
@EventBusSubscriber(modid = Autosketch.MOD_ID)
public final class StatusEvents {
    private StatusEvents() {}

    @SubscribeEvent
    static void setup(AutosketchSetupEvent e) {
        StatusLines.setRelay((p, f) -> {
            if (!UiNetwork.TRANSPORT.hasChannel(p)) return false;
            UiNetwork.relay().sendFrame(p, FrameCodec.encode(f));
            return true;
        });
    }
}
