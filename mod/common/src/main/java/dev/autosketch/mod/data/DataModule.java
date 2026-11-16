package dev.autosketch.mod.data;

import com.mojang.logging.LogUtils;
import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.api.AutosketchSetup;
import dev.autosketch.mod.discovery.PointerFile;
import dev.autosketch.mod.protocol.ErrorCodes;
import dev.autosketch.mod.protocol.Messages;
import java.io.IOException;
import java.nio.file.Path;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import net.minecraft.server.MinecraftServer;
import org.jetbrains.annotations.Nullable;
import org.slf4j.Logger;

/**
 * Version-specific data from the running game (14, *Version-specific data lives in the mod*): the
 * registry report, written beside the pointer file at server start and served by the {@code registry}
 * request, and the {@code upgrade} request through the game's data fixer. Both requests run off the
 * server thread (the registries are frozen, and the data fixer is what world upgrades run on worker
 * threads), and answer in arrival order like every request.
 */
public final class DataModule {
    private DataModule() {}

    private static final Logger LOG = LogUtils.getLogger();
    private static final ExecutorService WORKER = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "Autosketch data");
        t.setDaemon(true);
        return t;
    });

    private static volatile @Nullable RegistryReport report;

    /** Registers the {@code registry} and {@code upgrade} handlers (their presence puts the features in the hello). */
    public static void setup(AutosketchSetup setup) {
        setup.messages().register(Messages.FEATURE_REGISTRY, (m, ex) -> {
            Messages.RegistryRequest req = Messages.RegistryRequest.decode(m.frame());
            ex.defer();
            CompletableFuture.supplyAsync(DataModule::report, WORKER).whenComplete((r, e) -> {
                if (e != null) ex.error(ErrorCodes.INTERNAL, "couldn't build the registry report: " + e);
                else ex.reply(new Messages.RegistryResult(req.id(), r.hash(), r.dataVersion(), req.have() != null && req.have() == r.hash() ? null : r.gzip()).encode());
            });
        });
        setup.messages().register(Messages.FEATURE_UPGRADE, (m, ex) -> {
            Messages.UpgradeRequest req = Messages.UpgradeRequest.decode(m.frame());
            ex.defer();
            long t0 = System.nanoTime();
            CompletableFuture.supplyAsync(() -> Upgrades.upgrade(req.from(), req.data()), WORKER).whenComplete((r, e) -> {
                long ms = (System.nanoTime() - t0) / 1_000_000;
                if (ms > 1000) LOG.info("Autosketch: upgrade from DataVersion {} took {} ms", req.from(), ms);
                if (e != null) ex.error(ErrorCodes.INTERNAL, "the data fixer failed: " + e);
                else ex.reply(new Messages.UpgradeResult(req.id(), r.to(), r.failed(), r.data()).encode());
            });
        });
    }

    /** The report of this server's run, built on first use. */
    public static RegistryReport report() {
        RegistryReport r = report;
        if (r == null) {
            synchronized (DataModule.class) {
                if ((r = report) == null) report = r = RegistryReport.build();
            }
        }
        return r;
    }

    /**
     * On server start: builds the report (the modset and data packs may differ from the last run) and
     * writes it beside the pointer file, off the server thread. Not written when the pointer is turned
     * off, and that game's old report is removed with its pointer ({@link PointerFile}).
     */
    public static void serverStarted(MinecraftServer server) {
        report = null;
        if (!AutosketchConfig.get().discovery.pointer) return;
        Path file = PointerFile.gamesDir().resolve(PointerFile.hash(PointerFile.gameDirText(server.getServerDirectory())) + PointerFile.REPORT_SUFFIX);
        WORKER.execute(() -> {
            try {
                long t0 = System.nanoTime();
                RegistryReport r = report();
                r.write(file);
                LOG.info("Autosketch: registry report {} ({} blocks, {} KB, {} KB unpacked, {} ms)", file, r.blockCount(), r.gzip().length / 1024, r.json().length / 1024,
                        (System.nanoTime() - t0) / 1_000_000);
            } catch (IOException | RuntimeException e) {
                LOG.warn("Autosketch: couldn't write the registry report: {}", e.toString());
            }
        });
    }

    /** Server stop: the next run builds its own. */
    public static void serverStopped() {
        report = null;
    }
}
