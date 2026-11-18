package dev.autosketch.mod.client.ui.screen;

import com.google.gson.JsonObject;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import org.jetbrains.annotations.Nullable;

/**
 * The procedure editor (17, piece 6; {@code 13}'s {@code library.write.procedure}): the source as
 * plain text in one box that fills the form, saved whole. The MCP doesn't run or check it on save;
 * the next {@code run_procedure} reads the new file.
 */
public final class ProcedureEditorScreen extends EntryEditorScreen {
    ProcedureEditorScreen(@Nullable Screen parent, String root, String name) {
        super(parent, root, "procedures", name);
    }

    @Override
    protected void form(Pane p, JsonObject entry, int y) {
        put(p, area("text", p.w - 4, Math.max(40, p.h - y - 2), LogListScreen.str(entry, "text"), Component.empty()), 0, y);
    }

    @Override
    protected void submit() {
        String text = fieldValue("text", "");
        if (text.equals(LogListScreen.str(entry, "text"))) {
            say(tr("editor.unchanged"), DIM);
            return;
        }
        save(Requests.args("text", text), false);
    }
}
