package dev.autosketch.mod.gametest.client;

import dev.autosketch.mod.api.Autosketch;
import dev.autosketch.mod.bridge.PairingFile;
import java.io.IOException;
import java.lang.annotation.ElementType;
import java.lang.management.ManagementFactory;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.LoadingOverlay;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameRules;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.presets.WorldPresets;
import net.neoforged.api.distmarker.Dist;
import net.neoforged.fml.ModList;
import net.neoforged.fml.common.Mod;
import net.neoforged.fml.loading.FMLPaths;
import net.neoforged.neoforge.client.event.ClientChatReceivedEvent;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.client.event.RenderFrameEvent;
import net.neoforged.neoforge.common.NeoForge;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The client test driver (16, *Testing*, client half), after NeoForge's {@code SelfTestClient}: a
 * client tick listener that waits for the loading screen to go, then runs the selected suites and
 * writes a report, then calls {@code Minecraft.stop()}. Active only in the {@code clientTest} run (the
 * system property {@code autosketch.clienttest.suites} is set); in any other run, including the
 * ordinary dev client, it does nothing. Lives in the gametest source set, so it never ships in the jar.
 *
 * <p>Per run: the flat creative test world (cheats on) is opened by {@code --quickPlaySingleplayer}, or
 * created here when it doesn't exist yet. Per suite: the fake MCP starts with the suite's script and
 * the driver waits until the mod's bridge reports it connected; the suite's steps run one per tick; the
 * fake MCP stops and the driver waits for the disconnect. A wall-clock watchdog
 * ({@code autosketch.clienttest.timeout}, seconds, default 900) writes a failed report and halts the
 * game if the run hangs (a stuck world load, an error screen).
 *
 * <p>Report ({@code autosketch.clienttest.report}): one line per step, {@code PASS}/{@code FAIL}/
 * {@code SKIP}/{@code WARN}, the boot timings, and last {@code RESULT pass} or {@code RESULT fail}.
 * {@code mod/clienttest.sh} turns that into its exit code.
 */
@Mod(value = Autosketch.MOD_ID, dist = Dist.CLIENT)
public final class ClientTestDriver {
    private static final Logger LOG = LoggerFactory.getLogger("autosketch clienttest");
    private static ClientTestDriver instance;

    private enum Phase { BOOT, WORLD, MCP_START, MCP_WAIT, STEPS, MCP_STOP, DONE }

    private final String worldName = System.getProperty("autosketch.clienttest.world", "autosketch-clienttest");
    private final Path reportPath;
    private final Path repo;
    private final List<String> report = new ArrayList<>();
    private final List<ClientTestSuite> suites = new ArrayList<>();
    private boolean failed;
    private Phase phase = Phase.BOOT;
    private int suiteIndex;
    private ClientTestSuite suite;
    private int stepIndex;
    private boolean stepStarted;
    private long tick, stepStartTick, phaseStartTick;
    private String lastDetail;
    private final Set<String> failedTests = new LinkedHashSet<>();
    private boolean worldRequested;
    private final long jvmStart = ManagementFactory.getRuntimeMXBean().getStartTime();

    public ClientTestDriver() {
        String selected = System.getProperty("autosketch.clienttest.suites");
        reportPath = Path.of(System.getProperty("autosketch.clienttest.report", "clienttest-report.txt"));
        repo = Path.of(System.getProperty("autosketch.clienttest.repo", "."));
        if (selected == null) return;
        instance = this;
        startWatchdog();
        // Before the first screen is chosen: no accessibility onboarding screen, no pause when the
        // headless window has no focus. (Options with update callbacks wait for the loading screen.)
        var options = Minecraft.getInstance().options;
        options.onboardAccessibility = false;
        options.pauseOnLostFocus = false;
        try {
            Files.deleteIfExists(reportPath);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        findSuites(selected);
        NeoForge.EVENT_BUS.addListener(this::tick);
        NeoForge.EVENT_BUS.addListener((RenderFrameEvent.Post e) -> {
            if (suite != null) suite.frames++;
        });
        NeoForge.EVENT_BUS.addListener((ClientChatReceivedEvent.System e) -> {
            if (suite != null) suite.message(e.getMessage().getString(), e.isOverlay());
        });
    }

    static Path gameDir() {
        return FMLPaths.GAMEDIR.get();
    }

    static void warn(ClientTestSuite s, String message) {
        if (instance != null) instance.line("WARN " + s.name() + ": " + message);
    }

    // ── suites ────────────────────────────────────────────────────────────────────────────────

    /** Finds every {@link ClientTest} method through the mod's scan data and builds the selected suites. */
    private void findSuites(String selected) {
        Set<String> classes = new java.util.TreeSet<>();
        ModList.get().getAllScanData().forEach(data -> data.getAnnotatedBy(ClientTest.class, ElementType.METHOD)
                .forEach(a -> classes.add(a.clazz().getClassName())));
        Map<String, List<Method>> bySuite = new TreeMap<>();
        for (String name : classes) {
            try {
                Class<?> c = Class.forName(name);
                Method[] methods = c.getMethods();
                Arrays.sort(methods, Comparator.comparing(Method::getName));
                for (Method m : methods) {
                    ClientTest t = m.getAnnotation(ClientTest.class);
                    if (t == null) continue;
                    if (!Modifier.isStatic(m.getModifiers()) || m.getParameterCount() != 1 || m.getParameterTypes()[0] != ClientTestSuite.class)
                        throw new IllegalStateException("@ClientTest " + name + "." + m.getName() + " must be public static void (ClientTestSuite)");
                    bySuite.computeIfAbsent(t.value(), k -> new ArrayList<>()).add(m);
                }
            } catch (ClassNotFoundException e) {
                throw new IllegalStateException(e);
            }
        }
        List<String> names = selected.isBlank() || selected.equals("all") ? List.copyOf(bySuite.keySet()) : Arrays.stream(selected.split(",")).map(String::trim).toList();
        for (String n : names) {
            List<Method> methods = bySuite.get(n);
            if (methods == null) {
                line("FAIL " + n + ": no such suite (known: " + String.join(", ", bySuite.keySet()) + ")");
                failed = true;
                continue;
            }
            ClientTestSuite s = new ClientTestSuite(n);
            for (Method m : methods) {
                s.beginTest(m.getDeclaringClass().getSimpleName() + "." + m.getName());
                try {
                    m.invoke(null, s);
                } catch (ReflectiveOperationException e) {
                    throw new IllegalStateException("building client test " + m, e);
                }
            }
            suites.add(s);
        }
        if (suites.isEmpty() && !failed) {
            line("FAIL no client test suites found");
            failed = true;
        }
    }

    // ── the tick state machine ────────────────────────────────────────────────────────────────

    private void tick(ClientTickEvent.Post e) {
        tick++;
        Minecraft mc = Minecraft.getInstance();
        try {
            switch (phase) {
                case BOOT -> {
                    if (mc.getOverlay() instanceof LoadingOverlay || !mc.isRunning()) return;
                    timing("loading screen gone");
                    // A short view distance and no sound, for software rendering.
                    mc.options.renderDistance().set(4);
                    mc.options.simulationDistance().set(5);
                    mc.options.getSoundSourceOptionInstance(net.minecraft.sounds.SoundSource.MASTER).set(0.0);
                    phase = Phase.WORLD;
                    phaseStartTick = tick;
                }
                case WORLD -> world(mc);
                case MCP_START -> {
                    Path pairing = FMLPaths.CONFIGDIR.get().resolve(PairingFile.NAME);
                    if (!Files.isRegularFile(pairing)) return;
                    suite.mcp = FakeMcp.start(suite.name(), ClientTestSuite.script(suite.name()), pairing, gameDir().resolve("logs"), repo);
                    line("INFO " + suite.name() + ": fake MCP " + (suite.mcp.usingCli() ? "test/support/fake-mcp.ts" : "in-process placeholder"));
                    phase = Phase.MCP_WAIT;
                    phaseStartTick = tick;
                }
                case MCP_WAIT -> {
                    if (Autosketch.bridge().connected()) {
                        if (suiteIndex == 0) timing("fake MCP connected");
                        phase = Phase.STEPS;
                        stepIndex = 0;
                        stepStarted = false;
                        suite.clearMessages();
                    } else if (tick - phaseStartTick > 20 * 60) {
                        fail(suite.name() + ": the fake MCP did not connect within 60 s (alive: " + suite.mcp.alive() + "; see logs/fake-mcp-" + suite.name() + ".log)");
                        stopSuite();
                    }
                }
                case STEPS -> step();
                case MCP_STOP -> {
                    if (!Autosketch.bridge().connected() || tick - phaseStartTick > 20 * 10) nextSuite();
                }
                case DONE -> {
                }
            }
        } catch (Throwable t) {
            LOG.error("client test driver", t);
            fail("driver error in phase " + phase + ": " + t);
            finish();
        }
    }

    /** Opens the test world, creating it (flat, creative, cheats on) when it doesn't exist. */
    private void world(Minecraft mc) {
        if (mc.player != null && mc.level != null && mc.screen == null && mc.getSingleplayerServer() != null) {
            if (!mc.levelRenderer.hasRenderedAllSections() && tick - phaseStartTick < 20 * 60) return;
            timing("world ready");
            phase = Phase.MCP_START;
            suiteIndex = 0;
            suite = suites.isEmpty() ? null : suites.get(0);
            if (suite == null) finish();
            else line("SUITE " + suite.name());
            return;
        }
        if (worldRequested || mc.level != null) return;
        if (!mc.getLevelSource().levelExists(worldName)) {
            worldRequested = true;
            line("INFO creating the test world " + worldName);
            GameRules rules = new GameRules();
            rules.getRule(GameRules.RULE_DAYLIGHT).set(false, null);
            rules.getRule(GameRules.RULE_WEATHER_CYCLE).set(false, null);
            rules.getRule(GameRules.RULE_DOMOBSPAWNING).set(false, null);
            LevelSettings settings = new LevelSettings(worldName, GameType.CREATIVE, false, Difficulty.PEACEFUL, true, rules, WorldDataConfiguration.DEFAULT);
            mc.createWorldOpenFlows().createFreshLevel(worldName, settings, new WorldOptions(0L, false, false),
                    reg -> reg.registryOrThrow(Registries.WORLD_PRESET).getHolderOrThrow(WorldPresets.FLAT).value().createWorldDimensions(), new TitleScreen());
        } else if (mc.screen instanceof TitleScreen || mc.screen instanceof net.minecraft.client.gui.screens.DisconnectedScreen) {
            // Quick play didn't run (or ran before the world existed): open it ourselves.
            worldRequested = true;
            mc.createWorldOpenFlows().openWorld(worldName, () -> mc.setScreen(new TitleScreen()));
        }
    }

    private void step() {
        List<ClientTestSuite.Step> steps = suite.steps();
        while (stepIndex < steps.size() && failedTests.contains(steps.get(stepIndex).test()) && !steps.get(stepIndex).cleanup()) {
            ClientTestSuite.Step s = steps.get(stepIndex++);
            line("SKIP " + label(s));
        }
        if (stepIndex >= steps.size()) {
            stopSuite();
            return;
        }
        ClientTestSuite.Step s = steps.get(stepIndex);
        if (!stepStarted) {
            if (suiteIndex == 0 && stepIndex == 0) timing("first step");
            stepStarted = true;
            stepStartTick = tick;
            lastDetail = null;
            if (s.start() != null) {
                try {
                    s.start().run();
                } catch (Throwable t) {
                    stepFailed(s, describe(t));
                    return;
                }
            }
        }
        boolean done;
        try {
            done = s.condition().test();
        } catch (Throwable t) {
            if (s.action()) {
                stepFailed(s, describe(t));
                return;
            }
            lastDetail = describe(t);
            done = false;
        }
        if (done) {
            line("PASS " + label(s) + " (" + (tick - stepStartTick) + " ticks)");
            stepIndex++;
            stepStarted = false;
        } else if (tick - stepStartTick >= s.timeoutTicks()) {
            stepFailed(s, "timed out after " + s.timeoutTicks() + " ticks" + (lastDetail == null ? "" : ": " + lastDetail));
        }
    }

    private void stepFailed(ClientTestSuite.Step s, String why) {
        fail(label(s) + ": " + why);
        failedTests.add(s.test());
        stepIndex++;
        stepStarted = false;
    }

    private String label(ClientTestSuite.Step s) {
        return suite.name() + "/" + s.test() + ": " + s.name();
    }

    private static String describe(Throwable t) {
        if (t instanceof ClientTestSuite.Failure) return t.getMessage();
        if (t instanceof java.lang.reflect.InvocationTargetException ite && ite.getCause() != null) t = ite.getCause();
        if (t instanceof java.util.concurrent.ExecutionException ee && ee.getCause() != null) t = ee.getCause();
        return t instanceof ClientTestSuite.Failure ? t.getMessage() : t.toString();
    }

    private void stopSuite() {
        if (suite.mcp != null) suite.mcp.close();
        phase = Phase.MCP_STOP;
        phaseStartTick = tick;
    }

    private void nextSuite() {
        suiteIndex++;
        failedTests.clear();
        if (suiteIndex >= suites.size()) {
            finish();
            return;
        }
        suite = suites.get(suiteIndex);
        line("SUITE " + suite.name());
        phase = Phase.MCP_START;
    }

    // ── report ────────────────────────────────────────────────────────────────────────────────

    private void timing(String what) {
        double s = (System.currentTimeMillis() - jvmStart) / 1000.0;
        line(String.format("TIME %s at %.1f s after JVM start", what, s));
    }

    private synchronized void line(String l) {
        LOG.info(l);
        report.add(l);
    }

    private synchronized void fail(String message) {
        failed = true;
        line("FAIL " + message);
    }

    private synchronized void writeReport(String result) {
        List<String> out = new ArrayList<>(report);
        out.add("RENDERER " + safeRenderer());
        out.add("RESULT " + result);
        try {
            Files.createDirectories(reportPath.toAbsolutePath().getParent());
            Files.write(reportPath, out);
        } catch (IOException e) {
            LOG.error("writing the client test report", e);
        }
    }

    private static String safeRenderer() {
        try {
            return ClientTestSuite.renderer();
        } catch (Throwable t) {
            return "unknown";
        }
    }

    private void finish() {
        if (phase == Phase.DONE) return;
        phase = Phase.DONE;
        if (suite != null && suite.mcp != null) suite.mcp.close();
        writeReport(failed ? "fail" : "pass");
        LOG.info("client tests finished: {}", failed ? "fail" : "pass");
        Minecraft.getInstance().stop();
    }

    private void startWatchdog() {
        long seconds = Long.getLong("autosketch.clienttest.timeout", 900);
        Thread t = new Thread(() -> {
            try {
                Thread.sleep(seconds * 1000);
            } catch (InterruptedException e) {
                return;
            }
            if (phase == Phase.DONE) return;
            Minecraft mc = Minecraft.getInstance();
            fail("watchdog: still running after " + seconds + " s, in phase " + phase + (suite != null && phase == Phase.STEPS && stepIndex < suite.steps().size() ? " at " + label(suite.steps().get(stepIndex)) : "")
                    + " (screen: " + (mc.screen == null ? "none" : mc.screen.getClass().getName()) + ")");
            writeReport("fail");
            if (suite != null && suite.mcp != null) suite.mcp.close();
            Runtime.getRuntime().halt(1);
        }, "client test watchdog");
        t.setDaemon(true);
        t.start();
    }
}
