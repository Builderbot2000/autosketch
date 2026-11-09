package dev.autosketch.mod;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.PatchStatus;
import dev.autosketch.mod.bridge.BridgeServer;
import dev.autosketch.mod.bridge.Dispatcher;
import dev.autosketch.mod.command.AutosketchCommand;
import dev.autosketch.mod.volume.LinkVolumesHolder;
import java.util.List;
import net.minecraft.server.MinecraftServer;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.config.ModConfig;
import net.neoforged.fml.event.lifecycle.FMLCommonSetupEvent;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.server.ServerLifecycleHooks;
import org.slf4j.Logger;

/**
 * Entry point of the Autosketch companion mod (13, *Companion mod requirements*). Server-side only
 * (M2): it registers no blocks, items or other registry content, and never touches client classes,
 * so it runs on a dedicated server and in singleplayer, and vanilla clients join without it.
 */
@Mod(Autosketch.MOD_ID)
public final class AutosketchMod {
    private static final Logger LOG = LogUtils.getLogger();

    private final IEventBus modBus;
    private final Dispatcher dispatcher;
    private final BridgeServer bridge;
    private final LinkVolumesHolder volumes = new LinkVolumesHolder();
    private List<CommandExtension> commands = List.of();

    public AutosketchMod(IEventBus modBus, ModContainer container) {
        this.modBus = modBus;
        container.registerConfig(ModConfig.Type.COMMON, AutosketchConfig.SPEC);
        dispatcher = new Dispatcher(AutosketchMod::onServerThread);
        bridge = new BridgeServer(dispatcher, AutosketchMod::onServerThread);
        Autosketch.install(bridge, volumes, PatchStatus.NONE, List.of());
        modBus.addListener(this::commonSetup);
        NeoForge.EVENT_BUS.addListener(this::registerCommands);
    }

    /** Runs a task on the current server's thread; dropped when no server is running (no connection can exist then). */
    private static void onServerThread(Runnable task) {
        MinecraftServer server = ServerLifecycleHooks.getCurrentServer();
        if (server != null) server.execute(task);
    }

    private void commonSetup(FMLCommonSetupEvent event) {
        AutosketchSetupEvent setup = new AutosketchSetupEvent(dispatcher);
        modBus.post(setup);
        setup.close();
        dispatcher.freeze();
        commands = List.copyOf(setup.commandExtensions());
        Autosketch.install(bridge, volumes, setup.registeredPatchStatus(), setup.registeredWandModes());
        LOG.info("Autosketch: {} command extension(s), wand modes {}", commands.size(), setup.registeredWandModes().stream().map(m -> m.name()).toList());
    }

    private void registerCommands(RegisterCommandsEvent event) {
        AutosketchCommand.register(event.getDispatcher(), event.getBuildContext(), commands);
    }
}
