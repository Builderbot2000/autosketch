package dev.autosketch.mod;

import com.mojang.authlib.GameProfile;
import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetupEvent;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.PatchStatus;
import dev.autosketch.mod.bridge.BridgeServer;
import dev.autosketch.mod.bridge.Dispatcher;
import dev.autosketch.mod.command.AutosketchCommand;
import dev.autosketch.mod.command.VolumeCommands;
import dev.autosketch.mod.feedback.Feedback;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.volume.ChunkTickets;
import dev.autosketch.mod.volume.LinkVolumesHolder;
import dev.autosketch.mod.volume.PlayerStates;
import dev.autosketch.mod.volume.VolumeManager;
import dev.autosketch.mod.volume.VolumeModes;
import dev.autosketch.mod.volume.WandEvents;
import java.io.IOException;
import java.util.List;
import net.minecraft.SharedConstants;
import net.minecraft.server.MinecraftServer;
import net.neoforged.bus.api.IEventBus;
import net.neoforged.fml.ModContainer;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.config.ModConfig;
import net.neoforged.fml.event.lifecycle.FMLCommonSetupEvent;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.common.NeoForge;
import net.neoforged.neoforge.event.RegisterCommandsEvent;
import net.neoforged.neoforge.event.server.ServerStartedEvent;
import net.neoforged.neoforge.event.server.ServerStoppingEvent;
import net.neoforged.neoforge.event.tick.ServerTickEvent;
import net.neoforged.neoforge.internal.versions.neoforge.NeoForgeVersion;
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
    private final String modVersion;
    private final Dispatcher dispatcher;
    private final BridgeServer bridge;
    private final LinkVolumesHolder holder = new LinkVolumesHolder();
    private final PlayerStates players = new PlayerStates();
    private final ChunkTickets tickets = new ChunkTickets();
    private final VolumeManager volumes;
    private final Feedback feedback;
    private final WandEvents wand;
    private List<CommandExtension> commands = List.of();
    private static AutosketchMod instance;

    /** Mod-internal pieces, for GameTests only. Not an API: other silos use {@link Autosketch}. */
    public record Internals(VolumeManager volumes, ChunkTickets tickets, BridgeServer bridge, PlayerStates players, WandEvents wand) {}

    public static Internals internals() {
        AutosketchMod m = instance;
        return new Internals(m.volumes, m.tickets, m.bridge, m.players, m.wand);
    }

    public AutosketchMod(IEventBus modBus, ModContainer container) {
        instance = this;
        this.modBus = modBus;
        modVersion = container.getModInfo().getVersion().toString();
        container.registerConfig(ModConfig.Type.COMMON, AutosketchConfig.SPEC);
        dispatcher = new Dispatcher(AutosketchMod::onServerThread);
        bridge = new BridgeServer(dispatcher, AutosketchMod::onServerThread);
        volumes = new VolumeManager(holder, bridge, tickets, AutosketchConfig.CONTEXT_CAP::get);
        feedback = new Feedback(players, AutosketchConfig.NOTICES_DEFAULT::get, Autosketch::wandModes, Autosketch::patchStatus);
        wand = new WandEvents(players, Autosketch::wandModes, feedback);
        Autosketch.install(bridge, holder, PatchStatus.NONE, List.of());

        bridge.addListener(new Bridge.Listener() {
            @Override
            public void connected(BridgeSession session) {
                volumes.updateTickets();
            }

            @Override
            public void disconnected(BridgeSession session) {
                volumes.updateTickets();
            }
        });

        modBus.addListener(this::commonSetup);
        NeoForge.EVENT_BUS.addListener(this::registerCommands);
        NeoForge.EVENT_BUS.addListener(this::serverStarted);
        NeoForge.EVENT_BUS.addListener(this::serverStopping);
        NeoForge.EVENT_BUS.addListener((ServerTickEvent.Post e) -> feedback.tick(e.getServer()));
        NeoForge.EVENT_BUS.addListener(wand::leftClick);
        NeoForge.EVENT_BUS.addListener(wand::rightClick);
        NeoForge.EVENT_BUS.addListener(wand::swapHands);
    }

    /** Runs a task on the current server's thread; dropped when no server is running (no connection can exist then). */
    private static void onServerThread(Runnable task) {
        MinecraftServer server = ServerLifecycleHooks.getCurrentServer();
        if (server != null) server.execute(task);
    }

    private void commonSetup(FMLCommonSetupEvent event) {
        AutosketchSetupEvent setup = new AutosketchSetupEvent(dispatcher);
        // Silo N's own pieces first, so work and context lead the wand's mode cycle.
        VolumeModes.Context contextMode = new VolumeModes.Context(volumes, players, feedback);
        setup.wandModes(new VolumeModes.Work(volumes, players, feedback));
        setup.wandModes(contextMode);
        setup.commands(new VolumeCommands(volumes, players, wand, contextMode, feedback, bridge, Autosketch::wandModes, Autosketch::patchStatus));
        setup.messages().register("volumes.extend", (m, ex) -> {
            Messages.VolumesExtend req = Messages.VolumesExtend.decode(m.frame());
            volumes.extend(req.id(), req.link(), req.work());
            MinecraftServer server = ServerLifecycleHooks.getCurrentServer();
            if (server != null)
                feedback.notice(server, null, "Autosketch: work volume extended to " + VolumeModes.size(req.work()) + " to include whole blocks");
        });
        setup.messages().register("notice", (m, ex) -> {
            Messages.Notice n = Messages.Notice.decode(m.frame());
            MinecraftServer server = ServerLifecycleHooks.getCurrentServer();
            if (server != null) feedback.notice(server, n.player(), n.text());
        });
        modBus.post(setup);
        setup.close();
        dispatcher.freeze();
        commands = List.copyOf(setup.commandExtensions());
        Autosketch.install(bridge, holder, setup.registeredPatchStatus(), setup.registeredWandModes());
        LOG.info("Autosketch: {} command extension(s), wand modes {}", commands.size(), setup.registeredWandModes().stream().map(m -> m.name()).toList());
    }

    private void registerCommands(RegisterCommandsEvent event) {
        AutosketchCommand.register(event.getDispatcher(), event.getBuildContext(), commands);
    }

    private void serverStarted(ServerStartedEvent event) {
        MinecraftServer server = event.getServer();
        players.clear();
        feedback.serverStarted();
        volumes.serverStarted(server);
        try {
            bridge.start(FMLPaths.CONFIGDIR.get(), AutosketchConfig.PORT.get(), new BridgeServer.Host() {
                @Override
                public Messages.ModHello hello() {
                    return modHello(server);
                }

                @Override
                public Frame volumes() {
                    return volumes.volumesFrame();
                }
            });
        } catch (IOException e) {
            LOG.error("Autosketch bridge failed to start (port {})", AutosketchConfig.PORT.get(), e);
        }
    }

    private void serverStopping(ServerStoppingEvent event) {
        bridge.stop();
        volumes.serverStopping();
    }

    private Messages.ModHello modHello(MinecraftServer server) {
        GameProfile host = server.isDedicatedServer() ? null : server.getSingleplayerProfile();
        return new Messages.ModHello(modVersion, SharedConstants.getCurrentVersion().getName(), SharedConstants.getCurrentVersion().getDataVersion().getVersion(),
                "neoforge", NeoForgeVersion.getVersion(), !server.isDedicatedServer(),
                host == null || host.getId() == null ? null : new Messages.Player(host.getName(), host.getId()));
    }
}
