package dev.autosketch.mod.client.ui.screen;

import net.minecraft.client.gui.screens.Screen;
import org.jetbrains.annotations.Nullable;

/** The settings screen (16); laid out in the next commit. */
public final class SettingsScreen extends PaneScreen {
    public SettingsScreen(@Nullable Screen parent) {
        super(tr("settings.title"), parent);
    }

    @Override
    protected void layout() {}
}
