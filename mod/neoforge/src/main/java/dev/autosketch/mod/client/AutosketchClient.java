package dev.autosketch.mod.client;

import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.Autosketch;
import me.shedaniel.autoconfig.AutoConfig;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.neoforge.client.gui.IConfigScreenFactory;

/**
 * Client-only entry point: the config screen in the mod list, through Cloth Config (14, *Config
 * across loaders*). Loaded only on a physical client, so the mod stays server-side otherwise (M2).
 */
@Mod(value = Autosketch.MOD_ID, dist = Dist.CLIENT)
public final class AutosketchClient {
    public AutosketchClient(ModContainer container) {
        container.registerExtensionPoint(IConfigScreenFactory.class,
                (IConfigScreenFactory) (mod, parent) -> AutoConfig.getConfigScreen(AutosketchConfig.class, parent).get());
    }
}
