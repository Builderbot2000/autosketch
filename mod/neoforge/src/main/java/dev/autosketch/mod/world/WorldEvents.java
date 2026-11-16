package dev.autosketch.mod.world;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.server.ServerStoppedEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;

/** NeoForge's hooks for {@link WorldModule} (common): its registration and the server-tick hooks. */
@EventBusSubscriber(modid = Autosketch.MOD_ID)
public final class WorldEvents {
    private WorldEvents() {}

    @SubscribeEvent
    static void setup(AutosketchSetupEvent e) {
        WorldModule.setup(e.setup());
        NeoForge.EVENT_BUS.addListener((ServerTickEvent.Pre t) -> WorldModule.tickStart());
        NeoForge.EVENT_BUS.addListener((ServerTickEvent.Post t) -> WorldModule.tickEnd());
        NeoForge.EVENT_BUS.addListener((ServerStoppedEvent t) -> WorldModule.serverStopped());
    }
}
