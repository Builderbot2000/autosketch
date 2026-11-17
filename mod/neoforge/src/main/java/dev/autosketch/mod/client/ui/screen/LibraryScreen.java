package dev.autosketch.mod.client.ui.screen;

import net.minecraft.client.gui.screens.Screen;
import org.jetbrains.annotations.Nullable;

/** The library screen (16); laid out in the next commit. */
public final class LibraryScreen extends PaneScreen {
    public LibraryScreen(@Nullable Screen parent) {
        super(tr("library.title"), parent);
    }

    @Override
    protected void layout() {}
}
