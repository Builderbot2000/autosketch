package dev.autosketch.mod.client.ui;

import com.mojang.blaze3d.platform.InputConstants;
import dev.autosketch.mod.link.Link;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.BooleanSupplier;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.network.chat.Component;
import net.neoforged.neoforge.client.event.ClientTickEvent;
import net.neoforged.neoforge.client.event.RegisterKeyMappingsEvent;
import net.neoforged.neoforge.client.settings.IKeyConflictContext;
import net.neoforged.neoforge.client.settings.KeyConflictContext;
import org.lwjgl.glfw.GLFW;

/**
 * Every key mapping of the in-game UI, declared once (16, *Autosketch menu and key bindings*): their
 * own category, one default key ({@code Home}, the menu), the toggles and screens unbound, and the
 * replay keys active only while a replay is open ({@link #REPLAY}, so they never conflict with
 * anything else). Silos never add mappings elsewhere: they attach actions here with {@link #on},
 * one block per silo (S the menu and screens, O and G the toggles, R the replay keys). Actions run on
 * the client tick, once per press, and only while {@link LinkState} is connected; otherwise a press
 * shows the lock's action-bar line (silo L) and does nothing.
 *
 * <p>1.21.x: {@code KeyMapping}'s NeoForge constructor with an {@code IKeyConflictContext} and
 * {@code RegisterKeyMappingsEvent} are where a port looks first.
 */
public final class AutosketchKeys {
    private AutosketchKeys() {}

    public static final String CATEGORY = "key.categories.autosketch";

    private static volatile BooleanSupplier replayOpen = () -> false;

    /** Active only while a replay is open (R sets the condition with {@link #setReplayOpen}). */
    public static final IKeyConflictContext REPLAY = new IKeyConflictContext() {
        @Override
        public boolean isActive() {
            return replayOpen.getAsBoolean();
        }

        @Override
        public boolean conflicts(IKeyConflictContext other) {
            return this == other;
        }
    };

    private static final List<KeyMapping> ALL = new ArrayList<>();

    private static KeyMapping key(String name, IKeyConflictContext context, int key) {
        KeyMapping k = new KeyMapping("key.autosketch." + name, context, InputConstants.Type.KEYSYM, key, CATEGORY);
        ALL.add(k);
        return k;
    }

    private static final int UNBOUND = InputConstants.UNKNOWN.getValue();

    public static final KeyMapping OPEN_MENU = key("open_menu", KeyConflictContext.IN_GAME, GLFW.GLFW_KEY_HOME);
    public static final KeyMapping TOGGLE_HUD = key("toggle_hud", KeyConflictContext.IN_GAME, UNBOUND);
    public static final KeyMapping TOGGLE_VOLUMES = key("toggle_volumes", KeyConflictContext.IN_GAME, UNBOUND);
    public static final KeyMapping TOGGLE_FLASHES = key("toggle_flashes", KeyConflictContext.IN_GAME, UNBOUND);
    public static final KeyMapping TOGGLE_GHOSTS = key("toggle_ghosts", KeyConflictContext.IN_GAME, UNBOUND);
    public static final KeyMapping OPEN_SETTINGS = key("open_settings", KeyConflictContext.IN_GAME, UNBOUND);
    public static final KeyMapping OPEN_LIBRARY = key("open_library", KeyConflictContext.IN_GAME, UNBOUND);
    public static final KeyMapping OPEN_REPLAY = key("open_replay", KeyConflictContext.IN_GAME, UNBOUND);
    public static final KeyMapping REPLAY_BACK = key("replay_back", REPLAY, GLFW.GLFW_KEY_LEFT);
    public static final KeyMapping REPLAY_FORWARD = key("replay_forward", REPLAY, GLFW.GLFW_KEY_RIGHT);
    public static final KeyMapping REPLAY_PLAY = key("replay_play", REPLAY, GLFW.GLFW_KEY_SPACE);
    public static final KeyMapping REPLAY_SLOWER = key("replay_slower", REPLAY, GLFW.GLFW_KEY_DOWN);
    public static final KeyMapping REPLAY_FASTER = key("replay_faster", REPLAY, GLFW.GLFW_KEY_UP);
    public static final KeyMapping REPLAY_PREVIOUS_MARKER = key("replay_previous_marker", REPLAY, GLFW.GLFW_KEY_PAGE_UP);
    public static final KeyMapping REPLAY_NEXT_MARKER = key("replay_next_marker", REPLAY, GLFW.GLFW_KEY_PAGE_DOWN);
    public static final KeyMapping REPLAY_CLOSE = key("replay_close", REPLAY, GLFW.GLFW_KEY_BACKSPACE);

    private static final Map<KeyMapping, List<Runnable>> actions = new ConcurrentHashMap<>();

    /** Every mapping, in declaration order. */
    public static List<KeyMapping> all() {
        return List.copyOf(ALL);
    }

    /** Attaches an action to a mapping (the owning silo's block). */
    public static void on(KeyMapping key, Runnable action) {
        actions.computeIfAbsent(key, k -> new CopyOnWriteArrayList<>()).add(action);
    }

    /** Tells the replay keys when a replay is open (silo R). */
    public static void setReplayOpen(BooleanSupplier open) {
        replayOpen = open;
    }

    static void register(RegisterKeyMappingsEvent e) {
        for (KeyMapping k : ALL) e.register(k);
    }

    static void tick(ClientTickEvent.Post e) {
        for (KeyMapping k : ALL) {
            while (k.consumeClick()) {
                if (!LinkState.connected()) {
                    lockLine();
                    continue;
                }
                for (Runnable r : actions.getOrDefault(k, List.of())) r.run();
            }
        }
    }

    private static void lockLine() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return;
        String line = LinkState.get() == LinkState.State.TOO_OLD ? Link.TOO_OLD_LINE : Link.OFFLINE_LINE;
        mc.player.displayClientMessage(Component.literal(line), true);
    }

    // ── S: the menu and the screens (16, *Autosketch menu and key bindings*) ──────────────────
    // Last in the class, so every mapping and the action map exist when it runs.
    static {
        dev.autosketch.mod.client.ui.screen.AutosketchScreens.attachKeys();
    }
}
