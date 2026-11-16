package dev.autosketch.mod;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.volume.WandEvents;
import java.nio.file.Path;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.event.lifecycle.FMLCommonSetupEvent;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.neoforged.neoforge.internal.versions.neoforge.NeoForgeVersion;
import net.neoforged.neoforge.server.ServerLifecycleHooks;
import org.jetbrains.annotations.Nullable;

/**
 * NeoForge entry point of the Autosketch companion mod (13, *Companion mod requirements*): installs
 * the NeoForge {@link Platform}, builds the {@link AutosketchCore} (common) and wires it to NeoForge's
 * events, and posts {@link AutosketchSetupEvent} so each silo registers from its own package.
 * Server-side only (M2): it registers no blocks, items or other registry content, and never touches
 * client classes, so it runs on a dedicated server and in singleplayer, and vanilla clients join
 * without it.
 */
@Mod(Autosketch.MOD_ID)
public final class AutosketchMod {
    private final IEventBus modBus;
    private final AutosketchCore core;
    private static AutosketchMod instance;

    /** Mod-internal pieces, for GameTests only. Not an API: other silos use {@link Autosketch}. */
    public static AutosketchCore.Internals internals() {
        return instance.core.internals();
    }

    public AutosketchMod(IEventBus modBus, ModContainer container) {
        instance = this;
        this.modBus = modBus;
        Platform.install(new NeoForgePlatform());
        core = new AutosketchCore(container.getModInfo().getVersion().toString());
        WandEvents wand = new WandEvents(core.wand());

        modBus.addListener(this::commonSetup);
        NeoForge.EVENT_BUS.addListener((RegisterCommandsEvent e) -> core.registerCommands(e.getDispatcher(), e.getBuildContext()));
        NeoForge.EVENT_BUS.addListener((ServerStartedEvent e) -> core.serverStarted(e.getServer()));
        NeoForge.EVENT_BUS.addListener((ServerStoppingEvent e) -> core.serverStopping());
        NeoForge.EVENT_BUS.addListener((ServerTickEvent.Post e) -> core.tickEnd(e.getServer()));
        NeoForge.EVENT_BUS.addListener(wand::leftClick);
        NeoForge.EVENT_BUS.addListener(wand::rightClick);
        NeoForge.EVENT_BUS.addListener(wand::swapHands);
    }

    private void commonSetup(FMLCommonSetupEvent event) {
        core.setup(setup -> modBus.post(new AutosketchSetupEvent(setup)));
    }

    private static final class NeoForgePlatform implements Platform {
        @Override
        public @Nullable MinecraftServer currentServer() {
            return ServerLifecycleHooks.getCurrentServer();
        }

        @Override
        public Path configDir() {
            return FMLPaths.CONFIGDIR.get();
        }

        @Override
        public String loader() {
            return "neoforge";
        }

        @Override
        public String loaderVersion() {
            return NeoForgeVersion.getVersion();
        }

        @Override
        public CompoundTag playerData(ServerPlayer player) {
            return player.getPersistentData();
        }
    }
}
