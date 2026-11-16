package dev.autosketch.mod.prompt;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import net.neoforged.bus.api.SubscribeEvent;
import net.neoforged.fml.common.EventBusSubscriber;

/** NeoForge's hook for {@link PromptModule} (common): its registration. */
@EventBusSubscriber(modid = Autosketch.MOD_ID)
public final class PromptEvents {
    private PromptEvents() {}

    @SubscribeEvent
    static void setup(AutosketchSetupEvent e) {
        PromptModule.setup(e.setup());
    }
}
