package dev.autosketch.mod;

import com.mojang.authlib.GameProfile;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.logging.LogUtils;
import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.api.AutosketchSetup;
import dev.autosketch.mod.api.Bridge;
import dev.autosketch.mod.api.BridgeSession;
import dev.autosketch.mod.api.CommandExtension;
import dev.autosketch.mod.api.PatchStatus;
import dev.autosketch.mod.bridge.BridgeServer;
import dev.autosketch.mod.bridge.Dispatcher;
import dev.autosketch.mod.command.AutosketchCommand;
import dev.autosketch.mod.command.VolumeCommands;
import dev.autosketch.mod.discovery.PointerFile;
import dev.autosketch.mod.feedback.Feedback;
import dev.autosketch.mod.platform.Platform;
import dev.autosketch.mod.protocol.Frame;
import dev.autosketch.mod.protocol.Messages;
import dev.autosketch.mod.volume.AirCommands;
import dev.autosketch.mod.volume.AirMode;
import dev.autosketch.mod.volume.ChunkTickets;
import dev.autosketch.mod.volume.LinkVolumesHolder;
import dev.autosketch.mod.volume.PlayerStates;
import dev.autosketch.mod.volume.VolumeManager;
import dev.autosketch.mod.volume.VolumeModes;
import dev.autosketch.mod.volume.WandControl;
import java.io.IOException;
import java.util.List;
import java.util.function.Consumer;
import net.minecraft.SharedConstants;
import net.minecraft.commands.CommandBuildContext;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;

/**
 * The mod's pieces and lifecycle, in vanilla types only (14, *Build layout*): each loader's entry
 * point installs a {@link Platform}, builds one of these, and calls it from its own events (setup,
 * command registration, server start and stop, the server tick, the wand's clicks).
 * Server-side only (13, M2): no registry content, no client classes.
 */
public final class AutosketchCore {
    private static final Logger LOG = LogUtils.getLogger();

    private final String modVersion;
    private final Dispatcher dispatcher;
    private final BridgeServer bridge;
    private final LinkVolumesHolder holder = new LinkVolumesHolder();
    private final PlayerStates players = new PlayerStates();
    private final ChunkTickets tickets = new ChunkTickets();
    private final VolumeManager volumes;
    private final Feedback feedback;
    private final WandControl wand;
    private final AirMode air;
    private List<CommandExtension> commands = List.of();

    /** Mod-internal pieces, for GameTests only. Not an API: other silos use {@link Autosketch}. */
    public record Internals(VolumeManager volumes, ChunkTickets tickets, BridgeServer bridge, PlayerStates players, WandControl wand, AirMode air) {}

    public Internals internals() {
        return new Internals(volumes, tickets, bridge, players, wand, air);
    }

    /** Builds the pieces and loads the config; the platform must be installed first. */
    public AutosketchCore(String modVersion) {
        this.modVersion = modVersion;
        AutosketchConfig.register(Platform.get().configDir());
        dispatcher = new Dispatcher(AutosketchCore::onServerThread);
        bridge = new BridgeServer(dispatcher, AutosketchCore::onServerThread);
        volumes = new VolumeManager(holder, bridge, tickets, () -> AutosketchConfig.get().volumes.contextCap);
        feedback = new Feedback(players, () -> AutosketchConfig.get().feedback.noticesDefault, Autosketch::wandModes, Autosketch::patchStatus);
        wand = new WandControl(players, Autosketch::wandModes, feedback);
        air = new AirMode(players, wand::mode, feedback);
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
    }

    public WandControl wand() {
        return wand;
    }

    public AirMode air() {
        return air;
    }

    /** Runs a task on the current server's thread; dropped when no server is running (no connection can exist then). */
    private static void onServerThread(Runnable task) {
        MinecraftServer server = Platform.get().currentServer();
        if (server != null) server.execute(task);
    }

    /**
     * Registers silo N's own pieces, hands the registrations to the other silos through
     * {@code post} (the loader's event), then closes registration and installs the result.
     */
    public void setup(Consumer<AutosketchSetup> post) {
        AutosketchSetup setup = new AutosketchSetup(dispatcher);
        // Silo N's own pieces first, so work and context lead the wand's mode cycle.
        VolumeModes.Context contextMode = new VolumeModes.Context(volumes, players, feedback);
        setup.wandModes(new VolumeModes.Work(volumes, players, feedback));
        setup.wandModes(contextMode);
        setup.commands(new VolumeCommands(volumes, players, wand, contextMode, feedback, bridge, Autosketch::wandModes, Autosketch::patchStatus));
        setup.commands(new AirCommands(air));
        setup.messages().register("volumes.extend", (m, ex) -> {
            Messages.VolumesExtend req = Messages.VolumesExtend.decode(m.frame());
            volumes.extend(req.id(), req.link(), req.work());
            MinecraftServer server = Platform.get().currentServer();
            if (server != null)
                feedback.notice(server, null, "Autosketch: work volume extended to " + VolumeModes.size(req.work()) + " to include whole blocks");
        });
        setup.messages().register("volumes.set", (m, ex) -> {
            Messages.VolumesSet req = Messages.VolumesSet.decode(m.frame());
            volumes.setFromAgent(req.id(), req.dimension(), req.work(), req.context());
            MinecraftServer server = Platform.get().currentServer();
            if (server != null) feedback.notice(server, null, "Autosketch: the agent set the work volume to " + VolumeModes.size(req.work()));
        });
        setup.messages().register("notice", (m, ex) -> {
            Messages.Notice n = Messages.Notice.decode(m.frame());
            MinecraftServer server = Platform.get().currentServer();
            if (server != null) feedback.notice(server, n.player(), n.text());
        });
        post.accept(setup);
        setup.close();
        dispatcher.freeze();
        commands = List.copyOf(setup.commandExtensions());
        Autosketch.install(bridge, holder, setup.registeredPatchStatus(), setup.registeredWandModes());
        LOG.info("Autosketch: {} command extension(s), wand modes {}", commands.size(), setup.registeredWandModes().stream().map(m -> m.name()).toList());
    }

    public void registerCommands(CommandDispatcher<CommandSourceStack> dispatcher, CommandBuildContext context) {
        AutosketchCommand.register(dispatcher, context, commands);
    }

    public void serverStarted(MinecraftServer server) {
        AutosketchConfig.reload();
        players.clear();
        feedback.serverStarted();
        volumes.serverStarted(server);
        int port = AutosketchConfig.get().bridge.port;
        try {
            bridge.start(Platform.get().configDir(), port, new BridgeServer.Host() {
                @Override
                public Messages.ModHello hello() {
                    return modHello(server);
                }

                @Override
                public Frame volumes() {
                    return volumes.volumesFrame();
                }

                @Override
                public void protocolMismatch(int mcpProtocol) {
                    feedback.notice(server, null, BridgeServer.mismatchText(mcpProtocol));
                }
            });
        } catch (IOException e) {
            LOG.error("Autosketch bridge failed to start (port {})", port, e);
        }
        PointerFile.serverStarted(server, modVersion);
    }

    public void serverStopping() {
        bridge.stop();
        volumes.serverStopping();
    }

    /** End of a server tick: outlines and notices, and once a second a look at the config file. */
    public void tickEnd(MinecraftServer server) {
        feedback.tick(server);
        air.tick(server);
        if (server.getTickCount() % 20 == 0) AutosketchConfig.reloadIfChanged();
    }

    private Messages.ModHello modHello(MinecraftServer server) {
        GameProfile host = server.isDedicatedServer() ? null : server.getSingleplayerProfile();
        Platform platform = Platform.get();
        return new Messages.ModHello(modVersion, SharedConstants.getCurrentVersion().getName(), SharedConstants.getCurrentVersion().getDataVersion().getVersion(),
                platform.loader(), platform.loaderVersion(), !server.isDedicatedServer(),
                host == null || host.getId() == null ? null : new Messages.Player(host.getName(), host.getId()), FEATURES);
    }

    /** The protocol-2 features this build implements (13, *Versions and features*). */
    static final List<String> FEATURES = List.of(Messages.FEATURE_MODES, Messages.FEATURE_SCAN, Messages.FEATURE_VOLUMES_SET);
}
