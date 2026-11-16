package dev.autosketch.mod.data;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppedEvent;

/** NeoForge's hooks for {@link DataModule} (common): its registration and the server start and stop. */
@EventBusSubscriber(modid = Autosketch.MOD_ID)
public final class DataEvents {
    private DataEvents() {}

    @SubscribeEvent
    static void setup(AutosketchSetupEvent e) {
        DataModule.setup(e.setup());
        NeoForge.EVENT_BUS.addListener((ServerStartedEvent t) -> DataModule.serverStarted(t.getServer()));
        NeoForge.EVENT_BUS.addListener((ServerStoppedEvent t) -> DataModule.serverStopped());
    }
}
