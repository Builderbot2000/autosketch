package dev.autosketch.mod.client.ui.screen;

import dev.autosketch.mod.AutosketchConfig;
import dev.autosketch.mod.client.ui.UiToggles;
import com.mojang.logging.LogUtils;
import me.shedaniel.autoconfig.AutoConfig;
import net.minecraft.client.gui.GuiGraphics;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;

/**
 * The Autosketch menu (16, *Autosketch menu and key bindings*), on {@code Home}: the four toggles
 * (HUD, job volumes, change flashes, ghosts, writing {@link UiToggles}) and the entry points:
 * Settings, Library, Replay (the log list), Ghost here, and the mod's own config screen (Cloth
 * Config), which stays separate from the MCP's settings.
 */
public final class MenuScreen extends PaneScreen {
    public MenuScreen(@Nullable Screen parent) {
        super(tr("menu.title"), parent);
    }

    @Override
    protected void layout() {
        int w = 150, x = width / 2 - w - 2, x2 = width / 2 + 2, y = Math.max(28, height / 2 - 70);
        addRenderableWidget(toggle("menu.hud", UiToggles.hud, UiToggles::toggleHud).bounds(x, y, w, 20).build());
        addRenderableWidget(toggle("menu.volumes", UiToggles.volumes, UiToggles::toggleVolumes).bounds(x2, y, w, 20).build());
        addRenderableWidget(toggle("menu.flashes", UiToggles.flashes, UiToggles::toggleFlashes).bounds(x, y + 24, w, 20).build());
        addRenderableWidget(toggle("menu.ghosts", UiToggles.ghosts, UiToggles::toggleGhosts).bounds(x2, y + 24, w, 20).build());
        y += 56;
        addRenderableWidget(Button.builder(tr("menu.settings"), b -> minecraft.setScreen(new SettingsScreen(this))).bounds(x, y, w, 20).build());
        addRenderableWidget(Button.builder(tr("menu.library"), b -> minecraft.setScreen(new LibraryScreen(this))).bounds(x2, y, w, 20).build());
        addRenderableWidget(Button.builder(tr("menu.replay"), b -> AutosketchScreens.openReplay(this)).bounds(x, y + 24, w, 20).build());
        addRenderableWidget(Button.builder(tr("menu.ghost_here"), b -> AutosketchScreens.ghostHere()).bounds(x2, y + 24, w, 20).build());
        addRenderableWidget(Button.builder(tr("menu.mod_config"), b -> openModConfig()).bounds(x, y + 56, w, 20).build());
        addRenderableWidget(Button.builder(tr("done"), b -> onClose()).bounds(x2, y + 56, w, 20).build());
    }

    private @Nullable Component configError;

    /** The mod's Cloth Config screen; a failure to build it is shown on the menu, never thrown into input handling. */
    private void openModConfig() {
        try {
            minecraft.setScreen(AutoConfig.getConfigScreen(AutosketchConfig.class, this).get());
        } catch (RuntimeException e) {
            LogUtils.getLogger().warn("Autosketch: the mod's config screen failed to open", e);
            configError = tr("menu.mod_config_failed", e.getMessage() == null ? e.toString() : e.getMessage());
        }
    }

    private Button.Builder toggle(String key, boolean on, Runnable flip) {
        return Button.builder(tr(key, onOff(on)), b -> {
            flip.run();
            refresh();
        });
    }

    static Component onOff(boolean on) {
        return tr(on ? "on" : "off");
    }

    @Override
    public void render(GuiGraphics g, int mouseX, int mouseY, float partialTick) {
        super.render(g, mouseX, mouseY, partialTick);
        g.drawCenteredString(font, title, width / 2, Math.max(28, height / 2 - 70) - 16, TEXT);
        if (configError != null) g.drawCenteredString(font, configError, width / 2, Math.max(28, height / 2 - 70) + 136, BAD);
    }
}
