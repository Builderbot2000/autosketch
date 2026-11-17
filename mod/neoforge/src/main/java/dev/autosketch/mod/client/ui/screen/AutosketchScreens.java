package dev.autosketch.mod.client.ui.screen;

import com.google.gson.JsonArray;
import dev.autosketch.mod.client.ui.AutosketchKeys;
import dev.autosketch.mod.client.ui.LinkState;
import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;

/**
 * Silo S's entry points (16, *Autosketch menu and key bindings*): attaches the menu key ({@code Home})
 * and the unbound open-settings, open-library and open-replay keys to their screens, and holds the
 * menu's two actions that aren't screens of their own: Ghost here ({@code ghost.anchor}) and Replay,
 * which opens the log list ({@link LogListScreen}) unless the replay feature installs its own opener
 * ({@link #setReplayOpener}). {@link AutosketchKeys} only runs these while {@link LinkState} is
 * connected; otherwise a press shows the lock's line.
 */
public final class AutosketchScreens {
    private AutosketchScreens() {}

    private static boolean attached;
    private static @Nullable Consumer<@Nullable Screen> replayOpener;

    /** Called once from {@link AutosketchKeys} (S's block there). */
    public static void attachKeys() {
        if (attached) return;
        attached = true;
        AutosketchKeys.on(AutosketchKeys.OPEN_MENU, () -> open(new MenuScreen(null)));
        AutosketchKeys.on(AutosketchKeys.OPEN_SETTINGS, () -> open(new SettingsScreen(null)));
        AutosketchKeys.on(AutosketchKeys.OPEN_LIBRARY, () -> open(new LibraryScreen(null)));
        AutosketchKeys.on(AutosketchKeys.OPEN_REPLAY, () -> openReplay(null));
        LinkState.addListener(s -> {
            if (s != LinkState.State.CONNECTED) Requests.reset();
        });
    }

    private static void open(Screen s) {
        Minecraft mc = Minecraft.getInstance();
        if (mc.screen == null) mc.setScreen(s);
    }

    /**
     * Lets the replay feature (silo R) replace what the Replay button and the open-replay key open:
     * it gets the screen to return to ({@code null} from the key). Without one, the log list opens.
     */
    public static void setReplayOpener(@Nullable Consumer<@Nullable Screen> opener) {
        replayOpener = opener;
    }

    static void openReplay(@Nullable Screen parent) {
        Consumer<@Nullable Screen> o = replayOpener;
        if (o != null) o.accept(parent);
        else Minecraft.getInstance().setScreen(new LogListScreen(parent));
    }

    /** Ghost here: anchors the open unlinked document's ghost at the player's feet. */
    static void ghostHere() {
        Minecraft mc = Minecraft.getInstance();
        if (mc.player == null) return;
        BlockPos pos = mc.player.blockPosition();
        JsonArray p = new JsonArray();
        p.add(pos.getX());
        p.add(pos.getY());
        p.add(pos.getZ());
        mc.setScreen(null);
        Requests.send("ghost.anchor", Requests.args("dimension", mc.player.level().dimension().location().toString(), "pos", p), r -> {
            if (mc.player == null) return;
            Component line = r.ok() ? PaneScreen.tr("menu.ghost_placed", r.result().has("ghost") ? r.result().get("ghost").getAsString() : "")
                    : Component.literal("Autosketch: " + r.message());
            mc.player.displayClientMessage(line, true);
        });
    }
}
