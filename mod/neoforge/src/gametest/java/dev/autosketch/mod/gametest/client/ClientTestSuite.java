package dev.autosketch.mod.gametest.client;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.platform.GlUtil;
import com.mojang.blaze3d.platform.NativeImage;
import dev.autosketch.mod.volume.Wand;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Function;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.client.Screenshot;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.events.GuiEventListener;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.neoforged.neoforge.client.ClientHooks;

/**
 * One client test suite (16, *Testing*, client half): the steps of its {@link ClientTest} methods,
 * run in order by {@link ClientTestDriver} on the client thread, one step per client tick, after the
 * world is loaded and the suite's fake MCP is connected. A test method only <em>adds</em> steps; the
 * lambdas run later, each in its own tick.
 *
 * <ul>
 * <li>{@link #step} runs an action once; an exception fails it.</li>
 * <li>{@link #waitUntil} polls a condition every tick until it holds, and fails the step with its name
 * (and the last {@link #check} message) after {@code timeoutTicks}. Never wait a fixed number of
 * ticks: wait for the state you need ({@link #waitFrames} only for "a frame has been drawn since").</li>
 * <li>{@link #cleanup} runs even when an earlier step of the same test failed.</li>
 * </ul>
 *
 * <p>A failed step skips the rest of its test (except cleanups); the next test runs. Inside steps, the
 * helpers drive input through the game's own paths: {@link #click}/{@link #hold} through
 * {@code KeyMapping} (a left click into the air reaches {@code CommonHooks.onEmptyLeftClick}),
 * {@link #scroll} through {@code ClientHooks.onMouseScroll}, {@link #command} as a chat command, and
 * {@link #onServer} reads the integrated server's state on its own thread.
 */
public final class ClientTestSuite {
    /** An action of a step; may throw. */
    @FunctionalInterface
    public interface Action {
        void run() throws Exception;
    }

    /** A condition of a wait; may throw (a {@link #check} failure is "not yet", with its message). */
    @FunctionalInterface
    public interface Condition {
        boolean test() throws Exception;
    }

    /** A failed {@link #check}. */
    public static final class Failure extends RuntimeException {
        public Failure(String message) {
            super(message);
        }
    }

    record Step(String test, String name, Action start, Condition condition, int timeoutTicks, boolean action, boolean cleanup) {}

    private final String name;
    private final List<Step> steps = new ArrayList<>();
    private String test = "";
    private final List<String> actionBar = new ArrayList<>(), chat = new ArrayList<>();
    private final List<net.minecraft.network.chat.Component> chatComponents = new ArrayList<>();
    FakeMcp mcp;
    long frames;

    ClientTestSuite(String name) {
        this.name = name;
    }

    public String name() {
        return name;
    }

    /** Starts a test's steps: every test begins with the hand {@link #awayFromTheWand away from the wand}. */
    void beginTest(String test) {
        this.test = test;
        awayFromTheWand();
    }

    /**
     * Steps every test starts with: select a hotbar slot that doesn't hold the wand and wait until the
     * server sees it. The test world (and the player's inventory) persists across tests and runs, and
     * a test that put the wand in hand (the air-mode tests) leaves it there; while it is held, the
     * server shows the wand's mode line ({@code Autosketch wand: work mode}) on the action bar every
     * second (Feedback), overwriting the client half's own lines that steps wait for, and draws the
     * wand's outlines. A test that needs the wand puts it in hand itself.
     */
    private void awayFromTheWand() {
        step("a hotbar slot without the wand", () -> {
            for (int i = 8; i >= 0; i--)
                if (!Wand.isWand(player().getInventory().getItem(i))) {
                    player().getInventory().selected = i;
                    return;
                }
            command("item replace entity @s hotbar.8 with minecraft:air");
            player().getInventory().selected = 8;
        });
        waitUntil("the server sees no wand in hand", () -> onServer(server -> !Wand.isWand(serverPlayer(server).getMainHandItem())), 100);
    }

    List<Step> steps() {
        return steps;
    }

    // ── building steps ────────────────────────────────────────────────────────────────────────

    /** A step that runs {@code action} once. */
    public void step(String name, Action action) {
        steps.add(new Step(test, name, null, () -> {
            action.run();
            return true;
        }, 1, true, false));
    }

    /** A step that waits until {@code condition} holds, failing after {@code timeoutTicks} client ticks. */
    public void waitUntil(String name, Condition condition, int timeoutTicks) {
        steps.add(new Step(test, name, null, condition, timeoutTicks, false, false));
    }

    /** Like {@link #waitUntil}, running {@code start} once in the step's first tick (e.g. to take a mark). */
    public void waitUntil(String name, Action start, Condition condition, int timeoutTicks) {
        steps.add(new Step(test, name, start, condition, timeoutTicks, false, false));
    }

    /** Waits until {@code n} frames have been drawn after this step starts (so a state change is on screen). */
    public void waitFrames(String name, int n) {
        long[] mark = new long[1];
        waitUntil(name, () -> mark[0] = frames, () -> frames >= mark[0] + n, 20 * 60);
    }

    /** A step that runs even when an earlier step of this test failed (put it last). */
    public void cleanup(String name, Action action) {
        steps.add(new Step(test, name, null, () -> {
            action.run();
            return true;
        }, 1, true, true));
    }

    // ── helpers for use inside steps ──────────────────────────────────────────────────────────

    /** Fails the current step (or, in a wait, keeps waiting with this message) unless {@code ok}. */
    public static void check(boolean ok, String message) {
        if (!ok) throw new Failure(message);
    }

    /** A {@code WARN} line in the report (a skipped check, a missing tool); doesn't fail the suite. */
    public void warn(String message) {
        ClientTestDriver.warn(this, message);
    }

    public Minecraft mc() {
        return Minecraft.getInstance();
    }

    public LocalPlayer player() {
        return Minecraft.getInstance().player;
    }

    /** One press of a key mapping, as a real key or button press does (handled in the next tick). */
    public void click(KeyMapping key) {
        KeyMapping.click(key.getKey());
    }

    /** Holds or releases a key mapping (e.g. sneak), as a real key does. */
    public void hold(KeyMapping key, boolean down) {
        KeyMapping.set(key.getKey(), down);
    }

    /**
     * A mouse wheel turn ({@code delta} &gt; 0 away from the user), through the event the mouse handler
     * posts. True when a listener cancelled it (vanilla would otherwise scroll the hotbar).
     */
    public boolean scroll(double delta) {
        return ClientHooks.onMouseScroll(mc().mouseHandler, 0, delta);
    }

    /** Sends a command as the player typed it, without the slash ({@code "autosketch air on"}). */
    public void command(String command) {
        player().connection.sendCommand(command);
    }

    /** Runs {@code read} on the integrated server's thread and returns its result (waits up to 10 s). */
    public <T> T onServer(Function<MinecraftServer, T> read) throws Exception {
        MinecraftServer server = mc().getSingleplayerServer();
        check(server != null, "no integrated server");
        CompletableFuture<T> f = server.submit(() -> read.apply(server));
        return f.get(10, TimeUnit.SECONDS);
    }

    /** The server's copy of the local player; use only inside {@link #onServer}. */
    public ServerPlayer serverPlayer(MinecraftServer server) {
        return server.getPlayerList().getPlayer(player().getUUID());
    }

    /** Action-bar texts the server sent since the suite started or {@link #clearMessages()}, oldest first. */
    public List<String> actionBar() {
        synchronized (actionBar) {
            return List.copyOf(actionBar);
        }
    }

    /** Chat lines (system messages not on the action bar) since the suite started or {@link #clearMessages()}. */
    public List<String> chat() {
        synchronized (chat) {
            return List.copyOf(chat);
        }
    }

    /** True when an action-bar text since the last clear contains {@code text}. */
    /** The chat lines of {@link #chat()} as the components that arrived, styles (click events) included. */
    public List<net.minecraft.network.chat.Component> chatComponents() {
        synchronized (chat) {
            return List.copyOf(chatComponents);
        }
    }

    public boolean actionBarHas(String text) {
        return actionBar().stream().anyMatch(s -> s.contains(text));
    }

    public void clearMessages() {
        synchronized (actionBar) {
            actionBar.clear();
        }
        synchronized (chat) {
            chat.clear();
            chatComponents.clear();
        }
    }

    void message(net.minecraft.network.chat.Component message, boolean overlay) {
        List<String> list = overlay ? actionBar : chat;
        synchronized (list) {
            list.add(message.getString());
            if (!overlay) chatComponents.add(message);
        }
    }

    /** The suite's fake MCP (16, *Testing*): what it received since it last started. */
    public FakeMcp mcp() {
        return mcp;
    }

    /**
     * Stops the suite's fake MCP (if running) and starts a new one with {@code scriptJson} (the format
     * of {@code clienttest/<suite>.json}), e.g. one whose hello lacks {@code ui}. Its record starts
     * empty. The driver starts the suite's own script before the first step.
     */
    public void startMcp(String scriptJson) throws IOException {
        stopMcp();
        mcp = FakeMcp.start(name, scriptJson, ClientTestDriver.pairingFile(), ClientTestDriver.gameDir().resolve("logs"), ClientTestDriver.repo());
        ClientTestDriver.info(name + ": fake MCP started: " + scriptJson);
    }

    /** Stops the suite's fake MCP; the mod sees the connection close (wait on the link state). */
    public void stopMcp() {
        if (mcp != null) mcp.close();
    }

    /** The open screen's widget whose label is {@code label}, or a failed check. */
    public AbstractWidget widget(String label) {
        check(mc().screen != null, "no screen open");
        for (GuiEventListener l : mc().screen.children())
            if (l instanceof AbstractWidget w && w.getMessage().getString().equals(label)) return w;
        throw new Failure("no widget \"" + label + "\" on " + mc().screen.getClass().getSimpleName());
    }

    /** Clicks a widget of the open screen through the screen's own mouse handling (left button). */
    public void clickWidget(String label) {
        AbstractWidget w = widget(label);
        double x = w.getX() + w.getWidth() / 2.0, y = w.getY() + w.getHeight() / 2.0;
        mc().screen.mouseClicked(x, y, 0);
        if (mc().screen != null) mc().screen.mouseReleased(x, y, 0);
    }

    /** Sets the GUI hidden (F1), so screenshots show the world only. */
    public void hideGui(boolean hidden) {
        mc().options.hideGui = hidden;
    }

    // ── screenshots ───────────────────────────────────────────────────────────────────────────

    /** The renderer a reference image was taken with: pixel output differs between Mesa versions. */
    public static String renderer() {
        return GlUtil.getRenderer() + " | " + GlUtil.getOpenGLVersion();
    }

    /**
     * The last drawn frame, also written to {@code clienttest-screenshots/<suite>/<name>.png} in the game
     * directory (uploaded by CI on failure). The caller closes the image.
     */
    public NativeImage screenshot(String name) throws IOException {
        NativeImage img = Screenshot.takeScreenshot(mc().getMainRenderTarget());
        Path dir = ClientTestDriver.gameDir().resolve("clienttest-screenshots").resolve(this.name);
        Files.createDirectories(dir);
        img.writeToFile(dir.resolve(name + ".png"));
        Files.writeString(dir.resolve(name + ".renderer.txt"), renderer() + "\n");
        return img;
    }

    /**
     * Pixels whose colour differs between {@code a} and {@code b} by more than {@code channelTolerance}
     * (0–255) in any channel. Images of different sizes count every pixel.
     */
    public static long changedPixels(NativeImage a, NativeImage b, int channelTolerance) {
        if (a.getWidth() != b.getWidth() || a.getHeight() != b.getHeight()) return (long) Math.max(a.getWidth() * a.getHeight(), b.getWidth() * b.getHeight());
        long n = 0;
        for (int y = 0; y < a.getHeight(); y++)
            for (int x = 0; x < a.getWidth(); x++)
                if (differs(a.getPixelRGBA(x, y), b.getPixelRGBA(x, y), channelTolerance)) n++;
        return n;
    }

    private static boolean differs(int p, int q, int tol) {
        for (int shift = 0; shift < 24; shift += 8)
            if (Math.abs(((p >> shift) & 0xFF) - ((q >> shift) & 0xFF)) > tol) return true;
        return false;
    }

    /**
     * Compares a screenshot with the reference {@code clienttest/screenshots/<name>.png} on the gametest
     * classpath: at most {@code maxChangedFraction} of the pixels may differ by more than
     * {@code channelTolerance}. The reference's {@code <name>.renderer.txt} records the renderer it was
     * taken with; on another renderer (another Mesa version) the pixel check is skipped with a warning
     * in the report. Without a reference it is skipped too, and the screenshot written by
     * {@link #screenshot} is the candidate to copy into the resources.
     */
    public void assertMatchesReference(String name, NativeImage actual, int channelTolerance, double maxChangedFraction) throws IOException {
        String base = "/clienttest/screenshots/" + name;
        try (InputStream png = ClientTestSuite.class.getResourceAsStream(base + ".png");
                InputStream meta = ClientTestSuite.class.getResourceAsStream(base + ".renderer.txt")) {
            if (png == null) {
                ClientTestDriver.warn(this, "no reference screenshot " + base + ".png; pixel check skipped (candidate in clienttest-screenshots/" + this.name + ")");
                return;
            }
            String wanted = meta == null ? "" : new String(meta.readAllBytes(), StandardCharsets.UTF_8).trim();
            if (!wanted.equals(renderer())) {
                ClientTestDriver.warn(this, "reference " + name + " was taken with \"" + wanted + "\", this run uses \"" + renderer() + "\"; pixel check skipped");
                return;
            }
            try (NativeImage ref = NativeImage.read(png)) {
                long changed = changedPixels(ref, actual, channelTolerance);
                double fraction = changed / (double) (ref.getWidth() * ref.getHeight());
                check(fraction <= maxChangedFraction, String.format("screenshot %s differs from its reference in %.2f%% of pixels (allowed %.2f%%)", name, fraction * 100, maxChangedFraction * 100));
            }
        }
    }

    /** The suite's fake MCP script ({@code clienttest/<suite>.json}), or the defaults ({@code {}}). */
    static String script(String suite) {
        try (InputStream in = ClientTestSuite.class.getResourceAsStream("/clienttest/" + suite + ".json")) {
            if (in == null) return "{}";
            String text = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            JsonObject checked = JsonParser.parseString(text).getAsJsonObject();
            return checked.toString();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Waits on a plain boolean (convenience for {@link #waitUntil}). */
    public static Condition of(BooleanSupplier b) {
        return b::getAsBoolean;
    }
}
